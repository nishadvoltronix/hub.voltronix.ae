import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import { hashSync } from "bcryptjs";
import { strFromU8, unzipSync } from "fflate";
import { configureDatabase, type SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { migrateDatabase } from "../../tests/sqlite-reference/db/migrations.js";
import { createAuthService } from "../../tests/sqlite-reference/auth/service.js";
import { createExportsService } from "../../tests/sqlite-reference/exports/service.js";
import type { ZohoInboundSnapshot } from "../src/integrations/zoho/inbound-snapshot.js";
import { createLocalDemoReads, LocalReadError } from "./local-reads.js";
import { createSqliteDemoRuntime } from "./runtime.js";
import { applyZohoImportExtension, applyZohoSqliteImport, prepareZohoSqliteImport } from "./zoho-import-store.js";

const requireFrontend = createRequire(new URL("../../package.json", import.meta.url));
const Database = requireFrontend("better-sqlite3") as new (filename: string) => SqliteDatabase;
const password = "Synthetic local import read fixture", at = "2026-10-16T08:00:00Z";
const status = (value: number) => (error: unknown) => error instanceof LocalReadError && error.status === value;
function importedSnapshot(): ZohoInboundSnapshot {
  return { organizationId: "123", capturedAt: at, complete: true, snapshotConsistent: false, deletionsVerified: false,
    richTextCompletenessVerified: false, excludedScopes: ["Quotes", "Attachments", "Users", "Accounts", "Contacts", "Deleted records", "History"],
    requestsPerformed: 3, excludedNoteCounts: { otherModules: 0, unavailableDeals: 0 }, products: [], notes: [],
    deals: ["901", "902"].map((externalId, index) => ({ externalId, name: `Imported synthetic ${index}`, stage: "Closed Won",
      createdAt: at, modifiedAt: at, missingOptionalFields: [], applicationStatus: null, amount: index === 0 ? "42.50" : null,
      account: null, contact: null, owner: null, assignedTo: null, createdBy: null, dealNumber: null, enquiryNumber: null,
      qualificationNumber: null, siteNumber: null, quotationNumber: null, jobNumber: `IMPORT-${index}`, lostNumber: null,
      qualificationDate: null, siteDate: null, quotationDate: null, jobDate: null, lostDate: null, email: null, phone: null,
      mobile: null, address: null, description: null, department: null, poBox: null, trn: null })) };
}
function workbookRows(bytes: Uint8Array): string[][] {
  const xml = strFromU8(unzipSync(bytes)["xl/worksheets/sheet1.xml"]!);
  return [...xml.matchAll(/<row\b[^>]*>(.*?)<\/row>/gs)].map(row => [...row[1]!.matchAll(/<t\b[^>]*>(.*?)<\/t>/gs)].map(cell => cell[1]!));
}
function state(db: SqliteDatabase) {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => ({ name, rows: db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all() }));
}
async function fixture(t: TestContext) {
  const db = new Database(":memory:"); configureDatabase(db); migrateDatabase(db); t.after(() => { if (db.open) db.close(); });
  for (const id of [1, 2]) db.prepare("INSERT INTO users(id,username,email,password,status) VALUES(?,?,?,?, 'active')")
    .run(id, `Synthetic user ${id}`, `import-reads-${id}@example.invalid`, hashSync(password, 4));
  const permission = db.prepare('INSERT INTO permissions("key",label) VALUES(?,?)').run("dashboard.view", "Dashboard");
  db.prepare("INSERT INTO admin_user_permissions(admin_user_id,permission_id) VALUES(1,?)").run(permission.lastInsertRowid);
  for (const [index, jobStatus] of [null, "", "Active", "Closed"].entries()) {
    db.prepare("INSERT INTO tasks(id,zoho_crm_id,deal_name,status,Job_Status,job_deal_number,service_charge) VALUES(?,?,?,'Closed Won',?,?,?)")
      .run(index + 1, String(801 + index), `Existing synthetic ${index}`, jobStatus, `LOCAL-${index}`, "10.00");
  }
  const auth = createAuthService(db);
  const token = (await auth.login("import-reads-1@example.invalid", password, "local-import-reads")).sessionToken;
  const denied = (await auth.login("import-reads-2@example.invalid", password, "local-import-reads-denied")).sessionToken;
  const reads = createLocalDemoReads(db); // Deliberately constructed before the extension exists.
  function apply() {
    const snapshot = importedSnapshot(), plan = prepareZohoSqliteImport(db, snapshot, { userMappings: [] });
    applyZohoImportExtension(db, { organizationId: snapshot.organizationId });
    applyZohoSqliteImport(db, plan, { runId: randomUUID(), importedAt: at });
  }
  return { db, token, denied, reads, apply };
}

