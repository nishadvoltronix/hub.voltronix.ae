import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import { hashSync } from "bcryptjs";
import { configureDatabase, type SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { migrateDatabase } from "../../tests/sqlite-reference/db/migrations.js";
import { createAuthService } from "../../tests/sqlite-reference/auth/service.js";
import { createDashboardService, DashboardError } from "../../tests/sqlite-reference/dashboard/service.js";
import type { ZohoInboundSnapshot } from "../src/integrations/zoho/inbound-snapshot.js";
import { applyZohoImportExtension, applyZohoSqliteImport, prepareZohoSqliteImport } from "./zoho-import-store.js";
import { createLocalOwnerReports } from "./local-owner-reports.js";

const requireFrontend = createRequire(new URL("../../package.json", import.meta.url));
const Database = requireFrontend("better-sqlite3") as new (filename: string) => SqliteDatabase;
const asOf = "2026-10-16T10:00:00Z", now = Date.parse(asOf), password = "Memory fixture only coverage";
const status = (value: number) => (error: unknown) => error instanceof DashboardError && error.status === value;
function snapshot(): ZohoInboundSnapshot {
  return { organizationId: "123", capturedAt: asOf, complete: true, snapshotConsistent: false, deletionsVerified: false,
    richTextCompletenessVerified: false, excludedScopes: ["Quotes", "Attachments", "Users", "Accounts", "Contacts", "Deleted records", "History"],
    excludedNoteCounts: { otherModules: 0, unavailableDeals: 0 }, requestsPerformed: 3, products: [], notes: [],
    deals: ["Closed Won", "Qualification", "Unverified source stage"].map((stage, i) => ({
      externalId: String(901 + i), name: "Synthetic imported deal", stage, applicationStatus: null, amount: "123.45",
      createdAt: ["2026-10-16T00:00:00+04:00", "2026-10-15T23:59:59+04:00", "2026-09-30T23:59:59+04:00"][i]!,
      modifiedAt: asOf, missingOptionalFields: [], account: null, contact: null, owner: null, assignedTo: null, createdBy: null,
      dealNumber: null, enquiryNumber: null, qualificationNumber: null, siteNumber: null, quotationNumber: null, jobNumber: null, lostNumber: null,
      qualificationDate: null, siteDate: null, quotationDate: null, jobDate: null, lostDate: null, email: null, phone: null, mobile: null,
      address: null, description: null, department: null, poBox: null, trn: null,
    })) };
}
function state(db: SqliteDatabase) {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => ({ name, rows: db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all() }));
}
async function fixture(t: TestContext) {
  const db = new Database(":memory:"); configureDatabase(db); migrateDatabase(db); t.after(() => db.close());
  db.prepare("INSERT INTO users(id,username,email,password,status) VALUES(1,'Local fixture','fixture@example.invalid',?,'active')").run(hashSync(password, 4));
  for (const key of ["dashboard.view", "sales_dashboard.view"]) {
    const permission = db.prepare('INSERT INTO permissions("key",label) VALUES(?,?)').run(key, key);
    db.prepare("INSERT INTO admin_user_permissions(admin_user_id,permission_id) VALUES(1,?)").run(permission.lastInsertRowid);
  }
  db.prepare("INSERT INTO tasks(zoho_crm_id,deal_name,status,service_charge,created_at,updated_at) VALUES('777','Existing local row','Closed Won','999',?,?)").run(asOf, asOf);
  const auth = createAuthService(db, { now: () => now });
  const token = (await auth.login("fixture@example.invalid", password, "coverage-test")).sessionToken;
  // Construct before importing, so missing-extension state cannot be cached.
  const services = createLocalOwnerReports(db, { now: () => now }), service = services.dashboard;
  const read = () => service.getDashboard(token);
  function apply(data = snapshot()) {
    const plan = prepareZohoSqliteImport(db, data, { userMappings: [] });
    applyZohoImportExtension(db, { organizationId: data.organizationId });
    applyZohoSqliteImport(db, plan, { runId: randomUUID(), importedAt: asOf });
  }
  return { db, service, token, read, apply, reports: services.reports };
}

test("dashboard coverage preserves native output before import and when the import has no deals", async t => {
  const f = await fixture(t), reference = createDashboardService(f.db, { now: () => now });
  const before = state(f.db); assert.deepEqual(f.read(), reference.getDashboard(f.token)); assert.deepEqual(state(f.db), before);
  f.apply({ ...snapshot(), deals: [] });
  assert.deepEqual(f.read(), reference.getDashboard(f.token)); assert.equal(f.read().sourceCoverage, undefined);
});

