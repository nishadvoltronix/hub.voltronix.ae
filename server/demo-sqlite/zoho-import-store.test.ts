import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import { configureDatabase, type SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { migrateDatabase } from "../../tests/sqlite-reference/db/migrations.js";
import type { ZohoInboundSnapshot } from "../src/integrations/zoho/inbound-snapshot.js";
import { applyZohoImportExtension, applyZohoSqliteImport, inspectZohoImportExtension, prepareZohoSqliteImport,
  ZohoSqliteImportError, type ZohoSqliteImportPlan } from "./zoho-import-store.js";

const requireFrontend = createRequire(new URL("../../package.json", import.meta.url));
const Database = requireFrontend("better-sqlite3") as new (filename: string) => SqliteDatabase;
const createdAt = "2024-04-01T10:00:00+04:00", modifiedAt = "2025-04-01T10:00:00+04:00", importedAt = "2026-10-15T10:00:00Z";
const mappings = { userMappings: [{ externalId: "101", localUserId: "1" }] };
const code = (expected: string) => (error: unknown) => error instanceof ZohoSqliteImportError && error.code === expected;
function snapshot(): ZohoInboundSnapshot {
  const times = { createdAt, modifiedAt, missingOptionalFields: [] };
  return { organizationId: "123", capturedAt: importedAt, complete: true, snapshotConsistent: false, deletionsVerified: false,
    richTextCompletenessVerified: false, excludedScopes: ["Quotes", "Attachments", "Users", "Accounts", "Contacts", "Deleted records", "History"],
    excludedNoteCounts: { otherModules: 0, unavailableDeals: 0 }, requestsPerformed: 3,
    products: [{ ...times, externalId: "900719925474099301", name: "Synthetic product", description: "Source description",
      unitPrice: "9007199254740993.123456789123456789" }],
    deals: [{ ...times, externalId: "900719925474099302", name: "Synthetic deal", stage: "Needs Analysis", applicationStatus: "Site Visit",
      amount: "12.5000", assignedTo: { externalId: "101", name: "Assigned synthetic user" }, owner: { externalId: "999", name: "Different source owner" },
      createdBy: { externalId: "101", name: "Not local CRM creation proof" }, account: { externalId: "201", name: "Synthetic account" },
      contact: { externalId: "301", name: "Synthetic contact" }, dealNumber: "D-1", enquiryNumber: "E-1", qualificationNumber: "Q-1",
      siteNumber: "S-1", quotationNumber: null, jobNumber: null, lostNumber: null, qualificationDate: createdAt, siteDate: modifiedAt,
      quotationDate: null, jobDate: null, lostDate: null, email: "synthetic@example.invalid", phone: "0001", mobile: "0002", address: "Synthetic address",
      description: "Literal source description", department: "Source department only", poBox: "12", trn: "34" }],
    notes: [{ ...times, externalId: "900719925474099303", dealId: "900719925474099302", title: "Source note", content: "Source content", createdBy: null }],
  };
}
function fixture(t: TestContext) {
  const db = new Database(":memory:"); configureDatabase(db); migrateDatabase(db); t.after(() => db.close());
  db.prepare("INSERT INTO users(id,user_id,username,email,password,status) VALUES(1,'101','Synthetic user','owner@example.invalid','synthetic','active')").run();
  return db;
}
function saved(db: SqliteDatabase, table: string) { return db.prepare(`SELECT * FROM ${table}`).all(); }
function apply(db: SqliteDatabase, data = snapshot()) {
  const plan = prepareZohoSqliteImport(db, data, mappings);
  applyZohoImportExtension(db, { organizationId: data.organizationId });
  return applyZohoSqliteImport(db, plan, { runId: randomUUID(), importedAt });
}

test("Zoho import preparation is read-only and explicit extension preserves baseline schema and source pin", t => {
  const db = fixture(t), before = saved(db, "sqlite_schema");
  assert.equal(inspectZohoImportExtension(db), false);
  const plan = prepareZohoSqliteImport(db, snapshot(), mappings);
  assert.deepEqual(saved(db, "sqlite_schema"), before); assert.equal(saved(db, "tasks").length, 0);
  for (const module of ["Products", "Deals", "Notes"] as const) assert.equal(plan.summary[module].insert, 1);
  assert.equal(Object.isFrozen(plan), true); assert.equal(Object.isFrozen(plan.summary.Products), true);
  assert.equal(applyZohoImportExtension(db, { organizationId: "123" }).applied, true);
  assert.equal(applyZohoImportExtension(db, { organizationId: "123" }).applied, false);
  assert.equal(inspectZohoImportExtension(db), true);
  assert.throws(() => applyZohoImportExtension(db, { organizationId: "456" }), code("SOURCE_MISMATCH"));
  assert.deepEqual(saved(db, "sqlite_schema").filter((row: unknown) => {
    const value = row as { name: string; tbl_name: string };
    return !value.name.startsWith("crm_demo_zoho_import_") && !value.tbl_name.startsWith("crm_demo_zoho_import_");
  }), before);
});

test("Zoho import preserves IDs, decimals, true source dates and correct assignment without fabricating workflow history", t => {
  const db = fixture(t), users = saved(db, "users"), data = snapshot(), result = apply(db, data);
  assert.equal(result.replayed, false); assert.equal(result.summary.Deals.insert, 1);
  const product = db.prepare("SELECT * FROM products").get() as Record<string, unknown>;
  assert.equal(product.product_id, data.products[0]!.externalId); assert.equal(product.unit_price, data.products[0]!.unitPrice);
  const task = db.prepare("SELECT * FROM tasks").get() as Record<string, unknown>;
  assert.equal(task.zoho_crm_id, data.deals[0]!.externalId); assert.equal(task.assigned_to, "101"); assert.equal(task.owner_id, "999");
  assert.equal(task.status, "Site Visit"); assert.equal(task.deal_crm_created_by, null); assert.equal(task.version, 1);
  assert.equal(task.created_at, createdAt); assert.equal(task.updated_at, modifiedAt); assert.equal(task.service_charge, "12.5000");
  assert.equal(task.site_deal_number, "S-1"); assert.equal(task.site_deal_date, modifiedAt); assert.equal(task.quote_id, null);
  const note = db.prepare("SELECT * FROM job_notes").get() as Record<string, unknown>;
  assert.equal(note.zoho_note_id, data.notes[0]!.externalId); assert.equal(note.deal_id, task.zoho_crm_id); assert.equal(note.created_at, createdAt);
  const provenance = db.prepare("SELECT source_json FROM crm_demo_zoho_import_records WHERE module='Deals'").get() as { source_json: string };
  assert.deepEqual(JSON.parse(provenance.source_json), data.deals[0]); assert.deepEqual(saved(db, "users"), users);
  for (const table of ["tasks_status_log", "departments_assign", "crm_lead_operations", "crm_commercial_operations", "crm_quotations", "crm_audit_events"]) {
    assert.equal(saved(db, table).length, 0);
  }
  assert.deepEqual(db.pragma("foreign_key_check"), []);
});

test("Zoho import unmapped or absent assignment stays NULL; owner is never substituted or user identity modified", t => {
  for (const variant of ["absent", "unmapped", "inactive", "wrong-local-map"] as const) {
    const db = fixture(t), data = snapshot();
    if (variant === "absent") data.deals[0]!.assignedTo = null;
    if (variant === "unmapped") data.deals[0]!.assignedTo!.externalId = "102";
    if (variant === "inactive") db.prepare("UPDATE users SET status='inactive'").run();
    const options = variant === "wrong-local-map" ? { userMappings: [{ externalId: "101", localUserId: "2" }] } : mappings;
    const users = saved(db, "users"), plan = prepareZohoSqliteImport(db, data, options);
    assert.equal(plan.summary.Deals.insert, 1);
    assert.equal(plan.summary.warnings[variant === "absent" ? "ASSIGNEE_ABSENT" : "ASSIGNEE_UNMAPPED"], 1);
    applyZohoImportExtension(db, { organizationId: data.organizationId }); applyZohoSqliteImport(db, plan, { runId: randomUUID(), importedAt });
    assert.equal((db.prepare("SELECT assigned_to FROM tasks").get() as { assigned_to: unknown }).assigned_to, null);
    assert.deepEqual(saved(db, "users"), users);
  }
});

test("Zoho import preserves unknown or conflicting stage labels and does not invent their workflow meaning", t => {
  for (const [stage, status] of [["Negotiation/Review", null], ["Needs Analysis", "Unexpected app status"]] as const) {
    const db = fixture(t), data = snapshot(); data.deals[0]!.stage = stage; data.deals[0]!.applicationStatus = status;
    const receipt = apply(db, data); assert.equal(receipt.summary.warnings.STAGE_UNMAPPED, 1);
    assert.equal((db.prepare("SELECT status FROM tasks").get() as { status: string }).status, stage);
  }
});

test("Zoho import replays byte-identical rows without updates and records a separate immutable run receipt", t => {
  const db = fixture(t), data = snapshot(), plan = prepareZohoSqliteImport(db, data, mappings), runId = randomUUID();
  applyZohoImportExtension(db, { organizationId: "123" });
  const first = applyZohoSqliteImport(db, plan, { runId, importedAt });
  const before = [saved(db, "products"), saved(db, "tasks"), saved(db, "job_notes"), saved(db, "crm_demo_zoho_import_records")];
  assert.deepEqual(applyZohoSqliteImport(db, plan, { runId, importedAt }), { ...first, replayed: true });
  const next = prepareZohoSqliteImport(db, structuredClone(data), mappings);
  for (const module of ["Products", "Deals", "Notes"] as const) assert.equal(next.summary[module].alreadyImported, 1);
  applyZohoSqliteImport(db, next, { runId: randomUUID(), importedAt });
  assert.deepEqual([saved(db, "products"), saved(db, "tasks"), saved(db, "job_notes"), saved(db, "crm_demo_zoho_import_records")], before);
  assert.equal(saved(db, "crm_demo_zoho_import_runs").length, 2);
});

test("Zoho import never adopts pre-existing identities or appends notes to untracked historical tasks", t => {
  const db = fixture(t), data = snapshot();
  db.prepare("INSERT INTO products(product_id,product_name,created_at,updated_at) VALUES(?,'Pre-existing',?,?)").run(data.products[0]!.externalId, createdAt, modifiedAt);
  db.prepare("INSERT INTO tasks(zoho_crm_id,deal_name,status) VALUES(?,'Pre-existing','Pending')").run(data.deals[0]!.externalId);
  const before = [saved(db, "products"), saved(db, "tasks")], receipt = apply(db, data);
  assert.equal(receipt.summary.Products.conflicts, 1); assert.equal(receipt.summary.Deals.conflicts, 1);
  assert.equal(receipt.summary.Notes.skipped, 1); assert.equal(receipt.summary.reasons.PREEXISTING_RECORD, 2);
  assert.deepEqual([saved(db, "products"), saved(db, "tasks")], before); assert.equal(saved(db, "job_notes").length, 0);
});

test("Zoho import source changes are reported as conflicts, never an upsert or replacement", t => {
  const db = fixture(t), data = snapshot(); apply(db, data);
  data.products[0]!.name = "Changed"; data.deals[0]!.amount = "55.00"; data.notes[0]!.content = "Changed note";
  const before = [saved(db, "products"), saved(db, "tasks"), saved(db, "job_notes")], receipt = apply(db, data);
  assert.equal(receipt.summary.Products.conflicts, 1); assert.equal(receipt.summary.Deals.conflicts, 1); assert.equal(receipt.summary.Notes.conflicts, 1);
  assert.equal(receipt.summary.reasons.SOURCE_CHANGED, 3); assert.deepEqual([saved(db, "products"), saved(db, "tasks"), saved(db, "job_notes")], before);
});

test("Zoho import plan is bound to connection and current user/record state; stale plan cannot partially apply", t => {
  const db = fixture(t), other = fixture(t), data = snapshot(), plan = prepareZohoSqliteImport(db, data, mappings);
  applyZohoImportExtension(db, { organizationId: "123" }); applyZohoImportExtension(other, { organizationId: "123" });
  assert.throws(() => applyZohoSqliteImport(other, plan, { runId: randomUUID(), importedAt }), code("INPUT_INVALID"));
  assert.throws(() => applyZohoSqliteImport(db, { ...plan }, { runId: randomUUID(), importedAt }), code("INPUT_INVALID"));
  db.prepare("UPDATE users SET status='inactive' WHERE id=1").run();
  assert.throws(() => applyZohoSqliteImport(db, plan, { runId: randomUUID(), importedAt }), code("PLAN_STALE"));
  assert.equal(saved(db, "products").length, 0); assert.equal(saved(db, "crm_demo_zoho_import_runs").length, 0);
});

test("Zoho import apply rolls back product/deal/note inserts and receipt when any insert fails", t => {
  const db = fixture(t); applyZohoImportExtension(db, { organizationId: "123" });
  db.exec("CREATE TRIGGER synthetic_note_failure BEFORE INSERT ON job_notes BEGIN SELECT RAISE(ABORT,'synthetic private marker'); END");
  const plan = prepareZohoSqliteImport(db, snapshot(), mappings);
  assert.throws(() => applyZohoSqliteImport(db, plan, { runId: randomUUID(), importedAt }), error => {
    assert.ok(code("APPLY_FAILED")(error)); assert.doesNotMatch(String(error), /synthetic private marker/); return true;
  });
  for (const table of ["products", "tasks", "job_notes", "crm_demo_zoho_import_runs", "crm_demo_zoho_import_records"]) assert.equal(saved(db, table).length, 0);
});

test("Zoho import extension enforces immutable imported rows/provenance but leaves unrelated rows writable", t => {
  const db = fixture(t); apply(db);
  for (const [table, update] of [["tasks", "deal_name='Changed'"], ["products", "product_name='Changed'"], ["job_notes", "note_content='Changed'"],
    ["crm_demo_zoho_import_records", "source_hash='changed'"], ["crm_demo_zoho_import_runs", "imported_at='changed'"],
    ["crm_demo_zoho_import_extension", "organization_id='456'"]]) {
    assert.throws(() => db.prepare(`UPDATE ${table} SET ${update}`).run()); assert.throws(() => db.prepare(`DELETE FROM ${table}`).run());
  }
  db.prepare("INSERT INTO tasks(zoho_crm_id,deal_name,status) VALUES('555','Existing unrelated','Pending')").run();
  assert.equal(db.prepare("UPDATE tasks SET deal_name='Allowed unrelated edit' WHERE zoho_crm_id='555'").run().changes, 1);
  assert.throws(() => db.prepare("INSERT INTO crm_demo_zoho_import_runs(run_id,organization_id,snapshot_hash,plan_hash,imported_at,counts_json) VALUES(?,'456',?,?,?, '{}')")
    .run(randomUUID(), "a".repeat(64), "b".repeat(64), importedAt));
});

test("Zoho import rejects malformed/partial/duplicate/numeric-ID snapshots before any application insert", t => {
  const db = fixture(t), inputs: unknown[] = [];
  for (const change of [
    (data: ZohoInboundSnapshot) => { data.complete = false as true; },
    (data: ZohoInboundSnapshot) => { data.products[0]!.externalId = Number("9007199254740993") as unknown as string; },
    (data: ZohoInboundSnapshot) => { data.products[0]!.unitPrice = 12.5 as unknown as string; },
    (data: ZohoInboundSnapshot) => { data.deals[0]!.createdAt = "not-a-source-date"; },
    (data: ZohoInboundSnapshot) => { data.deals[0]!.createdAt = "2027-01-01T00:00:00Z"; },
    (data: ZohoInboundSnapshot) => { data.notes[0]!.dealId = "555"; },
    (data: ZohoInboundSnapshot) => { data.products.push(structuredClone(data.products[0]!)); },
  ]) { const data = snapshot(); change(data); inputs.push(data); }
  inputs.push({ ...snapshot(), secret: "must not leak" });
  for (const input of inputs) assert.throws(() => prepareZohoSqliteImport(db, input, mappings), code("INPUT_INVALID"));
  assert.equal(inspectZohoImportExtension(db), false); assert.equal(saved(db, "products").length, 0); assert.equal(saved(db, "tasks").length, 0);
});

test("Zoho import reports unsupported local money/missing note content rather than rounding or fabricating text", t => {
  const db = fixture(t), data = snapshot(); data.products[0]!.unitPrice = "123456789012345678901.01"; data.notes[0]!.title = null;
  data.notes[0]!.missingOptionalFields = ["Note_Title"];
  data.deals[0]!.missingOptionalFields = ["Phone"];
  const receipt = apply(db, data);
  assert.equal(receipt.summary.Products.skipped, 1); assert.equal(receipt.summary.Deals.insert, 1); assert.equal(receipt.summary.Notes.skipped, 1);
  assert.equal(receipt.summary.reasons.LOCAL_AMOUNT_UNSUPPORTED, 1); assert.equal(receipt.summary.reasons.NOTE_CONTENT_UNAVAILABLE, 1);
  assert.equal(receipt.summary.warnings.SOURCE_OPTIONAL_FIELDS_MISSING, 2);
  assert.equal(receipt.summary.warnings.NOTE_NULL_TEXT_AS_EMPTY, undefined);
  assert.equal(saved(db, "products").length, 0); assert.equal(saved(db, "job_notes").length, 0);
});

test("Zoho import displays explicitly null note text as empty while retaining source nulls and idempotent replay", t => {
  for (const [title, content] of [[null, "Source content"], ["Source note", null], [null, null], ["", ""]] as const) {
    const db = fixture(t), data = snapshot(); data.notes[0]!.title = title; data.notes[0]!.content = content;
    const plan = prepareZohoSqliteImport(db, data, mappings), runId = randomUUID();
    applyZohoImportExtension(db, { organizationId: data.organizationId });
    const receipt = applyZohoSqliteImport(db, plan, { runId, importedAt });
    assert.equal(receipt.summary.Notes.insert, 1); assert.equal(receipt.summary.Notes.skipped, 0);
    assert.equal(receipt.summary.warnings.NOTE_NULL_TEXT_AS_EMPTY, title === null || content === null ? 1 : undefined);
    const note = db.prepare("SELECT note_title,note_content,created_at,updated_at FROM job_notes").get();
    assert.deepEqual({ ...note as Record<string, unknown> }, { note_title: title ?? "", note_content: content ?? "", created_at: createdAt, updated_at: modifiedAt });
    const provenance = db.prepare("SELECT source_json FROM crm_demo_zoho_import_records WHERE module='Notes'").get() as { source_json: string };
    assert.deepEqual(JSON.parse(provenance.source_json), data.notes[0]);
    const before = [saved(db, "job_notes"), saved(db, "crm_demo_zoho_import_records")];
    assert.deepEqual(applyZohoSqliteImport(db, plan, { runId, importedAt }), { ...receipt, replayed: true });
    const replay = apply(db, data);
    assert.equal(replay.summary.Notes.alreadyImported, 1); assert.equal(replay.summary.Notes.insert, 0); assert.equal(replay.summary.Notes.conflicts, 0);
    assert.deepEqual([saved(db, "job_notes"), saved(db, "crm_demo_zoho_import_records")], before);
  }
});

test("Zoho import refuses unobserved note title or content instead of treating missing fields as source nulls", t => {
  for (const field of ["Note_Title", "Note_Content"] as const) {
    const db = fixture(t), data = snapshot(); data.notes[0]!.title = null; data.notes[0]!.content = null;
    data.notes[0]!.missingOptionalFields = [field];
    const receipt = apply(db, data);
    assert.equal(receipt.summary.Notes.skipped, 1); assert.equal(receipt.summary.Notes.insert, 0);
    assert.equal(receipt.summary.reasons.NOTE_CONTENT_UNAVAILABLE, 1);
    assert.equal(receipt.summary.warnings.NOTE_NULL_TEXT_AS_EMPTY, undefined);
    assert.equal(saved(db, "job_notes").length, 0);
    assert.equal((db.prepare("SELECT COUNT(*) total FROM crm_demo_zoho_import_records WHERE module='Notes'").get() as { total: number }).total, 0);
    const replay = apply(db, data); assert.equal(replay.summary.Notes.skipped, 1); assert.equal(replay.summary.Notes.insert, 0);
  }
});

test("Zoho import extension refuses partial or altered definitions and a different organization snapshot", t => {
  const db = fixture(t); applyZohoImportExtension(db, { organizationId: "123" });
  const other = snapshot(); other.organizationId = "456";
  assert.throws(() => prepareZohoSqliteImport(db, other, mappings), code("SOURCE_MISMATCH"));
  db.exec("DROP TRIGGER crm_demo_zoho_import_tasks_no_update");
  assert.throws(() => inspectZohoImportExtension(db), code("SCHEMA_INVALID"));
  assert.throws(() => applyZohoImportExtension(db, { organizationId: "123" }), code("SCHEMA_INVALID"));
  assert.throws(() => applyZohoSqliteImport(db, {} as ZohoSqliteImportPlan, { runId: randomUUID(), importedAt }), code("INPUT_INVALID"));
});

test("Zoho import trusted preservation verifier executes before commit and rolls back the entire apply on failure", t => {
  const db = fixture(t); applyZohoImportExtension(db, { organizationId: "123" });
  const plan = prepareZohoSqliteImport(db, snapshot(), mappings); let calls = 0;
  assert.throws(() => applyZohoSqliteImport(db, plan, { runId: randomUUID(), importedAt }, { verify() {
    calls++; assert.equal(db.inTransaction, true); assert.equal(saved(db, "tasks").length, 1);
    assert.equal(saved(db, "crm_demo_zoho_import_records").length, 3); throw new Error("private preservation failure");
  } }), error => { assert.ok(code("APPLY_FAILED")(error)); assert.doesNotMatch(String(error), /private preservation/); return true; });
  assert.equal(calls, 1);
  for (const table of ["products", "tasks", "job_notes", "crm_demo_zoho_import_runs", "crm_demo_zoho_import_records"]) assert.equal(saved(db, table).length, 0);
  const receipt = applyZohoSqliteImport(db, plan, { runId: randomUUID(), importedAt }, { verify() {
    calls++; assert.equal(db.inTransaction, true); assert.deepEqual(db.pragma("foreign_key_check"), []);
  } });
  assert.equal(calls, 2); assert.equal(receipt.summary.Deals.insert, 1);
});

test("Zoho import run ID replay cannot claim a different requested user-mapping configuration", t => {
  const db = fixture(t), data = snapshot(), plan = prepareZohoSqliteImport(db, data, mappings), runId = randomUUID();
  applyZohoImportExtension(db, { organizationId: "123" }); applyZohoSqliteImport(db, plan, { runId, importedAt });
  const differentPlan = prepareZohoSqliteImport(db, data, { userMappings: [] });
  assert.throws(() => applyZohoSqliteImport(db, differentPlan, { runId, importedAt }), code("PLAN_STALE"));
  assert.equal(saved(db, "crm_demo_zoho_import_runs").length, 1);
});

test("Zoho import preserves long multiline source product names without relaxing outgoing creation contracts", t => {
  const db = fixture(t), data = snapshot();
  const sourceName = "Synthetic long catalog name\r\n" + "a".repeat(1000) + "\tcontinued";
  data.products[0]!.name = sourceName; apply(db, data);
  assert.equal((db.prepare("SELECT product_name FROM products").get() as { product_name: string }).product_name, sourceName);
  const tooLong = snapshot(); tooLong.products[0]!.name = "x".repeat(2001);
  assert.throws(() => prepareZohoSqliteImport(db, tooLong, mappings), code("INPUT_INVALID"));
});

test("Zoho import preserves long source descriptions without truncation or relaxing outgoing forms", t => {
  const db = fixture(t), data = snapshot(), description = "Synthetic description\n" + "x".repeat(12_000);
  data.products[0]!.description = description; data.deals[0]!.description = description;
  apply(db, data);
  assert.equal((db.prepare("SELECT description FROM products").get() as { description: string }).description, description);
  assert.equal((db.prepare("SELECT complaint_info FROM tasks").get() as { complaint_info: string }).complaint_info, description);
  const tooLong = snapshot(); tooLong.deals[0]!.description = "x".repeat(100_001);
  assert.throws(() => prepareZohoSqliteImport(db, tooLong, mappings), code("INPUT_INVALID"));
});
