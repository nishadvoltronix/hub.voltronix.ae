import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import { hashSync } from "bcryptjs";
import { configureDatabase, type SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { migrateDatabase } from "../../tests/sqlite-reference/db/migrations.js";
import { createAuthService } from "../../tests/sqlite-reference/auth/service.js";
import { createReportsService } from "../../tests/sqlite-reference/reports/service.js";
import { createDashboardService } from "../../tests/sqlite-reference/dashboard/service.js";
import { createExportsService } from "../../tests/sqlite-reference/exports/service.js";
import { createLocalOwnerReports } from "./local-owner-reports.js";
import { createLocalWorkflowService } from "./workflow-service.js";
import { applyLocalWorkflowExtension } from "./workflow-schema.js";

const requireNext = createRequire(new URL("../../package.json", import.meta.url));
const Database = requireNext("better-sqlite3") as new (filename: string) => SqliteDatabase;
const password = "Disposable report acceptance password", passwordHash = hashSync(password, 4);
const isStatus = (status: number) => (error: unknown) => typeof error === "object" && error !== null && "status" in error && error.status === status;
const deal = { firstName: "Disposable", lastName: "Report", companyName: "Synthetic report fixture", email: "report@example.invalid",
  mobile: "000000", phone: "000001", department: "VOLTRONIX CONTRACTING LLC", poBox: "", trn: "", address: "Fixture", description: "Memory database only" };
async function fixture(t: TestContext, extension = true) {
  const db = new Database(":memory:"); configureDatabase(db); migrateDatabase(db); t.after(() => db.close());
  const now = Date.now(), today = new Date(now + 14_400_000).toISOString().slice(0, 10);
  const start = Date.parse(`${today}T00:00:00Z`) - 14_400_000, at = (offset: number) => new Date(start + offset).toISOString();
  for (const [id, name, external] of [[1, "Alice_%", "remote-alice"], [2, "Bob", null], [3, "Carol", "remote-carol"]] as const) {
    db.prepare("INSERT INTO users(id,user_id,username,email,password,status,role) VALUES(?,?,?,?,?,'active','synthetic')")
      .run(id, external, name, `report-${id}@example.invalid`, passwordHash);
  }
  for (const key of ["dashboard.view", "sales_dashboard.view", "deals.manage"]) {
    const p = db.prepare('INSERT INTO permissions("key",label) VALUES(?,?)').run(key, key);
    for (const id of [1, 2, 3]) db.prepare("INSERT INTO admin_user_permissions(admin_user_id,permission_id) VALUES(?,?)").run(id, p.lastInsertRowid);
  }
  if (extension) applyLocalWorkflowExtension(db);
  const auth = createAuthService(db, { now: () => now });
  const tokens = await Promise.all([1, 2, 3].map(async id => (await auth.login(`report-${id}@example.invalid`, password, "disposable-report-tests")).sessionToken));
  const a = tokens[0]!, b = tokens[1]!, c = tokens[2]!;
  let creationTime = start;
  const workflow = createLocalWorkflowService(db, { now: () => creationTime });
  const s = createLocalOwnerReports(db, { now: () => now });
  function legacy(owner: string | null, status = "Pending", charge: string | null = "0", created = at(0), creator = 1) {
    return String(db.prepare("INSERT INTO tasks(deal_name,assigned_to,deal_crm_created_by,status,service_charge,created_at,updated_at) VALUES('Synthetic historical task',?,?,?,?,?,?)")
      .run(owner, creator, status, charge, created, created).lastInsertRowid);
  }
  function local(token: string, status = "Pending", charge: string | null = "0", created = at(0)) {
    creationTime = Date.parse(created);
    const { taskId } = workflow.createDeal(token, { operationId: randomUUID(), ...deal });
    // Test arrangements affect only a disposable fixture. The creation relation
    // still comes from a real authenticated, journaled local deal operation.
    db.prepare("UPDATE tasks SET status=?,service_charge=? WHERE id=?").run(status, charge, taskId);
    return taskId;
  }
  const revoke = (id: number, grant: string) => db.prepare('DELETE FROM admin_user_permissions WHERE admin_user_id=? AND permission_id=(SELECT id FROM permissions WHERE "key"=?)').run(id, grant);
  return { db, now, today, start, at, auth, a, b, c, s, local, legacy, revoke };
}
function snapshot(db: SqliteDatabase) {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => ({ name, rows: db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all() }));
}

