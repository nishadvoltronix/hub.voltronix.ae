import assert from "node:assert/strict";
import test from "node:test";
import { assertEmptySchema, assertScopedAccounts, assertTargetAbsent, grantRuntimePrivileges, HarnessObserverError,
  observeOperator, provisionTarget, type HarnessTarget } from "../scripts/crm-demo/observer.js";
import type { MysqlWireConnection } from "../src/crm/db/mysql/driver.js";
import { mysqlRuntimePrivileges } from "../src/crm/db/mysql/runtime-privileges.js";

// OFFLINE metadata/DDL double: does not connect, execute SQL or establish live
// MySQL semantics. Generated values are synthetic and never emitted as evidence.
const target: HarnessTarget = { database: "crm_local_crm_00000000000040008000000000000001",
  runtimeUser: "crm_r_000000000000400080000000", migrationUser: "crm_m_000000000000400080000000", fixtureUser: "crm_f_000000000000400080000000" };
const passwords = { runtime: "r".repeat(64), migration: "m".repeat(64), fixture: "f".repeat(64) };
type Row = Record<string, unknown>;
function fixture() {
  const accounts = new Map<string, Row>(), grants = new Map<string, Row[]>(), tableGrants = new Map<string, Row[]>();
  const calls: { sql: string; values: readonly unknown[]; mutation: boolean }[] = [];
  const state = { schema: false, objects: [] as Row[], objectFamily: "TABLES", extra: "", failRead: "", failMutation: 0,
    extraGlobal: "", otherHost: false, operatorGrant: true };
  const identity: Row = { selectedDatabase: "crm_local_dev", identity: "root@localhost", activeRoles: "NONE", mandatoryRoles: "",
    version: "8.4.11", family: "MySQL Community Server - GPL", uuid: "12345678-1234-1234-1234-123456789012", port: 3308,
    partialRevokes: 1, generalLog: 0, slowLog: 0, binaryLog: 0, autocommit: 1, foreignKeyChecks: 1, uniqueChecks: 1 };
  function privilegeRow(sql: string, role: "operator" | "runtime" | "migration" | "fixture"): Row {
    const columns = sql.split(" FROM ")[0]!.match(/\b[A-Za-z_]+_priv\b/gu) ?? [];
    const allowed = role === "migration" ? ["Select", "Insert", "Update", "Create", "Alter", "References", "Trigger"]
      : role === "fixture" ? ["Select", "Insert", "Update", "Delete"] : [];
    return Object.fromEntries(columns.map(column => [column, role === "operator" || allowed.includes(column.slice(0, -5)) ? "Y" : "N"]));
  }
  function prepareAccounts(runtimeGranted = true) {
    for (const [role, name] of [["runtime", target.runtimeUser], ["migration", target.migrationUser], ["fixture", target.fixtureUser]]) {
      accounts.set(name!, { User: name, Host: "127.0.0.1", plugin: "caching_sha2_password", account_locked: "N", password_expired: "N", hasRestrictions: 0 });
      grants.set(name!, role === "runtime" ? [] : [{ Db: target.database, role }]);
      tableGrants.set(name!, role === "runtime" && runtimeGranted ? Object.entries(mysqlRuntimePrivileges).map(([Table_name, privileges]) => ({ Db: target.database, Table_name, Table_priv: privileges.join(","), Column_priv: "" })) : []);
    }
  }
  let mutationCount = 0;
  const connection: MysqlWireConnection = {
    async execute(sql, values = []) {
      calls.push({ sql, values: [...values], mutation: false });
      if (state.failRead && sql.includes(state.failRead)) throw new Error("Private simulated SQL/credential detail");
      if (sql.startsWith("SELECT DATABASE()")) return [[{ ...identity }], []];
      if (sql.includes("FROM mysql.user")) {
        if (values[0] === "root") return [[{ ...privilegeRow(sql, "operator"), User: "root", Host: "localhost", account_locked: "N", Grant_priv: state.operatorGrant ? "Y" : "N" }], []];
        const account = accounts.get(String(values[0]));
        if (!account) return [[], []];
        const result = [{ ...privilegeRow(sql, "runtime"), ...account, ...(state.extraGlobal ? { [state.extraGlobal]: "Y" } : {}) }];
        if (state.otherHost) result.push({ ...result[0]!, Host: "%" });
        return [result, []];
      }
      if (sql.includes("FROM information_schema.SCHEMATA")) return [state.schema ? [{ SCHEMA_NAME: target.database, DEFAULT_CHARACTER_SET_NAME: "utf8mb4", DEFAULT_COLLATION_NAME: "utf8mb4_0900_bin" }] : [], []];
      if (sql.includes("FROM information_schema.")) {
        const family = /FROM information_schema\.([A-Z_]+)/u.exec(sql)![1];
        return [state.objectFamily === family ? [...state.objects] : [], []];
      }
      if (sql.includes("FROM mysql.db")) return [(grants.get(String(values[0])) ?? []).map(row => ({ ...privilegeRow(sql, row.role as "migration" | "fixture"), ...row })), []];
      if (sql.includes("FROM mysql.tables_priv")) return [tableGrants.get(String(values[0])) ?? [], []];
      if (sql.includes("FROM mysql.")) return [state.extra && sql.includes(state.extra) ? [{ present: 1 }] : [], []];
      throw new Error("Unexpected offline metadata query");
    },
    async query(sql) {
      calls.push({ sql, values: [], mutation: true });
      if (++mutationCount === state.failMutation) throw new Error("Private simulated DDL detail");
      if (sql.startsWith("CREATE DATABASE")) { state.schema = true; return [{ affectedRows: 1 }, []]; }
      const user = /CREATE USER '([a-z0-9_]+)'/u.exec(sql)?.[1];
      if (user) {
        accounts.set(user, { User: user, Host: "127.0.0.1", plugin: "caching_sha2_password", account_locked: "N", password_expired: "N", hasRestrictions: 0 });
        grants.set(user, []); tableGrants.set(user, []); return [{ affectedRows: 0 }, []];
      }
      const grant = /^GRANT ([A-Z,]+) ON `([a-z0-9_]+)`\.(\*|`[a-z0-9_]+`) TO '([a-z0-9_]+)'@'127\.0\.0\.1'$/u.exec(sql);
      if (grant) {
        if (grant[3] === "*") grants.set(grant[4]!, [{ Db: grant[2], role: grant[4] === target.migrationUser ? "migration" : "fixture" }]);
        else tableGrants.get(grant[4]!)!.push({ Db: grant[2], Table_name: grant[3]!.slice(1, -1), Table_priv: grant[1], Column_priv: "" });
        return [{ affectedRows: 0 }, []];
      }
      throw new Error("Unexpected offline DDL");
    },
    async beginTransaction() { assert.fail("DDL must not use transaction rollback as isolation"); },
    async commit() { assert.fail("No implicit transaction wrapper permitted"); },
    async rollback() { assert.fail("DDL rollback must not be attempted"); },
    async end() {}, destroy() {},
  };
  return { connection, state, identity, calls, accounts, grants, tableGrants, prepareAccounts };
}

