import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { hashSync } from "bcryptjs";
import { createAuthService } from "./sqlite-reference/auth/service";
import { DEPARTMENT_PERMISSIONS } from "./sqlite-reference/auth/permissions";
import { configureDatabase, openDatabase } from "./sqlite-reference/db/connection";
import { migrateDatabase, migrations } from "./sqlite-reference/db/migrations";
import { createDepartmentsService, DepartmentsError } from "./sqlite-reference/departments/service";
import { DEPARTMENTS, LOG_OPTIONS, type Department } from "./sqlite-reference/departments/contracts";
import { filesystemFixture } from "./database-fixture";

const NOW = Date.parse("2026-10-10T11:12:13.000Z");
const password = "Synthetic department test password", passwordHash = hashSync(password, 4);
function user(db: Database.Database, id: number | bigint, role: string | null = null) {
  db.prepare("INSERT INTO users(id,user_id,username,email,password,status,department_role) VALUES(?,?,?,?,?,'active',?)")
    .run(id, `external-${id}`, `Synthetic employee ${id}`, `fixture-${id}@example.invalid`, passwordHash, role);
}
function grant(db: Database.Database, id: number | bigint, permission: string) {
  db.prepare('INSERT INTO permissions("key",label) VALUES(?,?) ON CONFLICT("key") DO NOTHING').run(permission, permission);
  db.prepare('INSERT INTO admin_user_permissions(admin_user_id,permission_id) SELECT ?,id FROM permissions WHERE "key"=?').run(id, permission);
}
function task(db: Database.Database, id: number | bigint, stage = "Close to Won", jobStatus: string | null = "Active", name = `Synthetic job ${id}`) {
  db.prepare("INSERT INTO tasks(id,deal_name,status,Job_Status,account_name,job_deal_number) VALUES(?,?,?,?,?,?)")
    .run(id, name, stage, jobStatus, "Synthetic customer", `JOB-${id}`);
}
function status(code: number) { return (error: unknown) => error instanceof DepartmentsError && error.status === code; }
function auditCount(db: Database.Database) { return (db.prepare("SELECT COUNT(*) AS n FROM crm_department_audit_events").get() as { n: number }).n; }
async function populate(db: Database.Database) {
  user(db, 1); user(db, 2); user(db, 3, "Electrical"); user(db, 4, "Electrical");
  for (const [index, department] of DEPARTMENTS.entries()) { user(db, index + 10, department); grant(db, index + 10, DEPARTMENT_PERMISSIONS[department]); }
  grant(db, 1, "dashboard.view"); grant(db, 3, "electrical.manage"); grant(db, 4, "electrical.manage");
  task(db, 1); task(db, 2, "Closed Won"); task(db, 3, "Qualification");
  const auth = createAuthService(db, { now: () => NOW });
  const signIn = async (id: number | bigint) => (await auth.login(`fixture-${id}@example.invalid`, password, "fixture")).sessionToken;
  return { db, auth, service: createDepartmentsService(db, { now: () => NOW }), signIn,
    manager: await signIn(1), denied: await signIn(2), worker: await signIn(3), other: await signIn(4) };
}
async function fixture(t: TestContext) {
  const db = new Database(":memory:"); configureDatabase(db); migrateDatabase(db); t.after(() => db.close()); return populate(db);
}
function log(department: Department, expectedVersion: number) {
  const choices = LOG_OPTIONS[department];
  return "authority" in choices
    ? { expectedVersion, authority: choices.authority[1], status: choices.status[1], comments: "Synthetic authority comments", notes: "Synthetic work notes" }
    : { expectedVersion, scope: choices.scope[1], status: choices.status[1], notes: "Synthetic work notes" };
}

