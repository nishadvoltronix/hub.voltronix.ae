import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { compare, hashSync } from "bcryptjs";
import { createAuthService } from "./sqlite-reference/auth/service";
import { configureDatabase, openDatabase } from "./sqlite-reference/db/connection";
import { migrateDatabase, migrations } from "./sqlite-reference/db/migrations";
import { createSettingsService, DEPARTMENTS, SettingsError } from "./sqlite-reference/settings/service";
import { filesystemFixture } from "./database-fixture";

// Only isolated in-memory / temporary filesystem fixtures; never the development CRM.
const testPassword = "Synthetic test password only";
const fixtureHash = hashSync(testPassword, 4);
function user(db: Database.Database, id: number | bigint, name = "Synthetic test account") {
  db.prepare("INSERT INTO users(id,user_id,username,email,password,status) VALUES(?,?,?,?,?,'active')")
    .run(id, `external-${id}`, name, `fixture-${id}@example.invalid`, fixtureHash);
}
function grant(db: Database.Database, id: number | bigint, key: string) {
  db.prepare('INSERT INTO permissions("key",label) VALUES(?,?) ON CONFLICT("key") DO NOTHING').run(key, key);
  db.prepare('INSERT INTO admin_user_permissions(admin_user_id,permission_id) SELECT ?,id FROM permissions WHERE "key"=?').run(id, key);
}
async function fixture(t: TestContext, database?: Database.Database) {
  const db = database ?? new Database(":memory:");
  configureDatabase(db);
  migrateDatabase(db);
  if (!database) t.after(() => db.close());
  for (let id = 1; id <= 5; id++) user(db, id);
  grant(db, 1, "users.write"); grant(db, 1, "permissions.manage");
  grant(db, 2, "users.write"); grant(db, 3, "permissions.manage");
  db.prepare("UPDATE users SET role='admin' WHERE id=4").run();
  const auth = createAuthService(db);
  const tokens: string[] = [];
  for (let id = 1; id <= 5; id++) tokens.push((await auth.login(`fixture-${id}@example.invalid`, testPassword, "fixture")).sessionToken);
  return { db, auth, service: createSettingsService(db), manager: tokens[0]!, usersOnly: tokens[1]!,
    permissionsOnly: tokens[2]!, roleOnly: tokens[3]!, targetToken: tokens[4]! };
}
function status(expected: number) {
  return (error: unknown) => error instanceof SettingsError && error.status === expected;
}
function audits(db: Database.Database) { return db.prepare("SELECT * FROM crm_audit_events ORDER BY id").all(); }

test("migration 2 preserves a version-1 account, identity, hash, grants and tasks without new seeds", () => {
  const db = new Database(":memory:");
  configureDatabase(db);
  try {
    const first = migrations[0];
    db.exec(`CREATE TABLE crm_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP) STRICT`);
    db.exec(first.sql);
    db.prepare("INSERT INTO crm_schema_migrations(version,name,checksum) VALUES(?,?,?)")
      .run(first.version, first.name, createHash("sha256").update(first.sql).digest("hex"));
    user(db, 1); grant(db, 1, "users.write");
    db.prepare("INSERT INTO tasks(assigned_to,deal_name,status) VALUES('external-1','Synthetic migration fixture','Qualification')").run();
    const before = db.prepare("SELECT id,user_id,username,email,password,status FROM users").get();
    assert.equal(migrateDatabase(db), migrations.length - 1);
    assert.deepEqual(db.prepare("SELECT id,user_id,username,email,password,status FROM users").get(), before);
    assert.deepEqual(db.prepare("SELECT version,grants_version,department_assigned_by FROM users").get(),
      { version: 1, grants_version: 1, department_assigned_by: null });
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM admin_user_permissions").get() as { n: number }).n, 1);
    assert.equal(audits(db).length, 0);
    assert.equal(migrateDatabase(db), 0);
  } finally { db.close(); }
});

