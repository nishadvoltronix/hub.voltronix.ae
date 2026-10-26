import assert from "node:assert/strict";
import test from "node:test";
import { assertMysqlMigrationsCurrent, migrateMysqlApplicationSchema, MysqlMigrationError, mysqlMigrations, type MysqlMigrationSession } from "../src/db/mysql/migrations.js";
import { mysqlApplicationSchemaStatements, mysqlExpectedIndexes, mysqlExpectedTables, mysqlExpectedTriggers } from "../src/db/mysql/schema.js";
import { assertMysqlAuthReady, mysqlAuthPrivileges, MysqlAuthReadinessError, type MysqlAuthVerifyConnection } from "../src/db/mysql/verification.js";
import type { MysqlAuthConfig } from "../src/db/mysql/config.js";

// This is an OFFLINE driver double. It does not parse/execute MySQL SQL, open a
// socket, start a server or establish actual MySQL migration/integration evidence.
function fixture() {
  const tables = new Set<string>(), triggers = new Set<string>();
  const calls: { sql: string; values: unknown[]; ddl: boolean }[] = [];
  const history: { version: number; name: string; checksum: string; state: string }[] = [];
  const state = { selectedDatabase: "crm_local_auth_00000000000040008000000000000000", serverVersion: "8.4.11", versionComment: "MySQL Community Server - GPL",
    port: 3308, autocommit: 1, lock: 1, release: 1, lockRow: false, failDdl: "", hiddenTriggers: false, missingIndex: "", alteredIndex: "" };
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
  // Reviewed Next.js v1 fingerprint: standalone copy must never fork that ledger.
  assert.equal(mysqlMigrations[0].checksum, "766fcdc418218d76eab9051dbeac4165046a117bf8e758ca7f6ca819160afa11");
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

type MetadataRow = Record<string, unknown>;
/** Scripted metadata, not a SQL engine or database. Expected rows are deliberately
 * visible for review; successful doubles cannot prove real MySQL visibility/grants.
 */
function readinessFixture() {
  const config: MysqlAuthConfig = { provider: "mysql", environment: "test", host: "127.0.0.1", port: 3308,
    database: "crm_local_auth_00000000000040008000000000000000", user: "auth_synthetic", password: "synthetic-private-not-a-server-secret" };
  const identity: MetadataRow = { selectedDatabase: config.database, identity: `${config.user}@127.0.0.1`, activeRoles: "NONE",
    mandatoryRoles: "", version: "8.4.11", family: "MySQL Community Server - GPL", port: 3308, autocommit: 1, foreignKeyChecks: 1, uniqueChecks: 1 };
  const recipient = `\`${config.user}\`@\`127.0.0.1\``;
  const grants = [`GRANT USAGE ON *.* TO ${recipient}`, ...Object.entries(mysqlAuthPrivileges).map(([table, permissions]) =>
    `GRANT ${permissions.join(", ")} ON \`${config.database}\`.\`${table}\` TO ${recipient}`)];
  const tables: MetadataRow[] = Object.keys(mysqlAuthPrivileges).sort().map(name => ({ name, type: "BASE TABLE", engine: "InnoDB", collation: "utf8mb4_0900_bin" }));
  const columnDefinitions = {
    users: "id:bigint user_id:varchar(100) username:varchar(120) email:varchar(254) password:varchar(255) status:varchar(16)",
    permissions: "id:bigint key:varchar(120)", admin_user_permissions: "id:bigint admin_user_id:bigint permission_id:bigint",
    crm_sessions: "token_hash:char(64) user_id:bigint csrf_hash:char(64) password_fingerprint:char(64) created_at:bigint expires_at:bigint",
    crm_login_attempts: "bucket:varchar(80) window_start:bigint attempts:int", crm_app_lock: "id:tinyint",
    crm_mysql_schema_migrations: "version:int name:varchar(120) checksum:char(64) state:varchar(16)",
  };
  const columns: MetadataRow[] = Object.entries(columnDefinitions).flatMap(([tableName, definition]) => definition.split(" ").map(pair => {
    const [name, type] = pair.split(":");
    return { tableName, name, type, nullable: tableName === "users" && name === "user_id" ? "YES" : "NO",
      collation: type!.includes("char") ? name === "email" ? "utf8mb4_0900_as_ci" :
        ["crm_sessions", "crm_login_attempts"].includes(tableName) || name === "checksum" ? "ascii_bin" : "utf8mb4_0900_bin" : null,
      extra: name === "id" && tableName !== "crm_app_lock" ? "auto_increment" : "" };
  }));
  const indexes: MetadataRow[] = [];
  const addIndex = (tableName: string, name: string, fields: string[], unique = true) => fields.forEach((columnName, i) => indexes.push({
    tableName, name, columnName, position: i + 1, nonUnique: Number(!unique), prefixLength: null, visible: "YES", expression: null, direction: "A",
  }));
  for (const table of ["users", "permissions", "admin_user_permissions", "crm_app_lock"]) addIndex(table, "PRIMARY", ["id"]);
  addIndex("users", "email", ["email"]); addIndex("users", "user_id", ["user_id"]); addIndex("permissions", "key", ["key"]);
  addIndex("admin_user_permissions", "admin_user_id", ["admin_user_id", "permission_id"]);
  addIndex("crm_sessions", "PRIMARY", ["token_hash"]); addIndex("crm_sessions", "idx_sessions_user", ["user_id"], false);
  addIndex("crm_sessions", "idx_sessions_expiry", ["expires_at"], false); addIndex("crm_login_attempts", "PRIMARY", ["bucket"]);
  addIndex("crm_login_attempts", "idx_login_attempts_window", ["window_start"], false); addIndex("crm_mysql_schema_migrations", "PRIMARY", ["version"]);
  const foreignKeys: MetadataRow[] = [
    ["admin_user_permissions", "admin_user_id", "users"], ["admin_user_permissions", "permission_id", "permissions"], ["crm_sessions", "user_id", "users"],
  ].map(([tableName, columnName, referencedTable]) => ({ tableName, columnName, referencedTable, position: 1,
    referencedSchema: config.database, referencedColumn: "id", deleteRule: "CASCADE", updateRule: "NO ACTION" }));
  const checkDefinitions = {
    users: ["(`status` in (_utf8mb4'active',_utf8mb4'inactive'))", "(`quote_access` in (0,1))", "((`version` >= 1) and (`version` <= 9007199254740991))",
      "((`grants_version` >= 1) and (`grants_version` <= 9007199254740991))"],
    permissions: ["((`version` >= 1) and (`version` <= 9007199254740991))"],
    crm_sessions: ["((`created_at` >= 0) and (`created_at` <= 9007199254740991))", "((`expires_at` > `created_at`) and (`expires_at` <= 9007199254740991))"],
    crm_login_attempts: ["((`window_start` >= 0) and (`window_start` <= 9007199254740991))", "(`attempts` >= 0)"],
    crm_app_lock: ["(`id` = 1)"], crm_mysql_schema_migrations: ["(`state` in (_utf8mb4'applying',_utf8mb4'completed'))"],
  };
  const checks: MetadataRow[] = Object.entries(checkDefinitions).flatMap(([tableName, clauses]) => clauses.map(expression => ({ tableName, expression, enforced: "YES" })));
  const history: MetadataRow[] = [{ version: "1", name: mysqlMigrations[0].name, checksum: mysqlMigrations[0].checksum, state: "completed" }];
  const lock: MetadataRow[] = [{ id: 1 }];
  const calls: { sql: string; values: unknown[]; kind: string }[] = [];
  const state = { failAt: "" };
  const connection: MysqlAuthVerifyConnection = {
    async execute(sql, values = []) {
      calls.push({ sql, values, kind: "execute" });
      if (state.failAt && sql.includes(state.failAt)) throw new Error("Synthetic private driver error contains no real secret");
      if (sql.startsWith("SELECT DATABASE()")) return [[identity], []];
      if (sql.includes("information_schema.TABLES")) return [tables, []];
      if (sql.includes("information_schema.COLUMNS")) return [columns, []];
      if (sql.includes("information_schema.STATISTICS")) return [indexes, []];
      if (sql.includes("information_schema.KEY_COLUMN_USAGE")) return [foreignKeys, []];
      if (sql.includes("information_schema.TABLE_CONSTRAINTS")) return [checks, []];
      if (sql.startsWith("SELECT version,name,checksum,state")) return [history, []];
      if (sql.startsWith("SELECT id FROM crm_app_lock")) return [lock, []];
      throw new Error("Unexpected readiness double statement");
    },
    async query(sql) { calls.push({ sql, values: [], kind: "query" }); assert.equal(sql, "SHOW GRANTS"); return [grants.map(value => ({ grant: value })), []]; },
  };
  return { connection, config, identity, recipient, grants, tables, columns, indexes, foreignKeys, checks, history, lock, calls, state };
}

test("OFFLINE dedicated auth grant contract excludes user writes, broad CRM tables, DDL and globals", () => {
  assert.deepEqual(mysqlAuthPrivileges, {
    users: ["SELECT"], permissions: ["SELECT"], admin_user_permissions: ["SELECT"],
    crm_sessions: ["SELECT", "INSERT", "UPDATE", "DELETE"], crm_login_attempts: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    crm_app_lock: ["SELECT", "UPDATE"], crm_mysql_schema_migrations: ["SELECT"],
  });
  assert.ok(Object.isFrozen(mysqlAuthPrivileges));
  assert.ok(Object.values(mysqlAuthPrivileges).every(Object.isFrozen));
});

test("OFFLINE readiness performs only fixed read-only metadata statements and parameterized scoped identifiers", async () => {
  const f = readinessFixture();
  await assertMysqlAuthReady(f.connection, f.config);
  assert.equal(f.calls.length, 9);
  assert.ok(f.calls.every(({ sql }) => /^(SELECT|SHOW GRANTS)/u.test(sql)));
  assert.ok(f.calls.every(({ sql }) => !sql.includes(f.config.database) && !sql.includes(f.config.password) && !sql.includes(f.config.user)));
  for (const call of f.calls.filter(({ sql }) => sql.includes("information_schema."))) assert.equal(call.values[0], f.config.database);
  assert.equal(f.calls.filter(({ kind }) => kind === "query").length, 1);
  assert.ok(f.calls.every(({ sql }) => !/mysql\.(?:user|db|tables_priv)|^(?:TRIGGER|GRANT |CREATE|ALTER|INSERT|UPDATE|DELETE)/u.test(sql)));
});

test("OFFLINE readiness rejects unsupported target before issuing a query", async () => {
  for (const change of [{ host: "localhost" }, { port: 3306 }, { database: "crm" }, { database: "crm_local_dev" }, { user: "bad`recipient" }]) {
    const f = readinessFixture();
    await assert.rejects(assertMysqlAuthReady(f.connection, { ...f.config, ...change } as MysqlAuthConfig), MysqlAuthReadinessError);
    assert.deepEqual(f.calls, []);
  }
});

test("OFFLINE readiness rejects wrong server/account/session policy before examining grants", async () => {
  for (const change of [
    { selectedDatabase: "crm_local_dev" }, { identity: "different@127.0.0.1" }, { identity: "auth_synthetic@localhost" },
    { activeRoles: "`some_role`@`%`" }, { mandatoryRoles: "some_role" }, { version: "8.4.10" }, { version: "11.4.0-MariaDB" },
    { family: "Percona Server (MySQL compatible)" }, { family: "MariaDB Server" }, { port: 3306 },
    { autocommit: 0 }, { foreignKeyChecks: 0 }, { uniqueChecks: 0 },
  ]) {
    const f = readinessFixture(); Object.assign(f.identity, change);
    await assert.rejects(assertMysqlAuthReady(f.connection, f.config), MysqlAuthReadinessError);
    assert.equal(f.calls.length, 1);
  }
});

test("OFFLINE readiness rejects missing/extra grants, broad schema/global/dynamic grants, roles and grant option", async () => {
  const mutations = [
    (f: ReturnType<typeof readinessFixture>) => { f.grants.pop(); },
    (f: ReturnType<typeof readinessFixture>) => { f.grants.shift(); },
    (f: ReturnType<typeof readinessFixture>) => { f.grants.push(f.grants[0]!); },
    (f: ReturnType<typeof readinessFixture>) => { f.grants.push(f.grants[1]!); },
    ...[
      "GRANT SELECT ON *.* TO RECIPIENT", "GRANT SYSTEM_USER ON *.* TO RECIPIENT", "GRANT `a_role`@`%` TO RECIPIENT",
      "GRANT SELECT ON `DATABASE`.* TO RECIPIENT", "GRANT SELECT ON `DATABASE`.`tasks` TO RECIPIENT",
      "GRANT EXECUTE ON PROCEDURE `DATABASE`.`routine` TO RECIPIENT", "GRANT SELECT (`password`) ON `DATABASE`.`users` TO RECIPIENT",
    ].map(line => (f: ReturnType<typeof readinessFixture>) => { f.grants.push(line.replaceAll("RECIPIENT", f.recipient).replaceAll("DATABASE", f.config.database)); }),
    (f: ReturnType<typeof readinessFixture>) => { f.grants[1] += " WITH GRANT OPTION"; },
    (f: ReturnType<typeof readinessFixture>) => { f.grants[1] = f.grants[1]!.replace("SELECT ON", "SELECT, INSERT ON"); },
    (f: ReturnType<typeof readinessFixture>) => { f.grants[1] = f.grants[1]!.replace(f.config.database, "crm_local_dev"); },
    (f: ReturnType<typeof readinessFixture>) => { f.grants[1] = f.grants[1]!.replace(f.config.user, "different"); },
  ];
  for (const mutate of mutations) {
    const f = readinessFixture(); mutate(f);
    await assert.rejects(assertMysqlAuthReady(f.connection, f.config), MysqlAuthReadinessError);
    assert.equal(f.calls.length, 2);
  }
});

test("OFFLINE readiness rejects missing/view/nontransactional tables and unsafe column drift", async () => {
  const mutations = [
    (f: ReturnType<typeof readinessFixture>) => { f.tables.pop(); },
    (f: ReturnType<typeof readinessFixture>) => { f.tables[0]!.type = "VIEW"; },
    (f: ReturnType<typeof readinessFixture>) => { f.tables[0]!.engine = "MyISAM"; },
    (f: ReturnType<typeof readinessFixture>) => { f.tables[0]!.collation = "utf8mb4_general_ci"; },
    (f: ReturnType<typeof readinessFixture>) => { f.columns.pop(); },
    ...[{ type: "double" }, { type: "bigint unsigned" }, { nullable: "YES" }, { extra: "STORED GENERATED" }].map(change =>
      (f: ReturnType<typeof readinessFixture>) => { Object.assign(f.columns.find(row => row.tableName === "crm_sessions" && row.name === "expires_at")!, change); }),
    (f: ReturnType<typeof readinessFixture>) => { f.columns.find(row => row.tableName === "users" && row.name === "email")!.collation = "utf8mb4_0900_bin"; },
    (f: ReturnType<typeof readinessFixture>) => { f.columns.find(row => row.name === "token_hash")!.type = "char(32)"; },
  ];
  for (const mutate of mutations) { const f = readinessFixture(); mutate(f); await assert.rejects(assertMysqlAuthReady(f.connection, f.config), MysqlAuthReadinessError); }
});

test("OFFLINE readiness rejects lost unique email/session indexes and prefix/invisible/reordered indexes", async () => {
  for (const change of [{ nonUnique: 1 }, { columnName: "username" }, { position: 2 }, { prefixLength: 8 },
    { visible: "NO" }, { expression: "lower(email)" }, { direction: "D" }]) {
    const f = readinessFixture(); Object.assign(f.indexes.find(row => row.tableName === "users" && row.name === "email")!, change);
    await assert.rejects(assertMysqlAuthReady(f.connection, f.config), MysqlAuthReadinessError);
  }
  for (const name of ["idx_sessions_expiry", "idx_sessions_user", "idx_login_attempts_window"]) {
    const f = readinessFixture(); f.indexes.splice(f.indexes.findIndex(row => row.name === name), 1);
    await assert.rejects(assertMysqlAuthReady(f.connection, f.config), MysqlAuthReadinessError);
  }
});

test("OFFLINE readiness rejects foreign-key drift, deleted checks and unenforced/altered expiry constraints", async () => {
  const mutations = [
    (f: ReturnType<typeof readinessFixture>) => { f.foreignKeys.pop(); },
    ...[{ deleteRule: "SET NULL" }, { updateRule: "CASCADE" }, { referencedSchema: "crm" }, { referencedColumn: "user_id" }, { position: 2 }].map(change =>
      (f: ReturnType<typeof readinessFixture>) => { Object.assign(f.foreignKeys[2]!, change); }),
    (f: ReturnType<typeof readinessFixture>) => { f.checks.pop(); },
    (f: ReturnType<typeof readinessFixture>) => { f.checks[0]!.enforced = "NO"; },
    (f: ReturnType<typeof readinessFixture>) => { f.checks.find(row => row.tableName === "crm_sessions")!.expression = "created_at >= -1"; },
    (f: ReturnType<typeof readinessFixture>) => { f.checks.push({ tableName: "crm_sessions", expression: "1=1", enforced: "YES" }); },
    ...[
      ["users", "status IN ('ACTIVE','INACTIVE')"], ["users", "status IN ('Active','inactive')"],
      ["users", "status IN ('active ','inactive')"], ["users", "status IN ('(active)','inactive')"],
      ["users", "status IN ('act`ive','inactive')"], ["users", "status IN ('act''ive','inactive')"],
      ["crm_mysql_schema_migrations", "state IN ('APPLYING','COMPLETED')"],
      ["crm_mysql_schema_migrations", "state IN ('applying','Completed')"],
    ].map(([tableName, expression]) => (f: ReturnType<typeof readinessFixture>) => {
      f.checks.find(row => row.tableName === tableName)!.expression = expression;
    }),
  ];
  for (const mutate of mutations) { const f = readinessFixture(); mutate(f); await assert.rejects(assertMysqlAuthReady(f.connection, f.config), MysqlAuthReadinessError); }
  const f = readinessFixture();
  f.checks[0]!.expression = "(STATUS IN (_UTF8MB4'active', _UTF8MB4'inactive'))";
  await assertMysqlAuthReady(f.connection, f.config);
});

test("OFFLINE readiness rejects incomplete/drifted migration history and corrupted technical singleton", async () => {
  for (const change of [{ version: 2 }, { state: "applying" }, { checksum: "0".repeat(64) }, { name: "unexpected" }]) {
    const f = readinessFixture(); Object.assign(f.history[0]!, change); await assert.rejects(assertMysqlAuthReady(f.connection, f.config), MysqlAuthReadinessError);
  }
  for (const table of ["history", "lock"] as const) {
    const f = readinessFixture(); f[table].pop(); await assert.rejects(assertMysqlAuthReady(f.connection, f.config), MysqlAuthReadinessError);
  }
  const f = readinessFixture(); f.lock.push({ id: 2 }); await assert.rejects(assertMysqlAuthReady(f.connection, f.config), MysqlAuthReadinessError);
});

test("OFFLINE every readiness query failure is sanitized and never invokes DDL or privilege repair", async () => {
  for (const fragment of ["SELECT DATABASE()", "information_schema.TABLES", "information_schema.COLUMNS", "information_schema.STATISTICS",
    "information_schema.KEY_COLUMN_USAGE", "information_schema.TABLE_CONSTRAINTS", "SELECT version,name", "SELECT id FROM crm_app_lock"]) {
    const f = readinessFixture(); f.state.failAt = fragment;
    await assert.rejects(assertMysqlAuthReady(f.connection, f.config), error => {
      assert.ok(error instanceof MysqlAuthReadinessError); assert.doesNotMatch(error.message, /synthetic|private|driver|SELECT|password/iu); return true;
    });
    assert.ok(f.calls.every(({ sql }) => /^(SELECT|SHOW GRANTS)/u.test(sql)));
  }
});