test("OFFLINE observer checks fixed local operator/server policy and emits UUID only", async () => {
  const f = fixture();
  assert.deepEqual(await observeOperator(f.connection, "root"), { serverUuid: f.identity.uuid });
  assert.equal(f.calls.some(call => call.mutation), false);
  for (const call of f.calls) assert.doesNotMatch(call.sql, /authentication_string|password\b|SELECT \*/iu);
});

test("OFFLINE observer refuses wrong instance, provider, role, policy, logs and weakened session controls", async () => {
  for (const [field, value] of Object.entries({ selectedDatabase: "crm", identity: "root@127.0.0.1", activeRoles: "someone", mandatoryRoles: "role",
    version: "8.4.10", family: "MariaDB Server", uuid: "not-an-instance", port: 3306, partialRevokes: 0, generalLog: 1, slowLog: 1,
    binaryLog: 1, autocommit: 0, foreignKeyChecks: 0, uniqueChecks: 0 })) {
    const f = fixture(); f.identity[field] = value;
    await assert.rejects(observeOperator(f.connection, "root"), HarnessObserverError);
    assert.equal(f.calls.some(call => call.mutation), false);
  }
  const f = fixture();
  await assert.rejects(observeOperator(f.connection, "notroot"), HarnessObserverError);
  assert.equal(f.calls.length, 0);
  f.state.operatorGrant = false;
  await assert.rejects(observeOperator(f.connection, "root"), HarnessObserverError);
});

test("OFFLINE complete absence checks bind UUID schema and all account host variants", async () => {
  const f = fixture(); await assertTargetAbsent(f.connection, target);
  for (const name of [target.database, target.runtimeUser, target.migrationUser, target.fixtureUser]) {
    assert.equal(f.calls.some(call => call.values.includes(name)), true);
    assert.equal(f.calls.some(call => call.sql.includes(name)), false);
  }
  assert.equal(f.calls.filter(call => /information_schema\.(?:TABLES|TRIGGERS|ROUTINES|EVENTS)/u.test(call.sql)).length, 4);
  f.state.schema = true;
  await assert.rejects(assertTargetAbsent(f.connection, target), HarnessObserverError);
  f.state.schema = false; f.accounts.set(target.runtimeUser, { User: target.runtimeUser, Host: "%" });
  await assert.rejects(assertTargetAbsent(f.connection, target), HarnessObserverError);
});