test("department migration preserves populated assignments, identities, values, deleted high-water ID and foreign keys", () => {
  const db = new Database(":memory:"); configureDatabase(db);
  try {
    db.exec("CREATE TABLE crm_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP) STRICT");
    const migration = migrations.find((m) => m.name === "department_assignments_and_logs");
    assert.ok(migration);
    for (const m of migrations.filter((m) => m.version < migration.version)) {
      db.exec(m.sql); db.prepare("INSERT INTO crm_schema_migrations(version,name,checksum) VALUES(?,?,?)")
        .run(m.version, m.name, createHash("sha256").update(m.sql).digest("hex"));
    }
    user(db, 1); task(db, 1);
    db.prepare("INSERT INTO departments_assign(id,task_id,user_id,department,status,assigned_by,assigned_date,assigned_time,notes) VALUES(7,1,1,'Electrical','Process',1,'old date','old time','old notes')").run();
    db.prepare("INSERT INTO departments_assign(id,task_id,user_id,department) VALUES(100,1,1,'Civil')").run();
    db.prepare("DELETE FROM departments_assign WHERE id=100").run();
    const columns = "id,task_id,user_id,department,status,assigned_by,assigned_date,assigned_time,notes,created_at,updated_at";
    const before = db.prepare(`SELECT ${columns} FROM departments_assign`).all();
    assert.equal(migrateDatabase(db), migrations.length - migration.version + 1);
    assert.deepEqual(db.prepare(`SELECT ${columns} FROM departments_assign`).all(), before);
    const inserted = db.prepare("INSERT INTO departments_assign(task_id,user_id,department,status) VALUES(1,NULL,'Electrical','Unassigned')").run();
    assert.equal(inserted.lastInsertRowid, 101); assert.equal(auditCount(db), 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM crm_department_work_logs").get() as { n: number }).n, 0);
    assert.deepEqual(db.pragma("foreign_key_check"), []); assert.equal(migrateDatabase(db), 0);
  } finally { db.close(); }
});

test("manager operations require current dashboard.view before input validation and ignore role labels", async (t) => {
  const f = await fixture(t);
  const calls = (token: string | null) => [
    () => f.service.getAssignments(token, "bad"), () => f.service.listAssignees(token, "bad", {}),
    () => f.service.assign(token, "bad", {}), () => f.service.unassign(token, "bad", {}),
    () => f.service.assignAccounts(token, "bad", {}), () => f.service.listJobLogs(token, "bad", "bad", {}),
  ];
  f.db.prepare("UPDATE users SET role='admin',quote_access=1 WHERE id=2").run();
  for (const [token, code] of [[null, 401], [f.denied, 403], [f.worker, 403]] as const) for (const call of calls(token)) assert.throws(call, status(code));
  f.db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=1").run();
  for (const call of calls(f.manager)) assert.throws(call, status(403));
  assert.equal(auditCount(f.db), 0);
});

test("assignment atomically selects only active role-matched users, validates duplicates and uses local authenticated actor", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.service.listAssignees(f.manager, "Electrical").items.map((u) => u.id), ["10", "3", "4"]);
  f.db.prepare("UPDATE users SET status='inactive' WHERE id=4").run();
  assert.equal(f.service.listAssignees(f.manager, "Electrical").total, 2);
  for (const assignments of [[], [{ department: "Electrical", userId: "2" }], [{ department: "Electrical", userId: "4" }],
    [{ department: "Electrical", userId: "999" }], [{ department: "Electrical", userId: "3" }, { department: "Civil", userId: "3" }],
    [{ department: "Electrical", userId: "3" }, { department: "Electrical", userId: "10" }]]) {
    assert.throws(() => f.service.assign(f.manager, "1", { expectedVersion: 1, assignments }), status(400));
  }
  assert.equal(auditCount(f.db), 0);
  const result = f.service.assign(f.manager, "1", { expectedVersion: 1, assignments: DEPARTMENTS.map((department, i) => ({ department, userId: String(i + 10) })) });
  assert.equal(result.version, 2); assert.equal(result.assignments.length, 5); assert.equal(auditCount(f.db), 5);
  for (const row of result.assignments) { assert.equal(row.actorId, "1"); assert.equal(row.status, "Assigned"); assert.equal(row.assignedAt, "2026-10-10T11:12:13.000Z"); }
  const actor = f.db.prepare("SELECT assigned_by,assigned_by_external FROM departments_assign LIMIT 1").get();
  assert.deepEqual(actor, { assigned_by: 1, assigned_by_external: "external-1" });
  assert.throws(() => f.service.assign(f.manager, "1", { expectedVersion: 2, assignments: [{ department: "Electrical", userId: "3" }], actorId: "2" }), status(400));
  for (const id of ["3", "999", "-1", "1 OR 1=1", "9223372036854775808"]) assert.throws(() => f.service.getAssignments(f.manager, id), status(404));
});

