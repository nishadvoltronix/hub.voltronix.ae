/** OFFLINE only: fixture SQL contract and ownership safety use a private wire
 * double. These tests do not call the live cases or verify real MySQL behavior. */
import assert from "node:assert/strict";
import test from "node:test";
import { compare } from "bcryptjs";
import { cleanupSyntheticFixture, createOwnedAuthDatabase, createSyntheticFixture, runAuthCases, type SyntheticFixture } from "../scripts/mysql-auth/cases.js";
import type { MysqlAuthConfig } from "../src/db/mysql/config.js";
import type { MysqlAuthWireConnection } from "../src/db/mysql/driver.js";
import { mysqlExpectedTables } from "../src/db/mysql/schema.js";

const fixtureId = "123456781234423482341234567890ab";
const database = `crm_local_auth_${fixtureId}`;
type Row = Record<string, unknown>;
const config: MysqlAuthConfig = { provider: "mysql", environment: "test", host: "127.0.0.1", port: 3308,
  database, user: "auth_r_synthetic", password: "test-only-not-a-real-credential" };

function fake() {
  const tables = new Map<string, Row[]>(mysqlExpectedTables.map(name => [name, name === "crm_app_lock" ? [{ id: "1" }] : []]));
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  let selectedDatabase = database, failInsert = false, failCommit = false, failDelete = false;
  let begun = 0, commits = 0, rollbacks = 0, destroyed = 0, next = 1;
  let snapshot: Map<string, Row[]> | undefined;
  const mutate = () => [{ affectedRows: 1, warningStatus: 0 }, []] as [unknown, unknown];
  const wire: MysqlAuthWireConnection = {
    async execute(sql, values = []) {
      calls.push({ sql, values: [...values] });
      if (sql === "SELECT DATABASE() AS selected_database") return [[{ selected_database: selectedDatabase }], []];
      if (sql === "SELECT id FROM crm_app_lock WHERE id=1 FOR UPDATE") return [[{ id: "1" }], []];
      const counting = /^SELECT COUNT\(\*\) AS total FROM `([a-z_]+)`$/.exec(sql);
      if (counting) return [[{ total: String(tables.get(counting[1]!)!.length) }], []];
      const range = /^SELECT 1 AS present FROM `([a-z_]+)` FOR UPDATE$/.exec(sql);
      if (range) return [tables.get(range[1]!)!.map(() => ({ present: 1 })), []];
      if (sql.startsWith("INSERT INTO ")) {
        if (failInsert) throw new Error("synthetic private wire error");
        const numericId = String(next++);
        if (sql.startsWith("INSERT INTO users(")) tables.get("users")!.push({ id: numericId, user_id: values[0], username: values[1],
          email: values[2], password: values[3], status: "active", role: "fixture-nonadmin", version: "1" });
        else if (sql.startsWith("INSERT INTO permissions(")) tables.get("permissions")!.push({ id: numericId, key: values[0], label: values[1], group_id: null, version: "1" });
        else if (sql.startsWith("INSERT INTO admin_user_permissions(")) tables.get("admin_user_permissions")!.push({ id: numericId, admin_user_id: values[0], permission_id: values[1] });
        else throw new Error("Unrecognized fake INSERT");
        return mutate();
      }
      if (sql.startsWith("SELECT * FROM users WHERE")) return [structuredClone(tables.get("users")!.filter(row => row.user_id === values[0] && row.email === values[1] && row.username === values[2])), []];
      if (sql.startsWith("SELECT * FROM permissions WHERE")) return [structuredClone(tables.get("permissions")!.filter(row => row.key === values[0] && row.label === values[1])), []];
      if (sql.startsWith("SELECT * FROM admin_user_permissions WHERE")) return [structuredClone(tables.get("admin_user_permissions")!.filter(row => row.admin_user_id === values[0] && row.permission_id === values[1])), []];
      const all = /^SELECT \* FROM ([a-z_]+) ORDER BY id(?: FOR UPDATE)?$/.exec(sql);
      if (all) return [structuredClone(tables.get(all[1]!)!), []];
      if (sql.startsWith("SELECT token_hash,")) return [structuredClone(tables.get("crm_sessions")!), []];
      if (sql.startsWith("SELECT bucket,")) return [structuredClone(tables.get("crm_login_attempts")!), []];
      const deleting = /^DELETE FROM ([a-z_]+) WHERE /.exec(sql);
      if (deleting) {
        if (failDelete) throw new Error("synthetic private delete error");
        const table = deleting[1]!;
        const key = table === "crm_sessions" ? "token_hash" : table === "crm_login_attempts" ? "bucket" : "id";
        const current = tables.get(table)!, found = current.findIndex(row => String(row[key]) === String(values[0]));
        if (found < 0) return [{ affectedRows: 0, warningStatus: 0 }, []];
        current.splice(found, 1); return mutate();
      }
      throw new Error("Unrecognized fake SQL");
    },
    async query(sql) {
      calls.push({ sql, values: [] });
      if (sql === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ") return [[], []];
      throw new Error("No fake live schema/driver verification");
    },
    async beginTransaction() { begun++; snapshot = structuredClone(tables); },
    async commit() { commits++; if (failCommit) throw new Error("synthetic unknown commit"); snapshot = undefined; },
    async rollback() { rollbacks++; if (snapshot) { tables.clear(); for (const [key, value] of snapshot) tables.set(key, value); } },
    async end() {}, destroy() { destroyed++; },
  };
  return { wire, tables, calls, state: () => ({ begun, commits, rollbacks, destroyed }),
    selected: (value: string) => { selectedDatabase = value; },
    failInsert: () => { failInsert = true; }, failCommit: () => { failCommit = true; }, failDelete: () => { failDelete = true; } };
}
function noDeletes(f: ReturnType<typeof fake>) { assert.equal(f.calls.some(call => /^DELETE|DROP|TRUNCATE/.test(call.sql)), false); }
function safeError(error: unknown): boolean { return error instanceof Error && error.message === "Synthetic authentication fixture refused; preserve the isolated target for review."; }

test("offline fixture rejects malformed UUID before issuing any wire command", async () => {
  const f = fake(); await assert.rejects(createSyntheticFixture(f.wire, "not-approved"), safeError); assert.equal(f.calls.length, 0);
});
test("offline fixture refuses another selected schema before transaction or writes", async () => {
  const f = fake(); f.selected("crm_local_dev"); await assert.rejects(createSyntheticFixture(f.wire, fixtureId), safeError);
  assert.equal(f.state().begun, 0); assert.equal(f.calls.length, 1);
});
test("offline fixture requires every application table empty, including unrelated CRM rows", async () => {
  const f = fake(); f.tables.get("products")!.push({ product_id: "unapproved" });
  await assert.rejects(createSyntheticFixture(f.wire, fixtureId), safeError);
  assert.equal(f.calls.some(call => call.sql.startsWith("INSERT")), false); assert.equal(f.state().rollbacks, 1);
});
test("offline fixture refuses existing permissions instead of adopting or overwriting them", async () => {
  const f = fake(); f.tables.get("permissions")!.push({ id: "1", key: "dashboard.view" });
  await assert.rejects(createSyntheticFixture(f.wire, fixtureId), safeError); noDeletes(f);
  assert.equal(f.calls.some(call => call.sql.startsWith("INSERT")), false);
});
test("offline fixture binds seven marked nonadmin accounts with real bcrypt and private random password", async () => {
  const f = fake(), fixture = await createSyntheticFixture(f.wire, fixtureId);
  assert.equal(f.tables.get("users")!.length, 7); assert.equal(f.tables.get("admin_user_permissions")!.length, 2);
  assert.equal(f.tables.get("permissions")!.length, 1);
  for (const row of f.tables.get("users")!) {
    assert.equal(row.role, "fixture-nonadmin");
    assert.equal(String(row.user_id).startsWith(`auth-fixture:${fixtureId}:`), true);
    assert.equal(String(row.email).endsWith("@example.invalid"), true);
    assert.equal(await compare(fixture.password, String(row.password)), true);
  }
  assert.equal(f.calls.some(call => call.sql.includes(fixture.password) || call.values.includes(fixture.password)), false);
  assert.equal(f.calls.some(call => /CREATE|ALTER|DROP|TRUNCATE|FOREIGN_KEY_CHECKS/.test(call.sql)), false);
  assert.equal(f.state().commits, 1);
});
test("offline fixture insertion failure rolls back without exposing a driver error or capability", async () => {
  const f = fake(); f.failInsert(); await assert.rejects(createSyntheticFixture(f.wire, fixtureId), safeError);
  assert.equal(f.state().rollbacks, 1); assert.equal(f.state().commits, 0); assert.equal(f.tables.get("users")!.length, 0); noDeletes(f);
});
test("offline fixture uncertain commit is retained, destroyed and never automatically rolled back or retried", async () => {
  const f = fake(); f.failCommit(); await assert.rejects(createSyntheticFixture(f.wire, fixtureId), safeError);
  assert.equal(f.state().commits, 1); assert.equal(f.state().rollbacks, 0); assert.equal(f.state().destroyed, 1);
  assert.equal(f.tables.get("users")!.length, 7); noDeletes(f);
});
test("offline cleanup rejects copied or invented fixture capability before any wire command", async () => {
  const f = fake(), fixture = await createSyntheticFixture(f.wire, fixtureId), before = f.calls.length;
  await assert.rejects(cleanupSyntheticFixture(f.wire, { ...fixture }), safeError); assert.equal(f.calls.length, before);
});
test("offline cleanup refuses any unknown user before deleting owned records", async () => {
  const f = fake(), fixture = await createSyntheticFixture(f.wire, fixtureId);
  f.tables.get("users")!.push({ id: "999", username: "unapproved" });
  await assert.rejects(cleanupSyntheticFixture(f.wire, fixture), safeError); noDeletes(f);
});
test("offline cleanup refuses changed ownership markers without deleting anything", async () => {
  const f = fake(), fixture = await createSyntheticFixture(f.wire, fixtureId);
  f.tables.get("users")![0]!.username = "different-owner";
  await assert.rejects(cleanupSyntheticFixture(f.wire, fixture), safeError); noDeletes(f);
});
test("offline cleanup refuses unrelated business rows without cascading user deletion", async () => {
  const f = fake(), fixture = await createSyntheticFixture(f.wire, fixtureId);
  f.tables.get("tasks")!.push({ id: "1" });
  await assert.rejects(cleanupSyntheticFixture(f.wire, fixture), safeError); noDeletes(f);
});
test("offline cleanup refuses unobserved sessions even when they reference an owned user", async () => {
  const f = fake(), fixture = await createSyntheticFixture(f.wire, fixtureId);
  f.tables.get("crm_sessions")!.push({ token_hash: "a".repeat(64), user_id: fixture.allowed.id });
  await assert.rejects(cleanupSyntheticFixture(f.wire, fixture), safeError); noDeletes(f);
});
test("offline cleanup refuses unobserved throttle buckets", async () => {
  const f = fake(), fixture = await createSyntheticFixture(f.wire, fixtureId);
  f.tables.get("crm_login_attempts")!.push({ bucket: "account:unapproved", window_start: "1", attempts: 1 });
  await assert.rejects(cleanupSyntheticFixture(f.wire, fixture), safeError); noDeletes(f);
});
test("offline cleanup deletes only exact owned rows and consumes its single-run capability", async () => {
  const f = fake(), fixture = await createSyntheticFixture(f.wire, fixtureId);
  const result = await cleanupSyntheticFixture(f.wire, fixture);
  assert.equal(result.deletedRows, 10); assert.equal(f.tables.get("users")!.length, 0);
  assert.equal(f.tables.get("crm_app_lock")!.length, 1);
  assert.equal(f.calls.filter(call => call.sql.startsWith("DELETE")).every(call => call.sql.includes(" WHERE ") && call.values.length >= 3), true);
  const before = f.calls.length; await assert.rejects(cleanupSyntheticFixture(f.wire, fixture), safeError); assert.equal(f.calls.length, before);
});
test("offline cleanup range-locks every application table under explicit RR before deletion and checks final counts", async () => {
  const f = fake(), fixture = await createSyntheticFixture(f.wire, fixtureId), before = f.calls.length;
  await cleanupSyntheticFixture(f.wire, fixture);
  const cleanup = f.calls.slice(before), firstDelete = cleanup.findIndex(call => call.sql.startsWith("DELETE"));
  const isolation = cleanup.findIndex(call => call.sql === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  const locked = cleanup.slice(0, firstDelete).filter(call => call.sql.endsWith(" FOR UPDATE"));
  // 27 complete table scans plus the initial singleton technical lock.
  assert.equal(isolation > 0 && isolation < firstDelete, true); assert.equal(locked.length, 28);
  assert.equal(cleanup.slice(firstDelete).filter(call => call.sql.startsWith("SELECT COUNT(*)")).length, 27);
});
test("offline cleanup checks selected target again before starting a transaction", async () => {
  const f = fake(), fixture = await createSyntheticFixture(f.wire, fixtureId); f.selected("other_schema");
  await assert.rejects(cleanupSyntheticFixture(f.wire, fixture), safeError); noDeletes(f); assert.equal(f.state().begun, 1);
});
test("offline cleanup statement failure rolls back owned DML and preserves capability for explicit review", async () => {
  const f = fake(), fixture = await createSyntheticFixture(f.wire, fixtureId); f.failDelete();
  await assert.rejects(cleanupSyntheticFixture(f.wire, fixture), safeError);
  assert.equal(f.state().rollbacks, 1); assert.equal(f.tables.get("users")!.length, 7);
});
test("offline cleanup uncertain commit consumes capability and refuses an automatic second cleanup", async () => {
  const f = fake(), fixture = await createSyntheticFixture(f.wire, fixtureId); f.failCommit();
  await assert.rejects(cleanupSyntheticFixture(f.wire, fixture), safeError);
  assert.equal(f.state().destroyed, 1); assert.equal(f.state().rollbacks, 0);
  const before = f.calls.length; await assert.rejects(cleanupSyntheticFixture(f.wire, fixture), safeError); assert.equal(f.calls.length, before);
});
test("offline owned database rejects application target and foreign fixture before connecting", async () => {
  const f = fake(), fixture = await createSyntheticFixture(f.wire, fixtureId);
  let connections = 0; const connect = async () => { connections++; return f.wire; };
  assert.throws(() => createOwnedAuthDatabase({ ...config, environment: "development", database: "crm_local_dev" }, fixture, { connect }), safeError);
  assert.throws(() => createOwnedAuthDatabase(config, {} as SyntheticFixture, { connect }), safeError);
  assert.equal(connections, 0);
});
test("offline constructing and closing an owned auth database makes no connection", async () => {
  const f = fake(), fixture = await createSyntheticFixture(f.wire, fixtureId);
  let connections = 0;
  const owned = createOwnedAuthDatabase(config, fixture, { connect: async () => { connections++; return f.wire; } });
  await owned.close(); assert.equal(connections, 0);
});
test("offline live-case orchestration fails closed on injected unavailable connector without recording a pass", async () => {
  const f = fake(), fixture = await createSyntheticFixture(f.wire, fixtureId);
  let connections = 0, recorded = 0;
  await assert.rejects(runAuthCases({ runtimeConfig: config, fixtureConnection: f.wire, fixture, record: () => { recorded++; } },
    { connect: async () => { connections++; throw new Error("private wire error"); } }),
  error => error instanceof Error && error.message === "MySQL authentication case failed; retained fixture requires review.");
  assert.equal(connections, 1); assert.equal(recorded, 0);
});
