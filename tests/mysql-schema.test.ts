import assert from "node:assert/strict";
import test from "node:test";
import { assertMysqlMigrationsCurrent, migrateMysqlApplicationSchema, MysqlMigrationError, mysqlMigrations, type MysqlMigrationSession } from "../src/server/db/mysql/migrations";
import { mysqlApplicationSchemaStatements, mysqlExpectedIndexes, mysqlExpectedTables, mysqlExpectedTriggers } from "../src/server/db/mysql/schema";

// This is an OFFLINE driver double. It does not parse/execute MySQL SQL, open a
// socket, start a server or establish actual MySQL migration/integration evidence.
function fixture() {
  const tables = new Set<string>(), triggers = new Set<string>();
  const calls: { sql: string; values: unknown[]; ddl: boolean }[] = [];
  const history: { version: number; name: string; checksum: string; state: string }[] = [];
  const state = { selectedDatabase: "crm_local_test_offline", serverVersion: "8.4.11", versionComment: "MySQL Community Server - GPL",
    autocommit: 1, lock: 1, release: 1, lockRow: false, failDdl: "", hiddenTriggers: false, missingIndex: "", alteredIndex: "" };
  const session: MysqlMigrationSession = {
    async execute(sql, values = []) {
      calls.push({ sql, values, ddl: false });
      if (sql.startsWith("SELECT DATABASE()")) return [[{ ...state }], []];
      if (sql.startsWith("SELECT GET_LOCK")) return [[{ acquired: state.lock }], []];
      if (sql.startsWith("SELECT RELEASE_LOCK")) return [[{ released: state.release }], []];
      if (sql.includes("FROM information_schema.TABLES")) return [[...tables].sort().map((name) => ({ name, type: "BASE TABLE", engine: "InnoDB" })), []];
      if (sql.includes("FROM information_schema.TRIGGERS")) return [[...triggers].filter(() => !state.hiddenTriggers).sort().map((name) => ({ name })), []];
      if (sql.includes("FROM information_schema.ROUTINES") || sql.includes("FROM information_schema.EVENTS")) return [[], []];
      if (sql.includes("FROM information_schema.STATISTICS")) return [mysqlExpectedIndexes.filter(({ name }) => name !== state.missingIndex)
        .flatMap((index) => index.columns.map((columnName, indexPosition) => ({ tableName: index.table, name: index.name,
          nonUnique: index.name === state.alteredIndex ? 1 : Number(!index.unique), position: indexPosition + 1, columnName }))), []];
      if (sql.startsWith("SELECT version,name,checksum,state")) return [history.map((row) => ({ ...row })), []];
      if (sql.startsWith("SELECT id FROM crm_app_lock")) return [state.lockRow ? [{ id: 1 }] : [], []];
      if (sql.startsWith("INSERT INTO crm_mysql_schema_migrations")) {
        history.push({ version: values[0] as number, name: values[1] as string, checksum: values[2] as string, state: "applying" });
        return [{ affectedRows: 1 }, []];
      }
      if (sql.startsWith("UPDATE crm_mysql_schema_migrations")) { history[0]!.state = "completed"; return [{ affectedRows: 1 }, []]; }
      throw new Error("Unexpected synthetic statement; driver details must not escape");
    },
    async query(sql) {
      calls.push({ sql, values: [], ddl: true });
      if (state.failDdl && sql.includes(state.failDdl)) throw new Error("Synthetic private driver detail");
      const table = /^CREATE TABLE ([a-z_]+) /u.exec(sql)?.[1], trigger = /^CREATE TRIGGER ([a-z_]+) /u.exec(sql)?.[1];
      if (table) { assert.equal(tables.has(table), false); tables.add(table); }
      else if (trigger) { assert.equal(triggers.has(trigger), false); triggers.add(trigger); }
      else if (sql === "INSERT INTO crm_app_lock(id) VALUES (1)") state.lockRow = true;
      else throw new Error("Unexpected synthetic DDL");
      return [{ affectedRows: 0 }, []];
    },
  };
  return { session, state, tables, triggers, calls, history, options: { database: state.selectedDatabase, allowSchemaChanges: true as const } };
}

