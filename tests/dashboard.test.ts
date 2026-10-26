import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { hashSync } from "bcryptjs";
import { createAuthService } from "./sqlite-reference/auth/service";
import { configureDatabase } from "./sqlite-reference/db/connection";
import { migrateDatabase } from "./sqlite-reference/db/migrations";
import { createDashboardService, DashboardError, DASHBOARD_PERMISSIONS } from "./sqlite-reference/dashboard/service";
import { DASHBOARD_DEPARTMENTS } from "./sqlite-reference/dashboard/types";

// Deliberately synthetic fixtures only. No default/development account or business records.
const password = "Synthetic dashboard test password";
const passwordHash = hashSync(password, 4);
const NOW = Date.parse("2026-10-10T20:30:00.000Z"); // October 11 at 00:30 in Dubai.
function user(db: Database.Database, id: number | bigint, externalId: string | null = `external-${id}`, name = `Synthetic employee ${id}`) {
  db.prepare("INSERT INTO users(id,user_id,username,email,password,status) VALUES(?,?,?,?,?,'active')")
    .run(id, externalId, name, `fixture-${id}@example.invalid`, passwordHash);
}
function grant(db: Database.Database, id: number | bigint, key: string) {
  db.prepare('INSERT INTO permissions("key",label) VALUES(?,?) ON CONFLICT("key") DO NOTHING').run(key, key);
  db.prepare('INSERT INTO admin_user_permissions(admin_user_id,permission_id) SELECT ?,id FROM permissions WHERE "key"=?').run(id, key);
}
function task(db: Database.Database, id: number, status = "Qualification", owner: string | null = "external-2",
  serviceCharge: string | null = null, jobStatus: string | null = null, createdAt = "2026-10-10 20:00:00") {
  db.prepare("INSERT INTO tasks(id,deal_name,status,assigned_to,service_charge,Job_Status,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(id, `Synthetic task ${id}`, status, owner, serviceCharge, jobStatus, createdAt);
}
function assignment(db: Database.Database, taskId: number, userId: number | bigint, department = "Electrical", status = "Assigned", date: string | null = "2026-10-10 20:00:00") {
  return db.prepare("INSERT INTO departments_assign(task_id,user_id,department,status,assigned_date) VALUES(?,?,?,?,?)")
    .run(taskId, userId, department, status, date);
}
async function fixture(t: TestContext) {
  const db = new Database(":memory:");
  configureDatabase(db); migrateDatabase(db); t.after(() => db.close());
  for (let id = 1; id <= 4; id++) user(db, id);
  grant(db, 1, "dashboard.view"); grant(db, 2, "sales_dashboard.view");
  const auth = createAuthService(db, { now: () => NOW });
  const signIn = async (id: number | bigint) => (await auth.login(`fixture-${id}@example.invalid`, password, "fixture")).sessionToken;
  return { db, auth, signIn, service: createDashboardService(db, { now: () => NOW }),
    manager: await signIn(1), sales: await signIn(2), denied: await signIn(3) };
}
function status(code: number) { return (error: unknown) => error instanceof DashboardError && error.status === code; }

test("dashboard authenticates, reloads grants and authorizes before validation; role/manage grants never bypass", async (t) => {
  const f = await fixture(t);
  f.db.prepare("UPDATE users SET role='admin',quote_access=1 WHERE id=3").run();
  for (const key of ["leads.view", "leads.manage", "electrical.manage", "permissions.manage"]) grant(f.db, 3, key);
  assert.throws(() => f.service.getDashboard(null, { malicious: true }), status(401));
  assert.throws(() => f.service.getDashboard(f.denied, { malicious: true }), status(403));
  assert.throws(() => f.service.getDashboard(f.manager, { malicious: true }), status(400));
  const result = f.service.getDashboard(f.manager);
  assert.equal(result.global!.wonJobs, 0);
  assert.deepEqual(result.global!.accounts, { pendingJobs: 0, totalPending: "0.00", unknownServiceChargeJobs: 0 });
  assert.equal(result.global!.pipeline.every((row) => row.count === 0 && row.percentage === "0.00"), true);
  assert.deepEqual(result.departments, []); assert.equal(result.sales, undefined);
  f.db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=1").run();
  assert.throws(() => f.service.getDashboard(f.manager), status(403));
  f.db.prepare("UPDATE users SET status='inactive' WHERE id=2").run();
  assert.throws(() => f.service.getDashboard(f.sales), status(401));
  assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM crm_audit_events").get() as { n: number }).n, 0);
});

test("each of seven dashboard grants exposes exactly its own section; all grants may coexist", async (t) => {
  const f = await fixture(t);
  for (const key of DASHBOARD_PERMISSIONS) {
    f.db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=3").run(); grant(f.db, 3, key);
    const result = f.service.getDashboard(f.denied);
    assert.equal(Boolean(result.global), key === "dashboard.view");
    assert.equal(Boolean(result.sales), key === "sales_dashboard.view");
    assert.equal(result.departments.length, key !== "dashboard.view" && key !== "sales_dashboard.view" ? 1 : 0);
  }
  f.db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=3").run();
  for (const key of DASHBOARD_PERMISSIONS) grant(f.db, 3, key);
  const result = f.service.getDashboard(f.denied);
  assert.ok(result.global); assert.ok(result.sales);
  assert.deepEqual(result.departments.map((row) => row.department), DASHBOARD_DEPARTMENTS);
});

test("global job metrics preserve won aliases, unassigned jobs and all-history completion semantics", async (t) => {
  const f = await fixture(t);
  task(f.db, 1, "Close to Won", null, "0"); task(f.db, 2, "Closed Won");
  task(f.db, 3, "Close to Won", null, "0"); task(f.db, 4, "Qualification");
  task(f.db, 5, "Proposal");
  assignment(f.db, 2, 3, "Electrical", "Completed");
  assignment(f.db, 3, 3, "Electrical", "Assigned"); assignment(f.db, 3, 4, "Electrical", "Completed");
  assignment(f.db, 4, 3, "Civil", "Completed");
  assignment(f.db, 5, 3, "Civil", "Completed"); assignment(f.db, 5, 4, "PM", "Assigned");
  const global = f.service.getDashboard(f.manager).global!;
  assert.equal(global.wonJobs, 3); assert.equal(global.pendingAssignmentJobs, 1);
  assert.equal(global.completedJobs, 2); // includes non-won task 4; excludes old incomplete history on task 3.
});

test("pipeline percentages use every source alias and all-task denominator without invented unknown-stage bucket", async (t) => {
  const f = await fixture(t);
  const values = ["Pending", "Qualification", "Site Visit", "Proposal", "Proposal/Price Quote", "Close to Won", "Closed Won",
    "Close to Lost", "Closed Lost", "Omitted", "Proposal-Omitted", "Big Project", "", "Unmapped source stage"];
  values.forEach((value, index) => task(f.db, index + 1, value, "external-2", "0"));
  const rows = f.service.getDashboard(f.manager).global!.pipeline;
  assert.deepEqual(rows.map((row) => row.count), [2, 1, 2, 2, 4, 2]);
  assert.deepEqual(rows.map((row) => row.percentage), ["14.29", "7.14", "14.29", "14.29", "28.57", "14.29"]);
  const sales = f.service.getDashboard(f.sales).sales!;
  assert.equal(sales.total, 14); assert.equal(sales.stages.length, 5);
  assert.equal(sales.stages.find((row) => row.key === "won")!.count, 2);
});

test("latest Unassigned tombstones remove current workload and restore pending assignment without rewriting completion history", async (t) => {
  const f = await fixture(t);
  grant(f.db, 3, "electric_dashboard.view");
  task(f.db, 1, "Close to Won", null, "0"); task(f.db, 2, "Closed Won", null, "0");
  assignment(f.db, 1, 3, "Electrical", "Process"); assignment(f.db, 2, 3, "Electrical", "Completed");
  assert.equal(f.service.getDashboard(f.manager).global!.pendingAssignmentJobs, 0);
  f.db.prepare("INSERT INTO departments_assign(task_id,user_id,department,status) VALUES(1,NULL,'Electrical','Unassigned')").run();
  const global = f.service.getDashboard(f.manager).global!;
  assert.equal(global.pendingAssignmentJobs, 1); assert.equal(global.completedJobs, 1);
  const electrical = global.departmentProgress.find((d) => d.department === "Electrical")!;
  assert.equal(electrical.total, 1); assert.equal(electrical.process, 0); assert.equal(electrical.completed, 1);
  assert.equal(global.employees.items.find((u) => u.id === "3")!.electrical, 1);
  assert.equal(f.service.getDashboard(f.denied).departments[0]!.total, 1);
  assignment(f.db, 1, 4, "Civil", "Assigned");
  assert.equal(f.service.getDashboard(f.manager).global!.pendingAssignmentJobs, 0);
  assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM departments_assign WHERE task_id=1").get() as { n: number }).n, 3);
});

test("accounts use exact decimal arithmetic, multiple receipts, overpayment clamp and source-specific won filter", async (t) => {
  const f = await fixture(t);
  task(f.db, 1, "Close to Won", null, "9007199254740993.123456789012345678");
  task(f.db, 2, "Close to Won", null, "0.30"); task(f.db, 3, "Close to Won", null, "10.00");
  task(f.db, 4, "Closed Won", null, "999.99"); // source accounts summary excludes this other won alias.
  const insert = f.db.prepare("INSERT INTO accounts(task_id,received_amount) VALUES(?,?)");
  insert.run(1, "0.100000000000000001"); insert.run(1, "0.02"); insert.run(1, null);
  insert.run(2, "0.10"); insert.run(2, "0.20"); insert.run(3, "15"); insert.run(4, "invalid out-of-cohort data");
  assert.deepEqual(f.service.getDashboard(f.manager).global!.accounts,
    { pendingJobs: 1, totalPending: "9007199254740993.003456789012345677", unknownServiceChargeJobs: 0 });
});

test("unknown service charges remain unknown and invalid monetary source values fail safely only for authorized global readers", async (t) => {
  const f = await fixture(t);
  task(f.db, 1, "Close to Won"); task(f.db, 2, "Close to Won", null, "12.5");
  assert.deepEqual(f.service.getDashboard(f.manager).global!.accounts,
    { pendingJobs: 1, totalPending: null, unknownServiceChargeJobs: 1 });
  for (const invalid of ["", "NaN", "1e9", "-0.01", "1.2345678901234567890", "01.00", "123,456.00"]) {
    f.db.prepare("UPDATE tasks SET service_charge=? WHERE id=1").run(invalid);
    assert.throws(() => f.service.getDashboard(f.manager), (error) => status(503)(error) && !(error as Error).message.includes(invalid === "" ? "SQLITE" : invalid));
    assert.ok(f.service.getDashboard(f.sales).sales); // no unauthorized global query or leaking invalid-record signal.
  }
  f.db.prepare("UPDATE tasks SET service_charge='1' WHERE id=1").run();
  f.db.prepare("INSERT INTO accounts(task_id,received_amount) VALUES(1,'private invalid receipt')").run();
  assert.throws(() => f.service.getDashboard(f.manager), (error) => status(503)(error) && !(error as Error).message.includes("private invalid receipt"));
});

test("personal departments scope to latest local-ID assignment and preserve active/completed/job-hold differences", async (t) => {
  const f = await fixture(t);
  grant(f.db, 3, "electric_dashboard.view");
  for (let i = 1; i <= 8; i++) task(f.db, i, "Qualification", "external-3", null,
    i === 3 || i === 4 ? "Hold" : i === 5 ? "Closed" : i === 7 ? "" : null);
  assignment(f.db, 1, 3); assignment(f.db, 1, 4); // revoked by reassignment despite identical dates.
  assignment(f.db, 2, 3, "Electrical", "Process");
  assignment(f.db, 3, 3, "Electrical", "Assigned");
  assignment(f.db, 4, 3, "Electrical", "Completed");
  assignment(f.db, 5, 3, "Electrical", "Completed");
  assignment(f.db, 6, 3, "Electrical", "Hold"); // department hold is not full-job hold.
  assignment(f.db, 7, 3); // empty Job_Status is not null/Active in these source methods.
  assignment(f.db, 8, 3, "Civil");
  const result = f.service.getDashboard(f.denied);
  assert.equal(result.global, undefined); assert.equal(result.sales, undefined);
  assert.deepEqual(result.departments, [{ department: "Electrical", total: 6, pending: 0, process: 1, completed: 2, hold: 2, assignedToday: 6, completedAssignedThisMonth: 2 }]);
  f.db.prepare("UPDATE departments_assign SET status='Completed' WHERE task_id=2").run();
  assert.equal(f.service.getDashboard(f.denied).departments[0]!.completed, 3);
});

test("all five personal departments apply the same latest-assignment rule without requiring a management grant", async (t) => {
  const f = await fixture(t);
  const keys = DASHBOARD_PERMISSIONS.filter((key) => key !== "dashboard.view" && key !== "sales_dashboard.view");
  keys.forEach((key) => grant(f.db, 3, key));
  DASHBOARD_DEPARTMENTS.forEach((department, index) => {
    task(f.db, index + 1); assignment(f.db, index + 1, 4, department, "Process");
    assignment(f.db, index + 1, 3, department);
  });
  const rows = f.service.getDashboard(f.denied).departments;
  for (const row of rows) assert.deepEqual(row, { department: row.department, total: 1, pending: 1, process: 0, completed: 0, hold: 0, assignedToday: 1, completedAssignedThisMonth: 0 });
});

test("administrator department progress uses one latest ID even on tied dates and retains PM pending active filter", async (t) => {
  const f = await fixture(t);
  task(f.db, 1); task(f.db, 2, "Qualification", null, null, "Hold"); task(f.db, 3, "Qualification", null, null, "Hold");
  assignment(f.db, 1, 3, "Electrical", "Assigned"); assignment(f.db, 1, 4, "Electrical", "Process");
  assignment(f.db, 2, 3, "Electrical", "Assigned"); assignment(f.db, 2, 3, "PM", "Assigned");
  assignment(f.db, 3, 3, "PM", "Process");
  const rows = f.service.getDashboard(f.manager).global!.departmentProgress;
  assert.deepEqual(rows[0], { department: "Electrical", total: 2, pending: 1, process: 1, completed: 0, hold: 0 });
  assert.deepEqual(rows[2], { department: "PM", total: 2, pending: 0, process: 1, completed: 0, hold: 0 });
});

test("employee matrix counts won/latest assignments once, searches literal wildcards and preserves large local IDs", async (t) => {
  const f = await fixture(t);
  user(f.db, 9_007_199_254_740_993n, "outside-numeric-range", "Synthetic 100%_ employee");
  task(f.db, 1, "Close to Won", null, "0"); task(f.db, 2, "Closed Won"); task(f.db, 3, "Qualification");
  assignment(f.db, 1, 3); assignment(f.db, 1, 9_007_199_254_740_993n); assignment(f.db, 2, 9_007_199_254_740_993n, "Civil");
  assignment(f.db, 3, 9_007_199_254_740_993n, "PM");
  const result = f.service.getDashboard(f.manager, { employeeSearch: "%_", employeePageSize: 1 }).global!.employees;
  assert.equal(result.total, 1);
  assert.deepEqual(result.items, [{ id: "9007199254740993", name: "Synthetic 100%_ employee", electrical: 1, civil: 1, pm: 0 }]);
  const page = f.service.getDashboard(f.manager, { employeePage: 2, employeePageSize: 3 }).global!.employees;
  assert.equal(page.total, 5); assert.equal(page.items.length, 2);
  assert.equal(f.service.getDashboard(f.manager, { employeeSearch: "' OR 1=1 --" }).global!.employees.total, 0);
  for (const input of [{ employeePage: 0 }, { employeePageSize: 101 }, { employeeSearch: "\0" }, { employeePage: "1" }]) {
    assert.throws(() => f.service.getDashboard(f.manager, input), status(400));
  }
  assert.throws(() => f.service.getDashboard(f.sales, { employeeSearch: "Synthetic" }), status(403));
});

test("Dubai today/month boundaries are half-open UTC instants for task and assignment dates", async (t) => {
  const f = await fixture(t); grant(f.db, 3, "electric_dashboard.view");
  const dates = ["2026-09-30 19:59:59", "2026-09-30 20:00:00", "2026-10-10 19:59:59", "2026-10-10 20:00:00",
    "2026-10-11T19:59:59.999Z", "2026-10-11 20:00:00", "2026-10-31 19:59:59", "2026-10-31 20:00:00"];
  dates.forEach((date, index) => { task(f.db, index + 1, "Qualification", "external-2", null, null, date); assignment(f.db, index + 1, 3, "Electrical", "Completed", date); });
  const global = f.service.getDashboard(f.manager).global!;
  assert.equal(global.leadsToday, 2); assert.equal(global.leadsThisMonth, 6);
  const sales = f.service.getDashboard(f.sales).sales!;
  assert.equal(sales.today, 2); assert.equal(sales.thisMonth, 6);
  const department = f.service.getDashboard(f.denied).departments[0]!;
  assert.equal(department.assignedToday, 2); assert.equal(department.completedAssignedThisMonth, 6);
});

test("sales ownership uses exact external IDs, never local IDs; null external identity sees no unassigned records", async (t) => {
  const f = await fixture(t);
  f.db.prepare("UPDATE users SET user_id='9007199254740993123' WHERE id=2").run();
  user(f.db, 5, "2"); user(f.db, 6, null); grant(f.db, 6, "sales_dashboard.view");
  task(f.db, 1, "Qualification", "9007199254740993123"); task(f.db, 2, "Qualification", "2"); task(f.db, 3, "Qualification", null);
  assert.equal(f.service.getDashboard(f.sales).sales!.total, 1);
  const nullToken = await f.signIn(6);
  assert.equal(f.service.getDashboard(nullToken).sales!.total, 0);
  assert.equal(f.service.getDashboard(nullToken).sales!.stages.every((row) => row.count === 0), true);
  f.auth.logout(f.sales); assert.throws(() => f.service.getDashboard(f.sales), status(401));
});

test("unavailable schema/query errors never expose private database internals", async (t) => {
  const f = await fixture(t);
  f.db.exec("DROP TABLE accounts");
  assert.throws(() => f.service.getDashboard(f.manager), (error) => status(503)(error) && !(error as Error).message.includes("accounts"));
  assert.ok(f.service.getDashboard(f.sales).sales);
});