test("reassignment and append-only unassignment immediately revoke old resource access without erasing history", async (t) => {
  const f = await fixture(t);
  f.service.assign(f.manager, "1", { expectedVersion: 1, assignments: [{ department: "Electrical", userId: "3" }] });
  assert.equal(f.service.listQueue(f.worker, "Electrical").total, 1); assert.equal(f.auth.canAccessTask(f.auth.authenticate(f.worker)!, "1"), true);
  f.service.addLog(f.worker, "Electrical", "1", log("Electrical", 2));
  const original = f.db.prepare("SELECT * FROM departments_assign ORDER BY id").all();
  f.service.assign(f.manager, "1", { expectedVersion: 3, assignments: [{ department: "Electrical", userId: "4" }] });
  assert.throws(() => f.service.getJob(f.worker, "Electrical", "1"), status(404));
  assert.throws(() => f.service.listLogs(f.worker, "Electrical", "1"), status(404));
  assert.equal(f.service.listLogs(f.other, "Electrical", "1").total, 1);
  assert.equal(f.auth.canAccessTask(f.auth.authenticate(f.worker)!, "1"), false);
  const result = f.service.unassign(f.manager, "1", { expectedVersion: 4, department: "Electrical" });
  assert.equal(result.version, 5); assert.equal(result.assignments[0]!.userId, null); assert.equal(result.assignments[0]!.status, "Unassigned");
  assert.equal(f.service.listQueue(f.other, "Electrical").total, 0);
  assert.equal(f.auth.canAccessTask(f.auth.authenticate(f.other)!, "1"), false);
  assert.deepEqual(f.db.prepare("SELECT * FROM departments_assign WHERE id=1").all(), original);
  assert.equal(f.service.listJobLogs(f.manager, "1", "Electrical").total, 1);
  assert.throws(() => f.service.unassign(f.manager, "1", { expectedVersion: 5, department: "Electrical" }), status(409));
});

test("completed department and closed job reject unassignment; source Hold permits assignment administration", async (t) => {
  const f = await fixture(t);
  f.service.assign(f.manager, "1", { expectedVersion: 1, assignments: [{ department: "Electrical", userId: "3" }] });
  f.service.updateStatus(f.worker, "Electrical", "1", { expectedVersion: 2, status: "Completed" });
  assert.throws(() => f.service.unassign(f.manager, "1", { expectedVersion: 3, department: "Electrical" }), status(409));
  f.service.updateStatus(f.worker, "Electrical", "1", { expectedVersion: 3, status: "Process" });
  f.db.prepare("UPDATE tasks SET Job_Status='Closed' WHERE id=1").run();
  for (const call of [() => f.service.assign(f.manager, "1", { expectedVersion: 4, assignments: [{ department: "Electrical", userId: "4" }] }),
    () => f.service.unassign(f.manager, "1", { expectedVersion: 4, department: "Electrical" }), () => f.service.assignAccounts(f.manager, "1", { expectedVersion: 4, userId: "2" })]) assert.throws(call, status(409));
  f.db.prepare("UPDATE tasks SET Job_Status='Hold' WHERE id=1").run();
  assert.equal(f.service.unassign(f.manager, "1", { expectedVersion: 4, department: "Electrical" }).version, 5);
});

