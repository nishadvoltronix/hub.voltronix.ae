import assert from "node:assert/strict";
import test from "node:test";
import type { MysqlAuthConfig } from "../src/db/mysql/config.js";
import type { MysqlAuthWireConnection } from "../src/db/mysql/driver.js";
import { mysqlMigrations } from "../src/db/mysql/migrations.js";
import { mysqlExpectedIndexes, mysqlExpectedTables, mysqlExpectedTriggers } from "../src/db/mysql/schema.js";
import { targetFor } from "../scripts/mysql-auth/guard.js";
import { verifyConnection, verifySchema } from "../scripts/mysql-auth/runner.js";

// OFFLINE wire metadata doubles. No SQL parser/server, records, sockets, browser,
// profiles or MySQL effects execute. Real privilege visibility remains NOT RUN.
const target = targetFor("00000000-0000-4000-8000-000000000011");
const serverUuid = "12345678-1234-1234-1234-123456789012";
type Row = Record<string, unknown>;
function inert(execute: MysqlAuthWireConnection["execute"]): MysqlAuthWireConnection {
  return { execute,
    async query() { assert.fail("Metadata verification must not issue query writes or session changes"); },
    async beginTransaction() { assert.fail("Metadata verification cannot begin a transaction"); },
    async commit() { assert.fail("Metadata verification cannot commit"); },
    async rollback() { assert.fail("Metadata verification cannot rollback"); },
    async end() {}, destroy() {},
  };
}
function identityFixture() {
  const config: Readonly<MysqlAuthConfig> = { provider: "mysql", environment: "test", host: "127.0.0.1", port: 3308,
    database: target.database, user: target.runtimeUser, password: "Synthetic-offline-only-profile" };
  const identity: Row = { selectedDatabase: config.database, identity: `${config.user}@127.0.0.1`, uuid: serverUuid,
    version: "8.4.11", port: 3308, activeRoles: "NONE" };
  const calls: {sql:string; values:readonly unknown[]}[] = [];
  const state: { result: unknown; failure: boolean } = { result: [identity], failure: false };
  const connection = inert(async (sql, values = []) => {
    calls.push({sql, values});
    if (state.failure) throw new Error("Synthetic private wire diagnostic");
    return [state.result, []];
  });
  return {config, identity, calls, state, connection};
}
function schemaFixture() {
  const calls: {side:"migration"|"operator";sql:string;values:readonly unknown[]}[] = [];
  const identity: Row = { selectedDatabase: target.database, serverVersion: "8.4.11", versionComment: "MySQL Community Server - GPL",
    autocommit: 1, port: 3308 };
  const tables: Row[] = ["crm_mysql_schema_migrations", ...mysqlExpectedTables].sort().map(name => ({name, type: "BASE TABLE", engine: "InnoDB"}));
  const indexes: Row[] = mysqlExpectedIndexes.flatMap(index => index.columns.map((columnName, position) => ({tableName: index.table,
    name: index.name, nonUnique: Number(!index.unique), position: position + 1, columnName})));
  const history: Row[] = mysqlMigrations.map(item => ({ version: item.version, name: item.name, checksum: item.checksum, state: "completed" }));
  const objectRows: Record<string, Row[]> = { TRIGGERS: mysqlExpectedTriggers.map(name => ({name})), ROUTINES: [], EVENTS: [] };
  const counts = new Map<string, unknown>(mysqlExpectedTables.map(table => [table, table === "crm_app_lock" ? "1" : "0"]));
  const state: {lock:unknown; countRows:unknown[]|null; failMigration:string; failOperator:string} = {
    lock: [{id: 1}], countRows: null, failMigration: "", failOperator: "" };
  const migration = inert(async (sql, values = []) => {
    calls.push({side: "migration", sql, values: [...values]});
    if (state.failMigration && sql.includes(state.failMigration)) throw new Error("Synthetic private metadata failure");
    if (sql.startsWith("SELECT DATABASE()")) return [[{...identity}], []];
    if (sql.includes("FROM information_schema.TABLES")) return [tables.map(row => ({...row})), []];
    if (sql.includes("FROM information_schema.STATISTICS")) return [indexes.map(row => ({...row})), []];
    if (sql.startsWith("SELECT version,name,checksum,state")) return [history.map(row => ({...row})), []];
    if (sql.startsWith("SELECT id FROM crm_app_lock")) return [state.lock, []];
    const count = /^SELECT COUNT\(\*\) AS total FROM `([a-z_]+)`$/u.exec(sql);
    if (count) {
      assert.equal(counts.has(count[1]!), true);
      return [state.countRows ?? [{total: counts.get(count[1]!)}], []];
    }
    assert.fail("Restricted migration visibility must not substitute for privileged hidden-object inspection");
  });
  const operator = inert(async (sql, values = []) => {
    calls.push({side: "operator", sql, values: [...values]});
    if (state.failOperator && sql.includes(state.failOperator)) throw new Error("Synthetic private observer failure");
    const match = /FROM information_schema\.(TRIGGERS|ROUTINES|EVENTS) WHERE (?:TRIGGER|ROUTINE|EVENT)_SCHEMA=\?/u.exec(sql);
    assert.ok(match);
    assert.deepEqual(values, [target.database]);
    return [objectRows[match[1]!]!.map(row => ({...row})), []];
  });
  return {calls, identity, tables, indexes, history, objectRows, counts, state, migration, operator};
}

