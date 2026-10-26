import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { hashSync } from "bcryptjs";
import { configureDatabase } from "./sqlite-reference/db/connection";
import { migrateDatabase } from "./sqlite-reference/db/migrations";
import { createAuthService } from "./sqlite-reference/auth/service";
import { createReportsService, ReportError } from "./sqlite-reference/reports/service";
const now = Date.parse("2026-10-10T10:00:00Z");
async function fixture(t: TestContext) {
  const db = new Database(":memory:"); configureDatabase(db); migrateDatabase(db); t.after(() => db.close());
  const password = "Synthetic report password", hash = hashSync(password, 4);
  for (let i = 1; i <= 3; i++) db.prepare("INSERT INTO users(id,user_id,username,email,password) VALUES(?,?,?,?,?)").run(i, i === 3 ? null : `external-${i}`, `Employee ${i}`, `report${i}@example.test`, hash);
  db.exec("INSERT INTO permissions(id,key,label) VALUES(1,'dashboard.view','Dashboard'); INSERT INTO admin_user_permissions(admin_user_id,permission_id) VALUES(1,1)");
  const auth = createAuthService(db, { now: () => now });
  const signIn = async (id: number) => (await auth.login(`report${id}@example.test`, password, "fixture")).sessionToken;
  const service = createReportsService(db, { now: () => now });
  const task = (id: number, status = "Close to Won", charge: string | null = "100.10", owner: string | null = "external-2", created = "2026-10-05 12:00:00", job: string | null = "Active") => {
    db.prepare("INSERT INTO tasks(id,deal_name,status,service_charge,assigned_to,created_at,Job_Status) VALUES(?,?,?,?,?,?,?)").run(id, `Synthetic ${id}`, status, charge, owner, created, job);
  };
  return { db, service, token: await signIn(1), denied: await signIn(2), task };
}
const status = (expected: number) => (error: unknown) => error instanceof ReportError && error.status === expected;
test("report requires current global dashboard permission before validation; empty data yields real zero counts", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.service.employeePerformance(null), status(401));
  assert.throws(() => f.service.employeePerformance(f.denied, { invalid: true }), status(403));
  assert.equal(f.service.employeePerformance(f.token).summary.totalDeals, 0);
  f.db.exec("DELETE FROM admin_user_permissions");
  assert.throws(() => f.service.employeePerformance(f.token), status(403));
});
test("report aggregates sales and assignments independently, counts latest distinct tasks, and never joins null external owners", async (t) => {
  const f = await fixture(t); f.task(1); f.task(2, "Closed Won", "200.20"); f.task(3, "Qualification", null, null);
  f.db.exec(`INSERT INTO departments_assign(task_id,user_id,department,status) VALUES
    (1,1,'Electrical','Assigned'),(1,2,'Electrical','Completed'),(1,2,'Civil','Completed'),(2,2,'PM','Process')`);
  const result = f.service.employeePerformance(f.token);
  assert.equal(result.summary.totalDeals, 3); assert.equal(result.summary.wonAmount, "300.30");
  const employee = result.employees.items.find((row) => row.id === "2")!;
  assert.equal(employee.totalDeals, 2); assert.equal(employee.won, 2); assert.equal(employee.wonAmount, "300.30");
  assert.deepEqual([employee.electrical, employee.civil, employee.pm, employee.completed, employee.process, employee.active], [1, 1, 1, 1, 1, 2]);
  assert.equal(result.employees.items.find((row) => row.id === "1")!.electrical, 0);
  assert.equal(result.employees.items.find((row) => row.id === "3")!.totalDeals, 0);
});
test("Dubai inclusive date filters apply to both sales and department task creation; monthly chart is independent", async (t) => {
  const f = await fixture(t);
  f.task(1, "Closed Won", "1", "external-2", "2026-09-30T19:59:59Z");
  f.task(2, "Closed Won", "2", "external-2", "2026-09-30T20:00:00Z");
  f.task(3, "Closed Won", "3", "external-2", "2026-10-01T20:00:00Z");
  f.task(4, "Closed Won", "4", "external-2", "2026-04-30T20:00:00Z");
  f.task(5, "Closed Won", "5", "external-2", "2026-04-30T19:59:59Z");
  f.db.exec("INSERT INTO departments_assign(task_id,user_id,department,status) VALUES(1,2,'Electrical','Assigned'),(2,2,'Electrical','Assigned'),(3,2,'Electrical','Assigned')");
  const result = f.service.employeePerformance(f.token, { dateFrom: "2026-10-01", dateTo: "2026-10-01" });
  assert.equal(result.summary.totalDeals, 1); assert.equal(result.summary.wonAmount, "2.00");
  assert.equal(result.employees.items.find((row) => row.id === "2")!.electrical, 1);
  assert.equal(result.monthlySince, "2026-05-01");
  assert.deepEqual(result.monthly.map((row) => [row.month, row.wonAmount]), [["2026-05", "4.00"], ["2026-09", "1.00"], ["2026-10", "5.00"]]);
});
test("report preserves source stage aliases and separates all-deal summary from won-only job chart", async (t) => {
  const f = await fixture(t);
  ["Pending", "Qualification", "Site Visit", "Proposal", "Proposal/Price Quote", "Closed Won", "Close to Won", "Closed Lost", "Close to Lost", "Omitted", "Proposal-Omitted", "Proposal Omitted", "Unknown"].forEach((value, i) => f.task(i + 1, value, "0"));
  const result = f.service.employeePerformance(f.token);
  assert.deepEqual(result.stages, { qualification: 2, siteVisit: 1, proposal: 2, won: 2, lost: 2, omitted: 1, proposalOmitted: 2 });
  assert.equal(result.summary.active, 13); assert.equal(result.wonJobStatuses.active, 2);
});
test("monetary totals remain exact, unknown stays unknown and malformed money fails safely", async (t) => {
  const f = await fixture(t); f.task(1, "Closed Won", "9007199254740993.123456789012345678"); f.task(2, "Closed Won", "0.000000000000000001");
  assert.equal(f.service.employeePerformance(f.token).summary.wonAmount, "9007199254740993.123456789012345679");
  f.task(3, "Closed Won", null);
  assert.equal(f.service.employeePerformance(f.token).summary.wonAmount, null);
  assert.equal(f.service.employeePerformance(f.token).summary.unknownAmounts, 1);
  f.db.exec("UPDATE tasks SET service_charge='private invalid source value' WHERE id=3");
  assert.throws(() => f.service.employeePerformance(f.token), (error: unknown) => status(503)(error) && !(error as Error).message.includes("private"));
});
test("employee search and pagination are literal and stable; invalid dates and ranges are rejected", async (t) => {
  const f = await fixture(t); f.db.exec("UPDATE users SET username='100%_ Employee' WHERE id=2; UPDATE users SET status='inactive' WHERE id=3");
  const result = f.service.employeePerformance(f.token, { query: "%_", pageSize: 1 });
  assert.equal(result.employees.total, 1); assert.equal(result.employees.items[0]!.id, "2"); assert.equal(result.summary.activeEmployees, 2);
  assert.equal(f.service.employeePerformance(f.token, { query: "' OR 1=1 --" }).employees.total, 0);
  assert.equal(f.service.employeePerformance(f.token, { page: 2, pageSize: 1 }).employees.items.length, 1);
  for (const input of [{ dateFrom: "2026-02-30" }, { dateFrom: "2026-11-01", dateTo: "2026-10-01" }, { pageSize: 101 }, { query: "\0" }, { extra: true }]) assert.throws(() => f.service.employeePerformance(f.token, input), status(400));
});