test("OFFLINE absence/empty preflight rejects every object class including views and missing schema", async () => {
  for (const family of ["TABLES", "TRIGGERS", "ROUTINES", "EVENTS"]) {
    const f = fixture(); f.state.objectFamily = family; f.state.objects = [{ TABLE_TYPE: "VIEW" }];
    await assert.rejects(assertTargetAbsent(f.connection, target), HarnessObserverError);
    f.state.schema = true;
    await assert.rejects(assertEmptySchema(f.connection, target.database), HarnessObserverError);
  }
  const f = fixture();
  await assert.rejects(assertEmptySchema(f.connection, target.database), HarnessObserverError);
  f.state.schema = true; await assertEmptySchema(f.connection, target.database);
});

test("OFFLINE target guard rejects app/profile/injection identities before SQL", async () => {
  for (const altered of [{ database: "crm_local_dev" }, { database: target.database + "'" }, { runtimeUser: target.migrationUser },
    { fixtureUser: "root" }, { migrationUser: "crm_m_" + "1".repeat(24) }]) {
    const f = fixture();
    await assert.rejects(provisionTarget(f.connection, { ...target, ...altered }, passwords), HarnessObserverError);
    assert.equal(f.calls.length, 0);
  }
  for (const runtime of ["", "r".repeat(63), "r".repeat(63) + "'", "r".repeat(63) + "\\", passwords.fixture]) {
    const f = fixture(); await assert.rejects(provisionTarget(f.connection, target, { ...passwords, runtime }), HarnessObserverError);
    assert.equal(f.calls.length, 0);
  }
});

test("OFFLINE additive provision defers table grants until schema exists and refuses reuse", async () => {
  const f = fixture(); await provisionTarget(f.connection, target, passwords);
  assert.equal(f.calls.filter(call => call.mutation).length, 6);
  for (const call of f.calls.filter(call => call.mutation)) assert.doesNotMatch(call.sql, /DROP|TRUNCATE|^ALTER|IF NOT EXISTS|ON \*\.\*|WITH GRANT OPTION/u);
  assert.equal(f.calls.filter(call => call.sql.includes(",ALTER,")).length, 1);
  assert.ok(f.calls.find(call => call.sql.includes(",ALTER,"))!.sql.endsWith(`TO '${target.migrationUser}'@'127.0.0.1'`));
  await assertScopedAccounts(f.connection, target, "provisioned");
  await assert.rejects(assertScopedAccounts(f.connection, target), HarnessObserverError);
  await assert.rejects(grantRuntimePrivileges(f.connection, target), HarnessObserverError);
  f.state.objects = Object.keys(mysqlRuntimePrivileges).map(TABLE_NAME => ({ TABLE_NAME, TABLE_TYPE: "BASE TABLE" }));
  await grantRuntimePrivileges(f.connection, target);
  assert.equal(f.tableGrants.get(target.runtimeUser)?.length, Object.keys(mysqlRuntimePrivileges).length);
  await assert.rejects(grantRuntimePrivileges(f.connection, target), HarnessObserverError);
  await assert.rejects(provisionTarget(f.connection, target, passwords), HarnessObserverError);
});

test("OFFLINE DDL failure is opaque, retains partial schema/accounts and never rolls back or retries", async () => {
  for (const failMutation of [1, 2, 3, 4, 5, 6]) {
    const f = fixture(); f.state.failMutation = failMutation;
    await assert.rejects(provisionTarget(f.connection, target, passwords), error => error instanceof HarnessObserverError
      && !error.message.includes("Private") && Object.keys(error).length === 0);
    assert.equal(f.state.schema, failMutation > 1);
    const before = f.calls.length;
    await assert.rejects(provisionTarget(f.connection, target, passwords), HarnessObserverError);
    await assert.rejects(grantRuntimePrivileges(f.connection, target), HarnessObserverError);
    assert.equal(f.calls.length, before);
  }
});