test("LOCAL REPORTS mixed external/local owners count once, retain exact amounts and original rows", async t => {
  const f = await fixture(t);
  f.legacy("remote-alice", "Closed Won", "10.125"); f.legacy("remote-alice", "Qualification");
  f.legacy(null, "Closed Won", "999", f.at(0), 1); // Creator is not a historical sales owner.
  const won = f.local(f.a, "Close to Won", "20.005"); f.local(f.b, "Closed Won", null);
  f.local(f.c, "Closed Won", "400"); f.db.prepare("UPDATE users SET status='inactive' WHERE id=3").run();
  for (const department of ["Electrical", "PM"]) f.db.prepare("INSERT INTO departments_assign(task_id,department,user_id,status) VALUES(?,?,1,'Assigned')").run(won, department);
  const before = snapshot(f.db), original = createReportsService(f.db, { now: () => f.now }).employeePerformance(f.a);
  const report = f.s.reports.employeePerformance(f.a), alice = report.employees.items.find(row => row.id === "1")!, bob = report.employees.items.find(row => row.id === "2")!;
  assert.equal(original.employees.items[0]!.totalDeals, 2); assert.equal(original.employees.items[1]!.totalDeals, 0);
  assert.equal(alice.totalDeals, 3); assert.equal(alice.qualification, 1); assert.equal(alice.won, 2); assert.equal(alice.wonAmount, "30.13");
  assert.equal(alice.electrical, 1); assert.equal(alice.pm, 1); assert.equal(alice.assigned, 1);
  assert.equal(bob.totalDeals, 1); assert.equal(bob.wonAmount, null); assert.equal(bob.unknownAmounts, 1);
  assert.equal(report.employees.total, 2); assert.equal(report.summary.totalDeals, 6);
  for (const key of ["summary", "stages", "wonJobStatuses", "monthly", "monthlySince"] as const) assert.deepEqual(report[key], original[key]);
  assert.deepEqual(snapshot(f.db), before);
});

test("LOCAL REPORTS Dubai date boundaries, escaped name search and pagination stay aligned", async t => {
  const f = await fixture(t);
  f.legacy("remote-alice", "Pending", "0", f.at(-1)); f.local(f.a, "Pending", "0", f.at(0));
  f.legacy("remote-alice", "Closed Won", "1.000000000000000001", f.at(86_400_000 - 1));
  f.local(f.a, "Closed Won", "800", f.at(86_400_000)); f.local(f.b, "Site Visit");
  const input = { dateFrom: f.today, dateTo: f.today, query: "_%", page: 1, pageSize: 1 };
  const report = f.s.reports.employeePerformance(f.a, input), original = createReportsService(f.db, { now: () => f.now }).employeePerformance(f.a, input);
  assert.equal(report.employees.total, 1); assert.equal(report.employees.items[0]!.name, "Alice_%");
  assert.equal(report.employees.items[0]!.totalDeals, 2); assert.equal(report.employees.items[0]!.wonAmount, "1.000000000000000001");
  assert.deepEqual(report.summary, original.summary); assert.equal(report.summary.totalDeals, 3);
  assert.equal(f.s.reports.employeePerformance(f.a, { ...input, page: 2 }).employees.items.length, 0);
  const second = f.s.reports.employeePerformance(f.a, { dateFrom: f.today, dateTo: f.today, page: 2, pageSize: 1 });
  assert.equal(second.employees.items[0]!.id, "2"); assert.equal(second.employees.items[0]!.siteVisit, 1);
  assert.throws(() => f.s.reports.employeePerformance(f.a, { dateFrom: "2026-02-30" }), isStatus(400));
  assert.throws(() => f.s.reports.employeePerformance(f.a, { dateFrom: "2026-10-13", dateTo: "2026-10-12" }), isStatus(400));
});

test("LOCAL REPORTS original stage aliases and high precision money remain exact", async t => {
  const f = await fixture(t), stages = ["Pending", "Qualification", "Site Visit", "Proposal", "Proposal/Price Quote", "Close to Won", "Closed Won",
    "Close to Lost", "Closed Lost", "Omitted", "Proposal-Omitted", "Proposal Omitted", "Big Project"];
  for (const stage of stages) f.local(f.b, stage, "2000000000000000000.123456789012345678");
  const row = f.s.reports.employeePerformance(f.a, { query: "Bob" }).employees.items[0]!;
  assert.deepEqual([row.totalDeals, row.qualification, row.siteVisit, row.proposal, row.won, row.lost, row.omitted, row.proposalOmitted], [13, 2, 1, 2, 2, 2, 1, 2]);
  assert.equal(row.wonAmount, "4000000000000000000.246913578024691356");
});