test("Accounts assignments append actual selected active users with separate local/external actor identities and unknown receipt", async (t) => {
  const f = await fixture(t);
  assert.equal(f.service.listAssignees(f.manager, "Accounts").total, 9);
  let result = f.service.assignAccounts(f.manager, "1", { expectedVersion: 1, userId: "2" });
  assert.equal(result.accounts!.userId, "2"); assert.equal(result.accounts!.status, "Assigned");
  f.db.prepare("UPDATE users SET user_id=NULL WHERE id=1").run();
  result = f.service.assignAccounts(f.manager, "1", { expectedVersion: 2, userId: "3" });
  assert.equal(result.version, 3); assert.equal(result.accounts!.userId, "3");
  assert.deepEqual(f.db.prepare("SELECT user_id,assigned_by_id,actor_user_id,received_amount FROM accounts ORDER BY id").all(), [
    { user_id: 2, assigned_by_id: "external-1", actor_user_id: 1, received_amount: null },
    { user_id: 3, assigned_by_id: null, actor_user_id: 1, received_amount: null },
  ]);
  assert.throws(() => f.service.assignAccounts(f.manager, "1", { expectedVersion: 3, userId: "999" }), status(400));
  assert.equal(auditCount(f.db), 2);
});

test("all five worker grants and exact latest local identities are required independently of dashboard, role and sales grants", async (t) => {
  const f = await fixture(t);
  f.service.assign(f.manager, "1", { expectedVersion: 1, assignments: DEPARTMENTS.map((department, i) => ({ department, userId: String(i + 10) })) });
  for (const [index, department] of DEPARTMENTS.entries()) {
    const token = await f.signIn(index + 10);
    assert.equal(f.service.getJob(token, department, "1").assignment.userId, String(index + 10));
    const calls = (value: string | null) => [() => f.service.listQueue(value, department, {}), () => f.service.getJob(value, department, "1"),
      () => f.service.listLogs(value, department, "1"), () => f.service.addLog(value, department, "1", {}), () => f.service.updateStatus(value, department, "1", {})];
    for (const [value, code] of [[null, 401], [f.manager, 403], [f.denied, 403]] as const) for (const call of calls(value)) assert.throws(call, status(code));
    f.db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=?").run(index + 10);
    for (const call of calls(token)) assert.throws(call, status(403));
  }
  assert.throws(() => f.service.getJob(f.worker, "Electrical", "1"), status(404));
  assert.throws(() => f.service.listQueue(f.worker, "__proto__"), status(404));
});

test("department queues preserve exact source active/all/whole-job Hold filters with search, paging, won boundary and lossless IDs", async (t) => {
  const f = await fixture(t);
  task(f.db, 4, "Close to Won", null); task(f.db, 5, "Closed Won", "Hold"); task(f.db, 6, "Close to Won", "Active"); task(f.db, 7, "Close to Won", "");
  task(f.db, 9_007_199_254_740_993n, "Close to Won", "Active", "Synthetic 100%_ special");
  for (const id of ["1", "2", "4", "5", "6", "7", "9007199254740993"]) f.service.assign(f.manager, id, { expectedVersion: 1, assignments: [{ department: "Electrical", userId: "3" }] });
  f.db.prepare("UPDATE tasks SET Job_Status='Closed' WHERE id=6").run();
  // Closed-job administration is deliberately rejected: insert a prior assignment to model a later close.
  f.db.prepare("INSERT INTO departments_assign(task_id,user_id,department) VALUES(3,3,'Electrical')").run();
  assert.equal(f.service.listQueue(f.worker, "Electrical").total, 7);
  assert.equal(f.service.listQueue(f.worker, "Electrical", { status: "Assigned" }).total, 4);
  assert.equal(f.service.listQueue(f.worker, "Electrical", { status: "Hold" }).total, 1);
  const found = f.service.listQueue(f.worker, "Electrical", { query: "%_", pageSize: 1 });
  assert.equal(found.total, 1); assert.equal(found.items[0]!.id, "9007199254740993");
  assert.equal(f.service.listQueue(f.worker, "Electrical", { query: "' OR 1=1 --" }).total, 0);
  assert.equal(f.service.listQueue(f.worker, "Electrical", { pageSize: 2, page: 4 }).items.length, 1);
  assert.equal(f.service.listQueue(f.worker, "Electrical", { pageSize: 2, page: 5 }).items.length, 0);
  for (const input of [{ page: 0 }, { pageSize: 101 }, { status: "Unassigned" }, { query: "\0" }, { userId: "4" }]) assert.throws(() => f.service.listQueue(f.worker, "Electrical", input), status(400));
});

