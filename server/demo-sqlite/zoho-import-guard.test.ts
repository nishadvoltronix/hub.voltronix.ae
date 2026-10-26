import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import { hashSync } from "bcryptjs";
import { configureDatabase, type SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { migrateDatabase } from "../../tests/sqlite-reference/db/migrations.js";
import { createSqliteDemoRuntime } from "./runtime.js";
import { applyLocalWorkflowExtension } from "./workflow-schema.js";
import { createZohoImportGuard, ZohoImportReadOnlyError } from "./zoho-import-guard.js";
import { applyZohoImportExtension, applyZohoSqliteImport, prepareZohoSqliteImport } from "./zoho-import-store.js";

const requireNext = createRequire(new URL("../../package.json", import.meta.url));
const Database = requireNext("better-sqlite3") as new (filename: string) => SqliteDatabase;
const password = "Synthetic import guard password", passwordHash = hashSync(password, 4);
const timestamp = "2026-10-15T08:00:00Z";
const marker = { provider: "zoho", readOnly: true };
function importSnapshot() {
  const common = { createdAt: timestamp, modifiedAt: timestamp, missingOptionalFields: [] };
  return { organizationId: "123", capturedAt: timestamp,
    products: [{ ...common, externalId: "8001", name: "Imported synthetic product", description: "Read only", unitPrice: "1.25" }],
    deals: [{ ...common, externalId: "9002", name: "Imported synthetic job", stage: "Closed Won", applicationStatus: "Close to Won",
      amount: "42.50", account: { externalId: "7001", name: "Synthetic company" }, contact: null, owner: null,
      assignedTo: { externalId: "901", name: "Synthetic owner" }, createdBy: null, dealNumber: "IMPORTED-DEAL",
      enquiryNumber: null, qualificationNumber: "IMPORTED-QUAL", siteNumber: null, quotationNumber: null,
      jobNumber: "IMPORTED-JOB", lostNumber: null, qualificationDate: null, siteDate: null, quotationDate: null,
      jobDate: timestamp, lostDate: null, email: "imported@example.invalid", phone: null, mobile: null,
      address: null, description: "Synthetic imported description", department: null, poBox: null, trn: null }],
    notes: [{ ...common, externalId: "6001", dealId: "9002", title: "Imported note", content: "Synthetic content", createdBy: null }],
    complete: true, snapshotConsistent: false, deletionsVerified: false, richTextCompletenessVerified: false,
    excludedNoteCounts: { otherModules: 0, unavailableDeals: 0 },
    excludedScopes: ["Quotes", "Attachments", "Users", "Accounts", "Contacts", "Deleted records", "History"], requestsPerformed: 3 };
}
async function fixture(t: TestContext, options: { imported?: boolean; workflow?: boolean } = {}) {
  const db = new Database(":memory:"); configureDatabase(db); migrateDatabase(db);
  for (const id of [1, 2]) db.prepare("INSERT INTO users(id,user_id,username,email,password,status,role,department_role) VALUES(?,?,?,?,?,'active','synthetic','Electrical')")
    .run(id, String(900 + id), `Synthetic user ${id}`, `guard-${id}@example.invalid`, passwordHash);
  for (const key of ["dashboard.view", "leads.view", "leads.manage", "items.view", "items.write", "electrical.manage", "deals.manage"]) {
    const result = db.prepare('INSERT INTO permissions("key",label) VALUES(?,?)').run(key, key);
    db.prepare("INSERT INTO admin_user_permissions(admin_user_id,permission_id) VALUES(1,?)").run(result.lastInsertRowid);
  }
  for (const key of ["leads.manage.agents", "electrical.manage"]) {
    db.prepare('INSERT OR IGNORE INTO permissions("key",label) VALUES(?,?)').run(key, key);
    db.prepare('INSERT INTO admin_user_permissions(admin_user_id,permission_id) SELECT 2,id FROM permissions WHERE "key"=?').run(key);
  }
  db.prepare("INSERT INTO tasks(id,zoho_crm_id,assigned_to,deal_name,status,Job_Status) VALUES(1,'9001','901','Existing synthetic task','Closed Won','Active')").run();
  if (options.workflow) applyLocalWorkflowExtension(db);
  const runtime = createSqliteDemoRuntime(db); t.after(() => runtime.close());
  const owner = (await runtime.auth.login("guard-1@example.invalid", password)).sessionToken;
  const other = (await runtime.auth.login("guard-2@example.invalid", password)).sessionToken;
  const imported = () => {
    applyZohoImportExtension(db, { organizationId: "123" });
    const plan = prepareZohoSqliteImport(db, importSnapshot(), { userMappings: [{ externalId: "901", localUserId: "1" }] });
    const receipt = applyZohoSqliteImport(db, plan, { runId: randomUUID(), importedAt: timestamp });
    assert.equal(receipt.summary.Deals.insert, 1); assert.equal(receipt.summary.Notes.insert, 1);
    const taskId = (db.prepare("SELECT CAST(id AS TEXT) id FROM tasks WHERE zoho_crm_id='9002'").get() as { id: string }).id;
    const noteId = (db.prepare("SELECT CAST(id AS TEXT) id FROM job_notes WHERE zoho_note_id='6001'").get() as { id: string }).id;
    // Synthetic setup only: exercise worker boundaries even if another caller
    // already had assignment history before attempting a forbidden change.
    db.prepare("INSERT INTO departments_assign(task_id,user_id,department,status) VALUES(?,1,'Electrical','Assigned')").run(taskId);
    return { taskId, noteId };
  };
  return { db, runtime, owner, other, imported, ...(options.imported === false ? {} : imported()) };
}
function snapshot(db: SqliteDatabase) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]));
}
async function denied(work: () => Promise<unknown>, status = 409) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error && typeof error === "object" && "status" in error); assert.equal(error.status, status);
    if (status === 409) { assert.ok(error instanceof Error); assert.match(error.message, /read-only local snapshots/); }
    return true;
  });
}