test("LOCAL REPORTS personal sales combines only own external and own local records with Dubai boundaries", async t => {
  const f = await fixture(t);
  f.legacy("remote-alice", "Qualification", "0", f.at(-1)); f.local(f.a, "Site Visit", "0", f.at(0));
  f.local(f.a, "Closed Won", "10", f.at(86_400_000 - 1)); f.legacy("remote-alice", "Omitted", "0", f.at(86_400_000));
  f.local(f.b, "Pending"); f.legacy(null, "Proposal", "0", f.at(0), 1); f.legacy("remote-carol", "Proposal");
  const before = snapshot(f.db), original = createDashboardService(f.db, { now: () => f.now }).getDashboard(f.a);
  const result = f.s.dashboard.getDashboard(f.a);
  assert.equal(result.sales!.total, 4); assert.equal(result.sales!.today, 2);
  const expectedMonth = [f.at(-1), f.at(0), f.at(86_400_000 - 1), f.at(86_400_000)].filter(at =>
    new Date(Date.parse(at) + 14_400_000).toISOString().slice(0, 7) === f.today.slice(0, 7)).length;
  assert.equal(result.sales!.thisMonth, expectedMonth);
  assert.deepEqual(result.sales!.stages.map(stage => [stage.key, stage.count]), [["qualification", 1], ["site_visit", 1], ["proposal", 0], ["won", 1], ["lost", 1]]);
  assert.deepEqual(result.global, original.global); assert.deepEqual(result.departments, original.departments);
  const bob = f.s.dashboard.getDashboard(f.b); assert.equal(bob.sales!.total, 1); assert.equal(bob.sales!.stages[0]!.count, 1);
  assert.deepEqual(snapshot(f.db), before);
});

test("LOCAL REPORTS normal auth, current grants, section scope and disabled accounts remain authoritative", async t => {
  const f = await fixture(t); f.local(f.b);
  assert.throws(() => f.s.reports.employeePerformance(null), isStatus(401));
  assert.throws(() => f.s.dashboard.getDashboard("invalid"), isStatus(401));
  f.revoke(2, "dashboard.view");
  assert.throws(() => f.s.reports.employeePerformance(f.b), isStatus(403));
  const salesOnly = f.s.dashboard.getDashboard(f.b); assert.equal(salesOnly.global, undefined); assert.equal(salesOnly.sales!.total, 1);
  assert.throws(() => f.s.dashboard.getDashboard(f.b, { employeeSearch: "Alice" }), isStatus(403));
  f.revoke(1, "sales_dashboard.view"); assert.equal(f.s.dashboard.getDashboard(f.a).sales, undefined);
  f.revoke(2, "sales_dashboard.view"); assert.throws(() => f.s.dashboard.getDashboard(f.b), isStatus(403));
  f.db.prepare("UPDATE users SET status='inactive' WHERE id=1").run(); assert.throws(() => f.s.reports.employeePerformance(f.a), isStatus(401));
});

test("LOCAL REPORTS invalid local provenance fails closed without reattribution or writes", async t => {
  const f = await fixture(t), id = f.local(f.a, "Closed Won", "15");
  f.db.prepare("UPDATE tasks SET assigned_to='remote-carol' WHERE id=?").run(id);
  const before = snapshot(f.db);
  assert.throws(() => f.s.reports.employeePerformance(f.a), isStatus(503));
  assert.throws(() => f.s.dashboard.getDashboard(f.a), isStatus(503));
  assert.equal(f.s.dashboard.getDashboard(f.c).sales!.total, 0); // Never falls back to conflicting external ownership.
  assert.deepEqual(snapshot(f.db), before);
  assert.throws(() => f.db.prepare("UPDATE crm_demo_local_tasks SET owner_user_id=3 WHERE task_id=?").run(id));
});

test("LOCAL REPORTS absent extension preserves exact reference responses and job export bytes", async t => {
  const f = await fixture(t, false); f.legacy("remote-alice", "Close to Won", "125.25"); f.legacy(null);
  const opts = { now: () => f.now }, before = snapshot(f.db), exports = createExportsService(f.db, opts), file = exports.exportJobs(f.a);
  assert.deepEqual(f.s.reports.employeePerformance(f.a), createReportsService(f.db, opts).employeePerformance(f.a));
  assert.deepEqual(f.s.dashboard.getDashboard(f.a), createDashboardService(f.db, opts).getDashboard(f.a));
  assert.deepEqual(exports.exportJobs(f.a), file); assert.equal(file.rowCount, 1);
  assert.deepEqual(snapshot(f.db), before);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='crm_demo_local_tasks'").get(), undefined);
});