test("import-aware job reads retain native missing-status defaults before and after an additive import", async t => {
  const f = await fixture(t), numbers = (input: unknown) => f.reads.listJobs(f.token, input).items.map(row => row.jobNumber).sort();
  assert.equal(f.reads.listJobs(f.token).total, 4);
  assert.deepEqual(numbers({ cohort: "pending" }), ["LOCAL-0", "LOCAL-1", "LOCAL-2"]);
  assert.deepEqual(numbers({ jobStatus: "Active" }), ["LOCAL-0", "LOCAL-1", "LOCAL-2"]);
  f.apply(); const before = state(f.db);
  assert.equal(f.reads.listJobs(f.token).total, 6);
  assert.deepEqual(numbers({ cohort: "pending" }), ["LOCAL-0", "LOCAL-1", "LOCAL-2"]);
  assert.deepEqual(numbers({ jobStatus: "Active" }), ["LOCAL-0", "LOCAL-1", "LOCAL-2"]);
  assert.deepEqual(numbers({ cohort: "closed" }), ["LOCAL-3"]);
  assert.equal(f.reads.listJobs(f.token, { pageSize: 1, page: 6 }).total, 6);
  assert.equal(f.reads.listJobs(f.token, { pageSize: 1, page: 6 }).items.length, 1);
  assert.equal(f.reads.listJobs(f.token, { query: "Imported synthetic" }).total, 2);
  assert.equal(f.reads.listJobs(f.token, { query: "Imported synthetic", cohort: "pending" }).total, 0);
  assert.equal(f.reads.listJobs(f.token, { query: "Imported synthetic", jobStatus: "Active" }).total, 0);
  assert.deepEqual(state(f.db), before);
});

test("job exports distinguish absent imported operational history and retain unknown amounts without fabricating currency", async t => {
  const f = await fixture(t); f.apply(); const before = state(f.db);
  const result = f.reads.exportJobs(f.token), rows = workbookRows(result.bytes).slice(1);
  assert.equal(result.rowCount, 6);
  const imported = rows.filter(row => row[1]!.startsWith("IMPORT-")); assert.equal(imported.length, 2);
  for (const row of imported) assert.deepEqual(row.slice(5, 9), ["Not imported", "Not imported", "Not imported", "Not imported"]);
  assert.equal(imported.find(row => row[1] === "IMPORT-0")![9], "42.50");
  assert.equal(imported.find(row => row[1] === "IMPORT-1")![9], "");
  for (const row of rows.filter(row => row[1]!.startsWith("LOCAL-"))) assert.deepEqual(row.slice(5, 9), ["Not Assigned", "Not Assigned", "Not Assigned", ""]);
  for (const input of [{}, { cohort: "pending" }, { jobStatus: "Active" }, { cohort: "closed" }, { query: "Imported synthetic" },
    { cohort: "pending", query: "Imported synthetic" }, { jobStatus: "Active", query: "Imported synthetic" }]) {
    const page = f.reads.listJobs(f.token, input), exported = f.reads.exportJobs(f.token, input);
    assert.equal(exported.rowCount, page.total);
    assert.deepEqual(workbookRows(exported.bytes).slice(1).map(row => row[1]), page.items.map(row => row.jobNumber));
  }
  assert.deepEqual(state(f.db), before);
});

test("job import coverage checks remain behind authentication and permission gates and fail closed on damaged provenance", async t => {
  const f = await fixture(t); f.apply();
  for (const method of [f.reads.listJobs, f.reads.exportJobs]) {
    assert.throws(() => method(null), status(401)); assert.throws(() => method(f.denied), status(403));
    assert.throws(() => method(f.token, { jobStatus: "unknown" }), status(400));
  }
  f.db.exec("DROP TRIGGER crm_demo_zoho_import_tasks_no_update"); // In-memory fixture only.
  const before = state(f.db);
  for (const method of [f.reads.listJobs, f.reads.exportJobs]) {
    assert.throws(() => method(null), status(401)); assert.throws(() => method(f.denied), status(403));
    assert.throws(() => method(f.token), error => {
      assert.ok(error instanceof LocalReadError); assert.equal(error.status, 503);
      assert.equal(error.message, "Local lists are temporarily unavailable."); return true;
    });
  }
  assert.deepEqual(state(f.db), before);
});

test("direct central export composition shares import coverage and preserves default native and worker export output", async t => {
  const f = await fixture(t), runtime = createSqliteDemoRuntime(f.db), legacy = createExportsService(f.db);
  try {
    assert.deepEqual(await runtime.services.exports.exportJobs(f.token), legacy.exportJobs(f.token));
    const permission = f.db.prepare('INSERT INTO permissions("key",label) VALUES(?,?)').run("electrical.manage", "Electrical");
    f.db.prepare("INSERT INTO admin_user_permissions(admin_user_id,permission_id) VALUES(1,?)").run(permission.lastInsertRowid);
    f.db.prepare("INSERT INTO departments_assign(task_id,user_id,department,status) VALUES(1,1,'Electrical','Assigned')").run();
    const workerBefore = legacy.exportDepartmentJobs(f.token, "Electrical");
    assert.deepEqual(await runtime.services.exports.exportDepartmentJobs(f.token, "Electrical"), workerBefore);
    f.apply();
    assert.deepEqual(await runtime.services.exports.exportJobs(f.token), f.reads.exportJobs(f.token));
    assert.deepEqual(await runtime.services.exports.exportJobs(f.token, { jobStatus: "Active" }), f.reads.exportJobs(f.token, { jobStatus: "Active" }));
    assert.deepEqual(await runtime.services.exports.exportDepartmentJobs(f.token, "Electrical"), workerBefore);
    await assert.rejects(runtime.services.exports.exportJobs(f.denied), error => {
      assert.ok(error && typeof error === "object" && "status" in error); assert.equal(error.status, 403); return true;
    });
  } finally { await runtime.close(); }
});