test("ZOHO IMPORT GUARD suppresses every imported task write before journals, files or business rows change", async t => {
  const f = await fixture(t), s = f.runtime.services, id = f.taskId!, before = snapshot(f.db);
  const note = { operationId: randomUUID(), expectedVersion: 1, title: "Changed", content: "Should not be stored" };
  const operations = [
    () => s.mutations.addNote(f.owner, id, note),
    () => s.mutations.editNote(f.owner, id, f.noteId!, note),
    () => s.mutations.changeStage(f.owner, id, { operationId: randomUUID(), expectedVersion: 1, stage: "Closed Lost" }),
    () => s.commercial.createQuotation(f.owner, id, { operationId: randomUUID(), expectedVersion: 1, quotation: {} }),
    () => s.commercial.updateQuotation(f.owner, id, { operationId: randomUUID(), expectedVersion: 1, expectedQuoteVersion: 1, quotation: {} }),
    () => s.jobs.updateStatus(f.owner, id, { expectedVersion: 1, jobStatus: "Hold" }),
    () => s.jobs.updateRemarks(f.owner, id, { expectedVersion: 1, remarks: "Changed" }),
    () => s.departments.assign(f.owner, id, { expectedVersion: 1, assignments: [{ department: "Electrical", userId: "1" }] }),
    () => s.departments.unassign(f.owner, id, { expectedVersion: 1, department: "Electrical" }),
    () => s.departments.assignAccounts(f.owner, id, { expectedVersion: 1, userId: "1" }),
    () => s.departments.updateStatus(f.owner, "Electrical", id, { expectedVersion: 1, status: "Process" }),
    () => s.departments.authorizeLog(f.owner, "Electrical", id),
    () => s.departments.addLog(f.owner, "Electrical", id, { expectedVersion: 1, status: "Anything", notes: "Changed" }),
    () => s.attachments.authorizeUpload(f.owner, id),
    () => s.attachments.upload(f.owner, id, { expectedVersion: 1, name: "synthetic.txt", mediaType: "text/plain" }, Buffer.from("Changed")),
  ];
  for (const operation of operations) { await denied(operation); assert.deepEqual(snapshot(f.db), before); }
});