test("every user operation requires both live grants before validating input; role is never a bypass", async (t) => {
  const f = await fixture(t), s = f.service;
  const calls = (token: string | null): Array<() => unknown | Promise<unknown>> => [
    () => s.listUsers(token, { unexpected: true }), () => s.getUser(token, "bad"),
    () => s.createUser(token, {}), () => s.updateUser(token, "bad", {}),
    () => s.setUserStatus(token, "bad", {}), () => s.assignDepartment(token, "bad", {}),
  ];
  for (const [token, expected] of [[null, 401], [f.usersOnly, 403], [f.permissionsOnly, 403], [f.roleOnly, 403]] as const) {
    for (const call of calls(token)) await assert.rejects(Promise.resolve().then(call), status(expected));
  }
  assert.equal(audits(f.db).length, 0);
  const result = s.listUsers(f.manager);
  assert.equal(result.total, 5);
  assert.equal(JSON.stringify(result).includes("password"), false);
  assert.equal(JSON.stringify(result).includes("token"), false);
  f.db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=1").run();
  assert.throws(() => s.listUsers(f.manager), status(403));
});

test("catalogue and grants operations require permissions.manage independently; all fail closed before validation", async (t) => {
  const f = await fixture(t), s = f.service;
  const calls = (token: string | null): Array<() => unknown | Promise<unknown>> => [
    () => s.listGroups(token, { unexpected: true }), () => s.getGroup(token, "bad"),
    () => s.createGroup(token, {}), () => s.updateGroup(token, "bad", {}),
    () => s.listPermissions(token, { unexpected: true }), () => s.getPermission(token, "bad"),
    () => s.createPermission(token, {}), () => s.updatePermission(token, "bad", {}),
    () => s.listGrantUsers(token, { unexpected: true }), () => s.getGrants(token, "bad"),
    () => s.replaceGrants(token, "bad", {}),
  ];
  for (const [token, expected] of [[null, 401], [f.usersOnly, 403], [f.roleOnly, 403]] as const) {
    for (const call of calls(token)) await assert.rejects(Promise.resolve().then(call), status(expected));
  }
  const group = s.createGroup(f.permissionsOnly, { key: "Fixture_Group-1", label: "Fixture group", sortOrder: 2 });
  const permission = s.createPermission(f.permissionsOnly, { key: "fixture.custom", label: "Fixture permission", groupId: group.id });
  assert.equal(s.listGroups(f.permissionsOnly).items[0]?.id, group.id);
  assert.equal(s.getPermission(f.permissionsOnly, permission.id).key, "fixture.custom");
  assert.equal(s.listGrantUsers(f.permissionsOnly).total, 5);
  assert.equal(s.getGrants(f.permissionsOnly, "5").user.id, "5");
});