test("five department logs validate exact source-specific choices and persist immutable local actor text without changing assignment status", async (t) => {
  const f = await fixture(t);
  f.service.assign(f.manager, "1", { expectedVersion: 1, assignments: DEPARTMENTS.map((department, i) => ({ department, userId: String(i + 10) })) });
  let expectedVersion = 2;
  for (const [index, department] of DEPARTMENTS.entries()) {
    const token = await f.signIn(index + 10), input = { ...log(department, expectedVersion), notes: " <script>literal</script> '; DROP TABLE tasks; -- " };
    const result = f.service.addLog(token, department, "1", input);
    assert.equal(result.version, ++expectedVersion); assert.equal(result.assignment.status, "Assigned");
    const logs = f.service.listLogs(token, department, "1");
    assert.equal(logs.total, 1); assert.equal(logs.items[0]!.actorId, String(index + 10));
    assert.equal(logs.items[0]!.notes, input.notes.trim()); assert.equal(logs.items[0]!.createdAt, "2026-10-10T11:12:13.000Z");
    assert.equal(f.service.listJobLogs(f.manager, "1", department).items[0]!.id, logs.items[0]!.id);
    for (const bad of [{ ...input, expectedVersion, status: "invented" }, { ...input, expectedVersion, actorId: "1" },
      { ...input, expectedVersion, assignmentId: "999" }, { ...input, expectedVersion, file: "x.pdf" }, { ...input, expectedVersion, notes: "\0" }]) assert.throws(() => f.service.addLog(token, department, "1", bad), status(400));
  }
  assert.equal(auditCount(f.db), 10);
  assert.equal(JSON.stringify(f.db.prepare("SELECT * FROM crm_department_audit_events").all()).includes("literal"), false);
  assert.throws(() => f.db.prepare("UPDATE crm_department_work_logs SET notes='changed'").run(), /immutable/);
  assert.throws(() => f.db.prepare("DELETE FROM crm_department_work_logs").run(), /immutable/);
  assert.throws(() => f.db.prepare("UPDATE crm_department_audit_events SET action='departments.assign'").run(), /immutable/);
  assert.throws(() => f.db.prepare("DELETE FROM crm_department_audit_events").run(), /immutable/);
});

test("work logs and status respect completed, Hold and Closed controls; Process can reopen Completed; logs are paginated", async (t) => {
  const f = await fixture(t);
  f.service.assign(f.manager, "1", { expectedVersion: 1, assignments: [{ department: "Electrical", userId: "3" }] });
  f.service.addLog(f.worker, "Electrical", "1", log("Electrical", 2));
  f.service.addLog(f.worker, "Electrical", "1", log("Electrical", 3));
  assert.equal(f.service.listLogs(f.worker, "Electrical", "1", { pageSize: 1 }).items[0]!.id, "2");
  assert.equal(f.service.listLogs(f.worker, "Electrical", "1", { pageSize: 1, page: 2 }).items[0]!.id, "1");
  f.service.updateStatus(f.worker, "Electrical", "1", { expectedVersion: 4, status: "Completed" });
  assert.throws(() => f.service.addLog(f.worker, "Electrical", "1", log("Electrical", 5)), status(409));
  const reopened = f.service.updateStatus(f.worker, "Electrical", "1", { expectedVersion: 5, status: "Process" });
  assert.equal(reopened.assignment.status, "Process"); assert.equal(reopened.assignment.version, 3);
  for (const jobStatus of ["Hold", "Closed"]) {
    f.db.prepare("UPDATE tasks SET Job_Status=? WHERE id=1").run(jobStatus);
    assert.throws(() => f.service.addLog(f.worker, "Electrical", "1", log("Electrical", 6)), status(409));
    assert.throws(() => f.service.updateStatus(f.worker, "Electrical", "1", { expectedVersion: 6, status: "Completed" }), status(409));
  }
  f.db.prepare("UPDATE tasks SET Job_Status='Active' WHERE id=1").run();
  for (const input of [{ expectedVersion: 6, status: "Assigned" }, { expectedVersion: 6, status: "Hold" }, { expectedVersion: "6", status: "Process" }, { expectedVersion: 6, status: "Process", assignmentId: "9" }]) assert.throws(() => f.service.updateStatus(f.worker, "Electrical", "1", input), status(400));
});