test("OFFLINE runner checks selected schema, exact account host and pinned server identity with a read-only statement", async () => {
  const f = identityFixture(); await verifyConnection(f.connection, f.config, serverUuid);
  assert.equal(f.calls.length, 1); assert.match(f.calls[0]!.sql, /^SELECT DATABASE\(\)/u);
  assert.deepEqual(f.calls[0]!.values, []);
  assert.equal(f.calls[0]!.sql.includes(f.config.password), false);
  assert.equal(f.calls[0]!.sql.includes(f.config.database), false);
  f.identity.selectedDatabase = "crm_local_dev"; f.identity.identity = "root@localhost";
  await verifyConnection(f.connection, {...f.config, database: "crm_local_dev", environment: "development", user: "root"}, serverUuid);
});

test("OFFLINE runner rejects mismatched database/account/UUID/version/port and active roles", async () => {
  for (const [field, value] of Object.entries({selectedDatabase: "crm_local_dev", identity: `${target.runtimeUser}@localhost`,
    uuid: "12345678-1234-1234-1234-123456789013", version: "8.4.10", port: 3306, activeRoles: "other-role"})) {
    const f = identityFixture(); f.identity[field] = value;
    await assert.rejects(verifyConnection(f.connection, f.config, serverUuid));
  }
  const f = identityFixture();
  await assert.rejects(verifyConnection(f.connection, {...f.config, user: target.fixtureUser}, serverUuid));
  await assert.rejects(verifyConnection(f.connection, f.config, "12345678-1234-1234-1234-123456789013"));
});

test("OFFLINE runner refuses malformed identity metadata and failed reads without recovery or writes", async () => {
  for (const result of [null, {}, [], [null], ["not-row"], [[{}]], [{}, {}]]) {
    const f = identityFixture(); f.state.result = result;
    await assert.rejects(verifyConnection(f.connection, f.config, serverUuid));
    assert.equal(f.calls.length, 1);
  }
  const f = identityFixture(); f.state.failure = true;
  await assert.rejects(verifyConnection(f.connection, f.config, serverUuid)); assert.equal(f.calls.length, 1);
});

test("OFFLINE schema verifier uses completed immutable ledger, indexes, lock and zero business counts plus a separate observer", async () => {
  const f = schemaFixture(); await verifySchema(f.migration, target, f.operator);
  assert.equal(f.calls.filter(call => call.side === "operator").length, 3);
  assert.equal(f.calls.filter(call => call.sql.startsWith("SELECT COUNT(*)")).length, mysqlExpectedTables.length);
  assert.equal(f.calls.every(call => call.sql.startsWith("SELECT ")), true);
  for (const call of f.calls.filter(call => call.sql.includes("information_schema."))) assert.deepEqual(call.values, [target.database]);
});