test("OFFLINE MySQL schema manifest is additive application-only with exact text money/JSON and no historical seeds", () => {
  assert.equal(mysqlExpectedTables.length, 27);
  const created = mysqlApplicationSchemaStatements.flatMap((sql) => /^CREATE TABLE ([a-z_]+) /u.exec(sql)?.[1] ?? []);
  assert.deepEqual([...created].sort(), [...mysqlExpectedTables].sort());
  for (const sql of mysqlApplicationSchemaStatements) {
    assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE|ALTER|REPLACE|LOAD DATA|CREATE DATABASE)\b/u);
    assert.doesNotMatch(sql, /\b(?:AUTOINCREMENT|STRICT;|PRAGMA|sqlite_sequence|RAISE\()\b/u);
    if (sql.startsWith("CREATE TABLE")) assert.match(sql, /ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin$/u);
  }
  assert.deepEqual(mysqlApplicationSchemaStatements.filter((sql) => /^INSERT /u.test(sql)), ["INSERT INTO crm_app_lock(id) VALUES (1)"]);
  const schema = mysqlApplicationSchemaStatements.join("\n");
  assert.match(schema, /email VARCHAR\(254\) COLLATE utf8mb4_0900_as_ci NOT NULL UNIQUE/u);
  for (const column of ["unit_price", "service_charge", "received_amount", "quantity", "item_discount", "total"]) {
    assert.match(schema, new RegExp(`${column} VARCHAR\\(80\\)`));
  }
  assert.match(schema, /totals_json LONGTEXT NOT NULL CHECK/u);
  assert.equal(mysqlExpectedTriggers.length, 19);
  assert.equal((schema.match(/CHECK \(OCTET_LENGTH\(content\)=file_size\)/gu) ?? []).length, 2);
  assert.doesNotMatch(schema, /content MEDIUMBLOB NOT NULL CHECK|expires_at BIGINT NOT NULL CHECK/u);
  assert.equal(mysqlExpectedIndexes.filter(({ unique }) => unique).length, 4);
});

test("OFFLINE migration runner records applying before additive DDL, verifies completion and returns zero on repeat", async () => {
  const f = fixture();
  await assert.rejects(assertMysqlMigrationsCurrent(f.session, f.options.database), MysqlMigrationError);
  assert.equal(await migrateMysqlApplicationSchema(f.session, f.options), 1);
  assert.deepEqual(f.history, [{ version: 1, name: mysqlMigrations[0].name, checksum: mysqlMigrations[0].checksum, state: "completed" }]);
  const applying = f.calls.findIndex(({ sql }) => sql.startsWith("INSERT INTO crm_mysql_schema_migrations"));
  const firstAppDdl = f.calls.findIndex(({ sql }) => sql.startsWith("CREATE TABLE users"));
  assert.ok(applying > 0 && applying < firstAppDdl);
  const ddlCount = f.calls.filter(({ ddl }) => ddl).length;
  assert.equal(await migrateMysqlApplicationSchema(f.session, f.options), 0);
  assert.equal(f.calls.filter(({ ddl }) => ddl).length, ddlCount);
  assert.equal(f.calls.filter(({ sql }) => sql.startsWith("SELECT RELEASE_LOCK")).length, 2);
  await assertMysqlMigrationsCurrent(f.session, f.options.database);
});

test("OFFLINE migration rejects schema mismatch, wrong product/version, disabled autocommit and absent explicit acknowledgement before DDL", async () => {
  for (const mutation of [
    { selectedDatabase: "crm_local_dev" }, { selectedDatabase: "mysql" }, { serverVersion: "8.4.10" },
    { serverVersion: "11.4.13-MariaDB" }, { versionComment: "MariaDB Server" }, { versionComment: "unverified" }, { autocommit: 0 },
  ]) {
    const f = fixture(); Object.assign(f.state, mutation);
    await assert.rejects(migrateMysqlApplicationSchema(f.session, f.options), MysqlMigrationError);
    assert.equal(f.calls.some(({ ddl }) => ddl), false);
  }
  const f = fixture();
  await assert.rejects(migrateMysqlApplicationSchema(f.session, { ...f.options, allowSchemaChanges: false } as unknown as typeof f.options), MysqlMigrationError);
  assert.deepEqual(f.calls, []);
});