test("conflicting versions and injected audit failures roll back assignments, account rows, logs, statuses and task version", async (t) => {
  const f = await fixture(t);
  f.service.assign(f.manager, "1", { expectedVersion: 1, assignments: [{ department: "Electrical", userId: "3" }] });
  for (const call of [() => f.service.assign(f.manager, "1", { expectedVersion: 1, assignments: [{ department: "Civil", userId: "11" }] }),
    () => f.service.unassign(f.manager, "1", { expectedVersion: 1, department: "Electrical" }), () => f.service.assignAccounts(f.manager, "1", { expectedVersion: 1, userId: "2" }),
    () => f.service.addLog(f.worker, "Electrical", "1", log("Electrical", 1)), () => f.service.updateStatus(f.worker, "Electrical", "1", { expectedVersion: 1, status: "Process" })]) assert.throws(call, status(409));
  f.db.exec("CREATE TRIGGER fixture_fail_audit BEFORE INSERT ON crm_department_audit_events BEGIN SELECT RAISE(ABORT,'private failure not for clients'); END");
  for (const call of [() => f.service.assign(f.manager, "1", { expectedVersion: 2, assignments: [{ department: "Civil", userId: "11" }] }),
    () => f.service.unassign(f.manager, "1", { expectedVersion: 2, department: "Electrical" }), () => f.service.assignAccounts(f.manager, "1", { expectedVersion: 2, userId: "2" }),
    () => f.service.addLog(f.worker, "Electrical", "1", log("Electrical", 2)), () => f.service.updateStatus(f.worker, "Electrical", "1", { expectedVersion: 2, status: "Process" })]) {
    assert.throws(call, (e: unknown) => e instanceof DepartmentsError && e.status === 503 && !e.message.includes("private"));
  }
  assert.equal(auditCount(f.db), 1); assert.equal(f.service.getAssignments(f.manager, "1").version, 2);
  assert.equal(f.service.getAssignments(f.manager, "1").assignments.length, 1); assert.equal(f.service.getAssignments(f.manager, "1").accounts, null);
  assert.equal(f.service.getJob(f.worker, "Electrical", "1").assignment.status, "Assigned"); assert.equal(f.service.listLogs(f.worker, "Electrical", "1").total, 0);
});

test("file-backed concurrent connections reject stale updates and retain assignment/log/audit state after reopen", async () => {
  const disk = filesystemFixture(); let db: Database.Database | undefined, second: Database.Database | undefined;
  try {
    db = openDatabase(disk.config, { create: true }); migrateDatabase(db); const f = await populate(db);
    second = openDatabase(disk.config); const concurrent = createDepartmentsService(second, { now: () => NOW });
    f.service.assign(f.manager, "1", { expectedVersion: 1, assignments: [{ department: "Electrical", userId: "3" }] });
    assert.throws(() => concurrent.assign(f.manager, "1", { expectedVersion: 1, assignments: [{ department: "Electrical", userId: "4" }] }), status(409));
    concurrent.addLog(f.worker, "Electrical", "1", log("Electrical", 2));
    assert.throws(() => f.service.updateStatus(f.worker, "Electrical", "1", { expectedVersion: 2, status: "Completed" }), status(409));
    second.close(); second = undefined; db.close(); db = undefined;
    db = openDatabase(disk.config); const reopened = createDepartmentsService(db, { now: () => NOW });
    assert.equal(reopened.getAssignments(f.manager, "1").version, 3); assert.equal(reopened.listLogs(f.worker, "Electrical", "1").total, 1);
    assert.equal(auditCount(db), 2); assert.deepEqual(db.pragma("foreign_key_check"), []); assert.deepEqual(db.pragma("quick_check"), [{ quick_check: "ok" }]);
  } finally { second?.close(); db?.close(); disk.cleanup(); }
});