test("user create and edits preserve external identity, hash passwords, reject conflicts and stale updates, and audit only field names", async (t) => {
  const f = await fixture(t), s = f.service;
  const input = { name: "Private synthetic display name", email: "NEW@example.invalid", password: testPassword, status: "active" };
  const created = await s.createUser(f.manager, input);
  assert.equal(created.email, "new@example.invalid");
  assert.equal(created.externalUserId, null);
  assert.equal(created.version, 1);
  const stored = f.db.prepare("SELECT password FROM users WHERE id=?").get(created.id) as { password: string };
  assert.match(stored.password, /^\$2b\$12\$/);
  assert.equal(await compare(testPassword, stored.password), true);
  assert.equal(JSON.stringify(created).includes(stored.password), false);
  await assert.rejects(s.createUser(f.manager, input), status(409));
  const updated = await s.updateUser(f.manager, "5", { name: "Changed synthetic name", email: "fixture-5@example.invalid", status: "active", version: 1 });
  assert.equal(updated.externalUserId, "external-5");
  assert.equal(updated.version, 2);
  assert.equal(f.auth.authenticate(f.targetToken)?.localUserId, "5", "name-only edits keep session");
  assert.equal((f.db.prepare("SELECT password FROM users WHERE id=5").get() as { password: string }).password, fixtureHash);
  await assert.rejects(s.updateUser(f.manager, "5", { name: "Stale name", email: "fixture-5@example.invalid", status: "active", version: 1 }), status(409));
  await assert.rejects(s.updateUser(f.manager, "5", { name: "Collision", email: "fixture-1@example.invalid", status: "active", version: 2 }), status(409));
  assert.equal(s.getUser(f.manager, "5").name, "Changed synthetic name");
  const serialized = JSON.stringify(audits(f.db));
  for (const secret of [input.name, input.email, input.email.toLowerCase(), input.password, stored.password, fixtureHash, f.manager, "Changed synthetic name"]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(audits(f.db).length, 2);
  assert.equal(Object.keys(s).some((name) => /^delete/.test(name)), false, "no source-absent deletion capability");
});

test("email, password and status changes revoke target sessions atomically and never revive on reactivation", async (t) => {
  const f = await fixture(t), s = f.service;
  let target = await s.updateUser(f.manager, "5", { name: "Synthetic test account", email: "changed@example.invalid", status: "active", version: 1 });
  assert.equal(f.auth.authenticate(f.targetToken), null);
  const second = await f.auth.login("changed@example.invalid", testPassword, "fixture");
  target = await s.updateUser(f.manager, "5", { name: target.name, email: target.email, status: target.status,
    version: target.version, password: "Different synthetic password" });
  assert.equal(f.auth.authenticate(second.sessionToken), null);
  const third = await f.auth.login(target.email, "Different synthetic password", "fixture");
  target = s.setUserStatus(f.manager, "5", { version: target.version, status: "inactive" });
  assert.equal(f.auth.authenticate(third.sessionToken), null);
  s.setUserStatus(f.manager, "5", { version: target.version, status: "active" });
  assert.equal(f.auth.authenticate(third.sessionToken), null);
  assert.equal(f.auth.authenticate(f.manager)?.localUserId, "1");
});

test("department assignment accepts exactly the seven source options and records the server actor", async (t) => {
  const f = await fixture(t), s = f.service;
  let target = s.getUser(f.manager, "5");
  for (const departmentRole of DEPARTMENTS) {
    target = s.assignDepartment(f.manager, "5", { version: target.version, departmentRole });
    assert.equal(target.departmentRole, departmentRole);
    assert.equal(target.departmentAssignedBy, "1");
    assert.match(target.departmentAssignedAt!, /^\d{4}-\d{2}-\d{2} /);
  }
  for (const input of [
    { version: target.version, departmentRole: "Invented" },
    { version: target.version, departmentRole: "" },
    { version: target.version, departmentRole: "Civil", departmentAssignedBy: "4" },
  ]) assert.throws(() => s.assignDepartment(f.manager, "5", input), status(400));
  assert.throws(() => s.assignDepartment(f.manager, "5", { version: 1, departmentRole: "Civil" }), status(409));
  assert.equal(s.getUser(f.manager, "5").departmentRole, "Operations");
  assert.equal(audits(f.db).length, DEPARTMENTS.length);
});

test("permission groups and catalogue support create/read/update with immutable keys and real group references", async (t) => {
  const f = await fixture(t), s = f.service;
  const group = s.createGroup(f.manager, { key: "First_Group-1", label: "First test group", sortOrder: 2 });
  const other = s.createGroup(f.manager, { key: "second", label: "Second test group", sortOrder: -1 });
  assert.equal(s.listGroups(f.manager).items[0]?.id, other.id);
  const changedGroup = s.updateGroup(f.manager, group.id, { label: "Renamed group", sortOrder: 0, version: 1 });
  assert.equal(changedGroup.version, 2);
  assert.equal(changedGroup.key, "First_Group-1");
  assert.throws(() => s.updateGroup(f.manager, group.id, { key: "changed", label: "Bad", sortOrder: 0, version: 2 }), status(400));
  assert.throws(() => s.updateGroup(f.manager, group.id, { label: "Stale", sortOrder: 0, version: 1 }), status(409));
  assert.throws(() => s.createGroup(f.manager, { key: group.key, label: "Duplicate", sortOrder: 0 }), status(409));
  assert.throws(() => s.createGroup(f.manager, { key: "bad.key", label: "Bad", sortOrder: 0 }), status(400));
  const permission = s.createPermission(f.manager, { key: "fixture.read-only", label: "Fixture read", groupId: group.id });
  const changedPermission = s.updatePermission(f.manager, permission.id, { label: "Fixture renamed", groupId: other.id, version: 1 });
  assert.equal(changedPermission.key, permission.key);
  assert.equal(changedPermission.groupId, other.id);
  assert.equal(changedPermission.groupLabel, other.label);
  assert.equal(s.listPermissions(f.manager, { query: "fixture.read-only" }).items[0]?.id, permission.id);
  assert.throws(() => s.updatePermission(f.manager, permission.id, { key: "changed", label: "Bad", groupId: group.id, version: 2 }), status(400));
  assert.throws(() => s.updatePermission(f.manager, permission.id, { label: "Stale", groupId: group.id, version: 1 }), status(409));
  assert.throws(() => s.createPermission(f.manager, { key: permission.key, label: "Duplicate", groupId: group.id }), status(409));
  assert.throws(() => s.createPermission(f.manager, { key: "Invalid.Case", label: "Bad", groupId: group.id }), status(400));
  assert.throws(() => s.createPermission(f.manager, { key: "fixture.missing", label: "Bad", groupId: "999" }), status(404));
  assert.throws(() => s.getGroup(f.manager, "999"), status(404));
  assert.throws(() => s.getPermission(f.manager, "999"), status(404));
});

test("explicit permission replacement removes grants, rejects stale/duplicate/missing IDs, and custom keys confer no invented capabilities", async (t) => {
  const f = await fixture(t), s = f.service;
  const group = s.createGroup(f.manager, { key: "test", label: "Test", sortOrder: 0 });
  const custom = s.createPermission(f.manager, { key: "admin.superuser", label: "Synthetic custom metadata", groupId: group.id });
  const known = s.listPermissions(f.manager).items.find((item) => item.key === "users.write")!;
  let result = s.replaceGrants(f.manager, "5", { version: 1, permissionIds: [custom.id, known.id] });
  assert.equal(result.version, 2);
  assert.deepEqual(new Set(f.auth.authenticate(f.targetToken)?.permissions), new Set(["admin.superuser", "users.write"]));
  assert.throws(() => s.listUsers(f.targetToken), status(403));
  assert.throws(() => s.getGrants(f.targetToken, "5"), status(403));
  const before = audits(f.db).length;
  assert.throws(() => s.replaceGrants(f.manager, "5", { version: 1, permissionIds: [] }), status(409));
  assert.throws(() => s.replaceGrants(f.manager, "5", { version: 2, permissionIds: [custom.id, custom.id] }), status(400));
  assert.throws(() => s.replaceGrants(f.manager, "5", { version: 2, permissionIds: ["999"] }), status(404));
  assert.equal(audits(f.db).length, before);
  assert.deepEqual(s.getGrants(f.manager, "5"), result);
  result = s.replaceGrants(f.manager, "5", { version: 2, permissionIds: [] });
  assert.deepEqual(result.permissionIds, []);
  assert.deepEqual(f.auth.authenticate(f.targetToken)?.permissions, []);
  // Self-revocation is allowed by the source, but the next operation must fail closed.
  s.replaceGrants(f.manager, "1", { version: 1, permissionIds: [] });
  assert.throws(() => s.listGroups(f.manager), status(403));
});

test("search treats wildcard and SQL syntax literally, pages are stable and limits/input are strict", async (t) => {
  const f = await fixture(t), s = f.service;
  f.db.prepare("UPDATE users SET username=? WHERE id=5").run("Literal % _ \\ fixture");
  for (const query of ["%", "_", "\\"]) assert.deepEqual(s.listUsers(f.manager, { query }).items.map((row) => row.id), ["5"]);
  assert.equal(s.listUsers(f.manager, { query: "' OR 1=1 --" }).total, 0);
  assert.deepEqual(s.listUsers(f.manager, { page: 2, pageSize: 2 }).items.map((row) => row.id), ["3", "4"]);
  assert.deepEqual(s.listGrantUsers(f.manager, { query: "_" }).items.map((row) => row.id), ["5"]);
  const group = s.createGroup(f.manager, { key: "literal", label: "100% _ \\ test", sortOrder: 0 });
  const permission = s.createPermission(f.manager, { key: "fixture.literal", label: "100% _ \\ test", groupId: group.id });
  for (const query of ["%", "_", "\\"]) {
    assert.equal(s.listGroups(f.manager, { query }).items[0]?.id, group.id);
    assert.equal(s.listPermissions(f.manager, { query }).items[0]?.id, permission.id);
  }
  for (const input of [{ page: 0 }, { page: "1" }, { page: 1.5 }, { pageSize: 101 }, { query: "\0" }, { status: "active" }]) {
    assert.throws(() => s.listUsers(f.manager, input), status(400));
  }
  assert.throws(() => s.getUser(f.manager, "1 OR 1=1"), status(400));
  assert.throws(() => s.getUser(f.manager, "9223372036854775808"), status(400));
  assert.throws(() => s.getUser(f.manager, "999"), status(404));
  for (const password of ["short", "🙂".repeat(19), "a".repeat(73), "a".repeat(12) + "\0"]) {
    await assert.rejects(s.createUser(f.manager, { name: "Test", email: "bad@example.invalid", status: "active", password }), status(400));
  }
  await assert.rejects(s.createUser(f.manager, { name: "Test", email: "bad@example.invalid", status: "active", password: testPassword, role: "admin" }), status(400));
  await assert.rejects(s.updateUser(f.manager, "5", { name: "Test", email: "bad@example.invalid", status: "active", version: 1, externalUserId: "invented" }), status(400));
});

test("audit failure rolls back account changes, versions and session revocation; stored audit rows reject mutation", async (t) => {
  const f = await fixture(t), s = f.service;
  s.createGroup(f.manager, { key: "audit_test", label: "Synthetic audit test", sortOrder: 0 });
  assert.throws(() => f.db.prepare("UPDATE crm_audit_events SET changed_fields='[]'").run(), /immutable/);
  assert.throws(() => f.db.prepare("DELETE FROM crm_audit_events").run(), /immutable/);
  const before = s.getUser(f.manager, "5");
  f.db.exec("CREATE TRIGGER fixture_reject_audit BEFORE INSERT ON crm_audit_events BEGIN SELECT RAISE(ABORT,'private trigger detail'); END");
  await assert.rejects(s.updateUser(f.manager, "5", { name: "Changed", email: "changed@example.invalid", status: "inactive", version: 1 }),
    (error: unknown) => status(503)(error) && !(error as Error).message.includes("private"));
  assert.deepEqual(s.getUser(f.manager, "5"), before);
  assert.equal(f.auth.authenticate(f.targetToken)?.localUserId, "5");
  assert.throws(() => s.replaceGrants(f.manager, "5", { version: 1, permissionIds: ["1"] }), status(503));
  assert.deepEqual(s.getGrants(f.manager, "5").permissionIds, []);
  assert.equal(s.getGrants(f.manager, "5").version, 1);
  assert.equal(audits(f.db).length, 1);
});

test("bcrypt yielding cannot preserve revoked actor privileges or overwrite an intervening account update", async (t) => {
  const f = await fixture(t), s = f.service;
  const pendingCreate = s.createUser(f.manager, { name: "Concurrent fixture", email: "concurrent@example.invalid", status: "active", password: testPassword });
  f.db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=1").run();
  await assert.rejects(pendingCreate, status(403));
  assert.equal(f.db.prepare("SELECT id FROM users WHERE email='concurrent@example.invalid'").get(), undefined);
  assert.equal(audits(f.db).length, 0);
  grant(f.db, 1, "users.write"); grant(f.db, 1, "permissions.manage");
  const pendingUpdate = s.updateUser(f.manager, "5", { name: "Concurrent replacement", email: "fixture-5@example.invalid", status: "active", version: 1, password: testPassword });
  s.assignDepartment(f.manager, "5", { version: 1, departmentRole: "Civil" });
  await assert.rejects(pendingUpdate, status(409));
  assert.equal(s.getUser(f.manager, "5").name, "Synthetic test account");
  assert.equal((f.db.prepare("SELECT password FROM users WHERE id=5").get() as { password: string }).password, fixtureHash);
  assert.equal(audits(f.db).length, 1);
});

test("SQLite int64 identifiers remain exact across settings, grants and audit records", async (t) => {
  const f = await fixture(t), s = f.service;
  const userId = 9_007_199_254_740_993n;
  user(f.db, userId);
  f.db.prepare('INSERT INTO permission_groups(id,"key",label) VALUES(?,?,?)').run(userId, "large_group", "Synthetic large ID");
  f.db.prepare('INSERT INTO permissions(id,"key",label,group_id) VALUES(?,?,?,?)').run(userId, "large.permission", "Synthetic large ID", userId);
  assert.equal(s.getUser(f.manager, String(userId)).id, String(userId));
  assert.equal(s.getPermission(f.manager, String(userId)).groupId, String(userId));
  s.assignDepartment(f.manager, String(userId), { version: 1, departmentRole: "Civil" });
  const assigned = s.replaceGrants(f.manager, String(userId), { version: 1, permissionIds: [String(userId)] });
  assert.deepEqual(assigned.permissionIds, [String(userId)]);
  assert.equal((audits(f.db)[0] as { target_id: string }).target_id, String(userId));
  const group = s.createGroup(f.manager, { key: "following_large", label: "Following large ID", sortOrder: 0 });
  assert.equal(group.id, String(userId + 1n));
});

test("settings, grants and audit history persist when the isolated SQLite file is reopened", async (t) => {
  const filesystem = filesystemFixture();
  const db = openDatabase(filesystem.config, { create: true });
  let closed = false;
  try {
    const f = await fixture(t, db), s = f.service;
    const group = s.createGroup(f.manager, { key: "persistent", label: "Synthetic persistent group", sortOrder: 3 });
    const permission = s.createPermission(f.manager, { key: "fixture.persistence", label: "Synthetic permission", groupId: group.id });
    s.replaceGrants(f.manager, "5", { version: 1, permissionIds: [permission.id] });
    s.assignDepartment(f.manager, "5", { version: 1, departmentRole: "Accounts" });
    db.close(); closed = true;
    const reopened = openDatabase(filesystem.config);
    try {
      const service = createSettingsService(reopened);
      assert.equal(service.getGroup(f.manager, group.id).key, "persistent");
      assert.equal(service.getUser(f.manager, "5").departmentRole, "Accounts");
      assert.deepEqual(service.getGrants(f.manager, "5").permissionIds, [permission.id]);
      assert.equal(audits(reopened).length, 4);
      assert.equal(reopened.pragma("quick_check", { simple: true }), "ok");
      assert.deepEqual(reopened.pragma("foreign_key_check"), []);
    } finally { reopened.close(); }
  } finally { if (!closed) db.close(); filesystem.cleanup(); }
});