test("ZOHO IMPORT GUARD authorized reads expose readonly provenance and capabilities without inventing ownership", async t => {
  const f = await fixture(t), s = f.runtime.services, id = f.taskId!, before = snapshot(f.db);
  const leads = await s.mutations.capabilities(f.owner, id);
  assert.equal(leads.canChangeStage, false); assert.equal(leads.canWriteNotes, false); assert.deepEqual(leads.stages, []);
  const quotes = await s.commercial.quotationCapabilities(f.owner, id);
  assert.equal(quotes.canCreate, false); assert.equal(quotes.canEdit, false); assert.equal(quotes.integrationAvailable, false);
  const attachments = await s.attachments.list(f.owner, id);
  assert.equal(attachments.canUpload, false);
  const authorized = [leads, quotes, attachments, await s.leads.getLead(f.owner, id), await s.jobs.getJob(f.owner, id),
    await s.departments.getAssignments(f.owner, id), await s.departments.getJob(f.owner, "Electrical", id),
    (await s.leads.listPipeline(f.owner, {})).items.find(row => row.id === id),
    (await s.jobs.listJobs(f.owner, {})).items.find(row => row.id === id),
    (await s.localReads!.listJobs(f.owner, {})).items.find(row => row.id === id),
    (await s.departments.listQueue(f.owner, "Electrical", {})).items.find(row => row.id === id)];
  for (const row of authorized) assert.deepEqual((row as { sourceImport?: unknown }).sourceImport, marker);
  const ordinary = await s.leads.getLead(f.owner, "1"); assert.equal("sourceImport" in ordinary, false);
  assert.equal((await s.mutations.capabilities(f.owner, "1")).canWriteNotes, true);
  assert.equal((await s.attachments.list(f.owner, "1")).canUpload, true);
  assert.deepEqual(snapshot(f.db), before);
});

test("ZOHO IMPORT GUARD retains authentication and existing resource scopes ahead of readonly responses", async t => {
  const f = await fixture(t), s = f.runtime.services, id = f.taskId!, before = snapshot(f.db);
  const note = { operationId: randomUUID(), expectedVersion: 1, title: "Changed", content: "Changed" };
  await denied(() => s.mutations.addNote(null, id, note), 401);
  await denied(() => s.mutations.addNote(f.other, id, note), 404);
  await denied(() => s.jobs.updateRemarks(f.other, id, { expectedVersion: 1, remarks: "Changed" }), 403);
  await denied(() => s.departments.assign(f.other, id, {}), 403);
  await denied(() => s.departments.updateStatus(f.other, "Electrical", id, {}), 404);
  await denied(() => s.attachments.authorizeUpload(f.other, id), 404);
  await denied(() => s.commercial.createQuotation(f.other, id, {}), 404);
  await denied(() => s.mutations.addNote(f.owner, "not-an-id", note), 404);
  assert.deepEqual(snapshot(f.db), before);
});

test("ZOHO IMPORT GUARD detects later extension membership without disabling existing and new local workflows", async t => {
  const f = await fixture(t, { imported: false, workflow: true }), s = f.runtime.services, guard = createZohoImportGuard(f.db);
  assert.equal(guard.isImported("1"), false);
  const { taskId } = f.imported(); assert.equal(guard.isImported(taskId), true); assert.equal(guard.isImported("1"), false);
  let authorized = false;
  assert.throws(() => guard.assertWritable(taskId, () => { authorized = true; }), ZohoImportReadOnlyError); assert.equal(authorized, true);
  for (const invalid of [2, null, {}, "0", "02", "9223372036854775808", "2 OR 1=1"]) assert.equal(guard.isImported(invalid), false);
  const note = { operationId: randomUUID(), expectedVersion: 1, title: "Existing allowed note", content: "Existing behavior" };
  const saved = await s.mutations.addNote(f.owner, "1", note); assert.equal(saved.version, 2);
  const status = await s.jobs.updateStatus(f.owner, "1", { expectedVersion: 2, jobStatus: "Hold" }); assert.equal(status.version, 3);
  const created = await s.mutations.createDeal(f.owner, { operationId: randomUUID(), firstName: "Synthetic", lastName: "Local",
    companyName: "Synthetic local company", email: "local@example.invalid", mobile: "1", phone: "1", department: "VOLTRONIX CONTRACTING LLC" });
  const local = await s.mutations.addNote(f.owner, created.taskId, { ...note, operationId: randomUUID() }); assert.equal(local.version, 2);
  assert.equal(guard.isImported(created.taskId), false);
  assert.equal((await s.mutations.capabilities(f.owner, created.taskId)).canWriteNotes, true);
  assert.equal("localOwnerId" in await s.leads.getLead(f.owner, taskId), false);
});

test("ZOHO IMPORT GUARD fails closed with redacted errors if import provenance schema is partial or changed", async t => {
  const f = await fixture(t), before = snapshot(f.db);
  f.db.exec("DROP TRIGGER crm_demo_zoho_import_tasks_no_update");
  await denied(() => f.runtime.services.mutations.addNote(f.owner, f.taskId!, {
    operationId: randomUUID(), expectedVersion: 1, title: "private marker", content: "private marker" }), 503);
  await assert.rejects(f.runtime.services.leads.getLead(f.owner, f.taskId!), error => {
    assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /private marker|SCHEMA_INVALID|crm_demo/); return true;
  });
  assert.deepEqual(snapshot(f.db), before);
});