test("OFFLINE migration refuses unknown existing objects and missing advisory ownership without resetting anything", async () => {
  for (const kind of ["table", "trigger"] as const) {
    const f = fixture(); (kind === "table" ? f.tables : f.triggers).add("preserved_unknown_object");
    await assert.rejects(migrateMysqlApplicationSchema(f.session, f.options), MysqlMigrationError);
    assert.equal(f.calls.some(({ ddl }) => ddl), false);
    assert.equal((kind === "table" ? f.tables : f.triggers).has("preserved_unknown_object"), true);
    assert.equal(f.calls.filter(({ sql }) => sql.startsWith("SELECT RELEASE_LOCK")).length, 1);
  }
  const f = fixture(); f.state.lock = 0;
  await assert.rejects(migrateMysqlApplicationSchema(f.session, f.options), MysqlMigrationError);
  assert.equal(f.calls.some(({ ddl }) => ddl), false);
  assert.equal(f.calls.some(({ sql }) => sql.startsWith("SELECT RELEASE_LOCK")), false);
});

test("OFFLINE failed MySQL DDL remains visibly applying and refuses automatic resume or fictitious rollback", async () => {
  const f = fixture(); f.state.failDdl = "CREATE TABLE tasks ";
  await assert.rejects(migrateMysqlApplicationSchema(f.session, f.options), (error: unknown) => {
    assert.ok(error instanceof MysqlMigrationError); assert.doesNotMatch(error.message, /private driver detail/u); return true;
  });
  assert.equal(f.history[0]!.state, "applying");
  assert.ok(f.tables.has("users")); assert.equal(f.tables.has("tasks"), false);
  const priorCalls = f.calls.filter(({ ddl }) => ddl).length;
  f.state.failDdl = "";
  await assert.rejects(migrateMysqlApplicationSchema(f.session, f.options), MysqlMigrationError);
  assert.equal(f.calls.filter(({ ddl }) => ddl).length, priorCalls);
  assert.equal(f.calls.some(({ sql }) => /^ROLLBACK|^DROP|^TRUNCATE/u.test(sql)), false);
  assert.equal(f.tables.has("users"), true);
});

test("OFFLINE tampered history, missing tables/index uniqueness and absent lock row fail closed", async () => {
  const f = fixture(); await migrateMysqlApplicationSchema(f.session, f.options);
  for (const mutation of [{ version: 2 }, { name: "other" }, { checksum: "other" }, { state: "applying" }]) {
    const original = { ...f.history[0]! }; Object.assign(f.history[0]!, mutation);
    await assert.rejects(assertMysqlMigrationsCurrent(f.session, f.options.database), MysqlMigrationError);
    Object.assign(f.history[0]!, original);
  }
  f.tables.delete("users"); await assert.rejects(assertMysqlMigrationsCurrent(f.session, f.options.database), MysqlMigrationError); f.tables.add("users");
  f.state.missingIndex = "idx_commercial_busy_task";
  await assert.rejects(assertMysqlMigrationsCurrent(f.session, f.options.database), MysqlMigrationError); f.state.missingIndex = "";
  f.state.alteredIndex = "idx_lead_operation_busy_task";
  await assert.rejects(assertMysqlMigrationsCurrent(f.session, f.options.database), MysqlMigrationError); f.state.alteredIndex = "";
  f.state.lockRow = false; await assert.rejects(assertMysqlMigrationsCurrent(f.session, f.options.database), MysqlMigrationError);
});

test("OFFLINE runtime verification does not require granting application identities TRIGGER or DDL privileges", async () => {
  const f = fixture(); await migrateMysqlApplicationSchema(f.session, f.options);
  f.state.hiddenTriggers = true;
  const before = f.calls.length;
  await assertMysqlMigrationsCurrent(f.session, f.options.database);
  assert.equal(f.calls.slice(before).some(({ sql, ddl }) => ddl || sql.includes("information_schema.TRIGGERS")), false);
  await assert.rejects(migrateMysqlApplicationSchema(f.session, f.options), MysqlMigrationError);
});

test("OFFLINE lost advisory release is not reported as migration success", async () => {
  const f = fixture(); f.state.release = 0;
  await assert.rejects(migrateMysqlApplicationSchema(f.session, f.options), MysqlMigrationError);
  assert.equal(f.history[0]?.state, "completed", "DDL is already committed; a release error must not pretend it was rolled back");
});