test("OFFLINE provision captures target and generated credentials before asynchronous inspection", async () => {
  const f = fixture(), mutableTarget = { ...target }, mutableSecrets = { ...passwords };
  const pending = provisionTarget(f.connection, mutableTarget, mutableSecrets);
  mutableTarget.database = "crm_local_dev";
  mutableTarget.runtimeUser = "root";
  mutableSecrets.runtime = "invalid-unapproved-override";
  await pending;
  assert.equal(f.calls.some(call => call.mutation && call.sql.includes("invalid-unapproved-override")), false);
  assert.equal(f.calls.some(call => call.mutation && call.sql.includes("crm_local_dev")), false);
  assert.equal(f.accounts.has(target.runtimeUser), true);
});

test("OFFLINE complete privilege inventory accepts only current CRM tables and separate exact schema scopes", async () => {
  const f = fixture(); f.prepareAccounts(); await assertScopedAccounts(f.connection, target);
  for (const table of ["mysql.user", "mysql.db", "mysql.tables_priv", "mysql.columns_priv", "mysql.procs_priv", "mysql.global_grants",
    "mysql.role_edges", "mysql.default_roles", "mysql.proxies_priv"]) assert.equal(f.calls.some(call => call.sql.includes(`FROM ${table}`)), true);
  for (const call of f.calls.filter(call => call.sql.includes("FROM mysql.") && !call.values.includes("root"))) {
    assert.equal(call.values.some(value => [target.runtimeUser, target.migrationUser, target.fixtureUser].includes(String(value))), true);
  }
});

test("OFFLINE inventory rejects extra global/dynamic/role/proxy/column/routine/delegation/host privileges", async () => {
  for (const extra of ["mysql.global_grants", "mysql.proxies_priv", "mysql.role_edges", "mysql.default_roles", "mysql.columns_priv", "mysql.procs_priv"]) {
    const f = fixture(); f.prepareAccounts(); f.state.extra = extra;
    await assert.rejects(assertScopedAccounts(f.connection, target), HarnessObserverError);
  }
  for (const extraGlobal of ["Select_priv", "Grant_priv", "Create_user_priv", "Create_role_priv", "Super_priv"]) {
    const f = fixture(); f.prepareAccounts(); f.state.extraGlobal = extraGlobal;
    await assert.rejects(assertScopedAccounts(f.connection, target), HarnessObserverError);
  }
  const f = fixture(); f.prepareAccounts(); f.state.otherHost = true;
  await assert.rejects(assertScopedAccounts(f.connection, target), HarnessObserverError);
});

test("OFFLINE inventory rejects schema-wide runtime grants, wildcard scopes, missing grants and column privileges", async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => f.grants.set(target.runtimeUser, [{ Db: target.database, role: "fixture" }]),
    f => { f.grants.get(target.migrationUser)![0]!.Db = "crm_local_%"; },
    f => { f.grants.get(target.fixtureUser)![0]!.Drop_priv = "Y"; },
    f => { f.tableGrants.get(target.runtimeUser)!.pop(); },
    f => { f.tableGrants.get(target.runtimeUser)![0]!.Table_priv = "Select,Grant"; },
    f => { f.tableGrants.get(target.runtimeUser)![0]!.Column_priv = "Select"; },
    f => { f.tableGrants.get(target.runtimeUser)![0]!.Db = "crm_local_dev"; },
    f => { f.tableGrants.get(target.runtimeUser)!.push({ ...f.tableGrants.get(target.runtimeUser)![0]! }); },
  ];
  for (const change of changes) { const f = fixture(); f.prepareAccounts(); change(f); await assert.rejects(assertScopedAccounts(f.connection, target), HarnessObserverError); }
});

test("OFFLINE observer fails closed on private driver failures and uncertain runtime grant cannot retry", async () => {
  const f = fixture(); f.state.failRead = "mysql.user";
  await assert.rejects(observeOperator(f.connection, "root"), error => error instanceof HarnessObserverError && !error.message.includes("Private"));
  const other = fixture(); other.prepareAccounts();
  await assert.rejects(grantRuntimePrivileges(other.connection, target), HarnessObserverError);
  assert.equal(other.calls.length, 0);
  const owned = fixture(); await provisionTarget(owned.connection, target, passwords);
  owned.state.objects = Object.keys(mysqlRuntimePrivileges).map(TABLE_NAME => ({ TABLE_NAME, TABLE_TYPE: "BASE TABLE" }));
  owned.state.failMutation = 8;
  await assert.rejects(grantRuntimePrivileges(owned.connection, target), HarnessObserverError);
  assert.equal(owned.tableGrants.get(target.runtimeUser)?.length, 1);
  const before = owned.calls.length;
  await assert.rejects(grantRuntimePrivileges(owned.connection, target), HarnessObserverError);
  assert.equal(owned.calls.length, before);
});