test("dashboard separates imported and local populations and represents missing operations as null, not false pending/zero", async t => {
  const f = await fixture(t); f.apply(); const before = state(f.db), result = f.read();
  assert.deepEqual(result.sourceCoverage, { mode: "local-zoho-snapshot", importedDeals: 3, localDeals: 1,
    importedWonJobs: 1, localWonJobs: 1, importedAt: asOf, operationalHistory: "not-imported", users: "local-only" });
  assert.equal(result.global!.wonJobs, 1);
  assert.equal(result.global!.pendingAssignmentJobs, null); assert.equal(result.global!.completedJobs, null);
  assert.deepEqual(result.global!.accounts, { totalPending: null, pendingJobs: null, unknownServiceChargeJobs: 0 });
  assert.equal(result.global!.employees.items[0]!.name, "Local fixture");
  assert.deepEqual(state(f.db), before); // No histories, users, financial data or rows are manufactured.
});

test("imported pipeline includes unmapped stages and lead dates use source creation times in Dubai", async t => {
  const f = await fixture(t); f.apply(); const { global } = f.read();
  assert.equal(global!.leadsToday, 1); assert.equal(global!.leadsThisMonth, 2);
  assert.equal(global!.pipeline.reduce((n, stage) => n + stage.count, 0), 3);
  assert.deepEqual(global!.pipeline.find(stage => stage.key === "unmapped"),
    { key: "unmapped", label: "Other / unmapped stages", count: 1, percentage: "33.33" });
  assert.equal(global!.pipeline.find(stage => stage.key === "won")!.percentage, "33.33");
});

test("dashboard import counts do not bypass authentication, section permissions, search or pagination", async t => {
  const f = await fixture(t); f.apply();
  assert.throws(() => f.service.getDashboard(null), status(401));
  assert.equal(f.service.getDashboard(f.token, { employeeSearch: "missing" }).global!.employees.total, 0);
  assert.equal(f.service.getDashboard(f.token, { employeePage: 2, employeePageSize: 1 }).global!.employees.items.length, 0);
  f.db.prepare('DELETE FROM admin_user_permissions WHERE permission_id=(SELECT id FROM permissions WHERE "key"=\'dashboard.view\')').run();
  const restricted = f.read(); assert.equal(restricted.global, undefined); assert.equal(restricted.sourceCoverage, undefined);
  assert.throws(() => f.service.getDashboard(f.token, { employeeSearch: "Local" }), status(403));
  f.db.prepare("DELETE FROM admin_user_permissions").run(); assert.throws(f.read, status(403));
});

test("damaged import schema fails closed without exposing driver details or repairing records", async t => {
  const f = await fixture(t); f.apply();
  f.db.exec("DROP TRIGGER crm_demo_zoho_import_tasks_no_update"); // Disposable fixture only.
  const before = state(f.db); assert.throws(f.read, status(503)); assert.deepEqual(state(f.db), before);
});

test("reports retain mixed deal totals but exclude unknown imported statuses from Active with date-scoped coverage", async t => {
  const f = await fixture(t); f.apply(); const before = state(f.db);
  const report = f.reports.employeePerformance(f.token, { dateFrom: "2026-09-01", dateTo: "2026-10-16" });
  assert.equal(report.summary.totalDeals, 4); assert.equal(report.summary.wonJobs, 2);
  assert.equal(report.summary.active, 1); assert.equal(report.wonJobStatuses.active, 1);
  assert.deepEqual(report.sourceCoverage, { mode: "local-zoho-snapshot", importedDeals: 3, importedWonJobs: 1,
    operationalHistory: "not-imported", users: "local-only" });
  const today = f.reports.employeePerformance(f.token, { dateFrom: "2026-10-16", dateTo: "2026-10-16" });
  assert.equal(today.sourceCoverage!.importedDeals, 1); assert.equal(today.summary.active, 1);
  const empty = f.reports.employeePerformance(f.token, { dateFrom: "2026-08-01", dateTo: "2026-08-31" });
  assert.equal(empty.sourceCoverage!.importedDeals, 0); assert.equal(empty.summary.active, 0);
  assert.deepEqual(state(f.db), before);
});