test("OFFLINE schema verifier refuses existing business rows in each application table and missing lock singleton", async () => {
  for (const table of mysqlExpectedTables) {
    const f = schemaFixture(); f.counts.set(table, table === "crm_app_lock" ? "0" : "1");
    await assert.rejects(verifySchema(f.migration, target, f.operator));
  }
  for (const countRows of [[], [{total: 0}, {total: 0}], [null], [{total: "00"}], [{total: null}], [{total: "-1"}]]) {
    const f = schemaFixture(); f.state.countRows = countRows;
    await assert.rejects(verifySchema(f.migration, target, f.operator));
  }
});

test("OFFLINE schema verifier rejects unexpected/missing tables, views, wrong engines and changed migration lineage", async () => {
  const changes: ((f: ReturnType<typeof schemaFixture>) => void)[] = [
    f => { f.tables.push({name: "unapproved_history", type: "BASE TABLE", engine: "InnoDB"}); },
    f => { f.tables.pop(); }, f => { f.tables[0]!.type = "VIEW"; }, f => { f.tables[0]!.engine = "MyISAM"; },
    f => { f.history.length = 0; }, f => { f.history[0]!.checksum = "unapproved"; }, f => { f.history[0]!.state = "applying"; },
    f => { f.history[0]!.version = 2; }, f => { f.history[0]!.name = "unapproved"; }, f => { f.history.push({...f.history[0]!}); },
    f => { f.identity.selectedDatabase = "crm_local_dev"; }, f => { f.identity.serverVersion = "10.6.0"; },
    f => { f.identity.versionComment = "MariaDB"; }, f => { f.identity.autocommit = 0; },
  ];
  for (const change of changes) { const f = schemaFixture(); change(f); await assert.rejects(verifySchema(f.migration, target, f.operator)); }
});

test("OFFLINE schema verifier refuses missing or altered required indexes and malformed lock inventory", async () => {
  for (const update of ["missing", "nonUnique", "position", "columnName"] as const) {
    const f = schemaFixture();
    if (update === "missing") f.indexes.shift();
    else f.indexes[0]![update] = update === "nonUnique" ? 1 - Number(f.indexes[0]![update]) : update === "position" ? 9 : "unapproved";
    await assert.rejects(verifySchema(f.migration, target, f.operator));
  }
  for (const lock of [[], [{id: 2}], [{id: 1}, {id: 1}], [null], [{id: null}]]) {
    const f = schemaFixture(); f.state.lock = lock; await assert.rejects(verifySchema(f.migration, target, f.operator));
  }
});

test("OFFLINE privileged observer detects hidden triggers/routines/events even when restricted schema checks pass", async () => {
  for (const family of ["TRIGGERS", "ROUTINES", "EVENTS"]) {
    const f = schemaFixture(); f.objectRows[family]!.push({name: "unapproved_hidden_object"});
    await assert.rejects(verifySchema(f.migration, target, f.operator));
    assert.equal(f.calls.some(call => call.side === "operator" && call.sql.includes(`information_schema.${family}`)), true);
    assert.equal(f.calls.some(call => call.sql.startsWith("SELECT COUNT(*)")), false);
  }
  for (const malformed of [{name: 1}, {}, {name: null}]) {
    const f = schemaFixture(); f.objectRows.ROUTINES!.push(malformed);
    await assert.rejects(verifySchema(f.migration, target, f.operator));
  }
  const f = schemaFixture(); f.objectRows.TRIGGERS!.pop();
  await assert.rejects(verifySchema(f.migration, target, f.operator));
});

test("OFFLINE schema metadata failures stop before fixtures and never retry or modify schema", async () => {
  for (const family of ["TRIGGERS", "ROUTINES", "EVENTS"]) {
    const f = schemaFixture(); f.state.failOperator = family;
    await assert.rejects(verifySchema(f.migration, target, f.operator));
    assert.equal(f.calls.filter(call => call.side === "operator" && call.sql.includes(family)).length, 1);
    assert.equal(f.calls.some(call => call.sql.startsWith("SELECT COUNT(*)")), false);
  }
  const f = schemaFixture(); f.state.failMigration = "STATISTICS";
  await assert.rejects(verifySchema(f.migration, target, f.operator));
  assert.equal(f.calls.some(call => call.side === "operator"), false);
});
