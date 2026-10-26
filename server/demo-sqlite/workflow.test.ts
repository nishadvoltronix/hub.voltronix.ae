import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { hashSync } from "bcryptjs";
import { configureDatabase, type SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { migrateDatabase } from "../../tests/sqlite-reference/db/migrations.js";
import { createSqliteDemoRuntime } from "./runtime.js";
import { applyLocalWorkflowExtension, inspectLocalWorkflowExtension, LOCAL_WORKFLOW_SCHEMA_CHECKSUM, LOCAL_WORKFLOW_SCHEMA_OBJECTS } from "./workflow-schema.js";
import { applyPercentageQuotationExtension, inspectPercentageQuotationExtension } from "./percentage-schema.js";
import { createLocalWorkflowService } from "./workflow-service.js";
import { calculateSavedQuotation, parseSavedQuotationInput } from "../src/crm/commercial/quotations.js";
import { createApp } from "../src/app.js";
import { createHttpLifecycle } from "../src/server.js";
import type { LocalQuotationIssuer } from "../src/crm/quotation-pdf/render.js";

const requireNext = createRequire(new URL("../../package.json", import.meta.url));
const Database = requireNext("better-sqlite3") as new (filename: string) => SqliteDatabase;
const password = "Synthetic local workflow test password", passwordHash = hashSync(password, 4);
const deal = { firstName: "Local", lastName: "Acceptance", companyName: "LOCAL TEST customer", email: "local@example.invalid", mobile: "000000", phone: "000001",
  department: "VOLTRONIX CONTRACTING LLC", poBox: "", trn: "", address: "Synthetic address", description: "Disposable local test only" };
const quote = { subject: "Local quote", kindAttention: "Local Acceptance", discount: "0", adjustment: "0",
  items: [{ productId: "90001", productName: "Local item", description: "", uom: "NOS", quantity: "2", unitPrice: "100.125", itemDiscount: "0" }] };
const isStatus = (status: number) => (error: unknown) => typeof error === "object" && error !== null && "status" in error && error.status === status;
function database(filename = ":memory:") { const db = new Database(filename); configureDatabase(db); migrateDatabase(db); return db; }
function seed(db: SqliteDatabase) {
  for (const id of [1, 2]) db.prepare("INSERT INTO users(id,username,email,password,status,role) VALUES(?,?,?,?,'active','synthetic')")
    .run(id, `Local user ${id}`, `local-${id}@example.invalid`, passwordHash);
  for (const key of ["deals.manage", "deals.view", "leads.view", "leads.manage", "dashboard.view", "items.write"]) {
    const permission = db.prepare('INSERT INTO permissions("key",label) VALUES(?,?)').run(key, key);
    for (const id of [1, 2]) db.prepare("INSERT INTO admin_user_permissions(admin_user_id,permission_id) VALUES(?,?)").run(id, permission.lastInsertRowid);
  }
  db.prepare("INSERT INTO products(product_id,product_name,description,created_at,updated_at) VALUES('90001','Local item','Recorded description','2026-10-12T00:00:00.000Z','2026-10-12T00:00:00.000Z')").run();
  db.prepare("INSERT INTO tasks(id,deal_name,status,deal_crm_created_by) VALUES(100,'Pre-existing null identity','Pending',1)").run();
}
async function fixture(t: TestContext, filename = ":memory:", issuer?: LocalQuotationIssuer) {
  const db = database(filename); seed(db); applyLocalWorkflowExtension(db, issuer); applyPercentageQuotationExtension(db);
  const runtime = createSqliteDemoRuntime(db); t.after(() => runtime.close());
  const first = await runtime.auth.login("local-1@example.invalid", password), second = await runtime.auth.login("local-2@example.invalid", password);
  return { db, runtime, s: runtime.services, token: first.sessionToken, other: second.sessionToken };
}
async function create(f: Awaited<ReturnType<typeof fixture>>) {
  return f.s.mutations.createDeal(f.token, { operationId: randomUUID(), ...deal });
}

test("PERCENTAGE schema is additive, explicit, idempotent, immutable and rejects altered metadata", async t => {
  const db = database(); seed(db); applyLocalWorkflowExtension(db); t.after(() => db.close());
  const original = db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
  assert.equal(inspectPercentageQuotationExtension(db), false);
  const applied = applyPercentageQuotationExtension(db); assert.equal(applied.applied, true);
  assert.equal(applyPercentageQuotationExtension(db).applied, false);
  for (const row of original as { type: string; name: string; sql: string | null }[]) {
    assert.deepEqual(db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name=?").get(row.name), row);
  }
  assert.throws(() => db.prepare("UPDATE crm_demo_percentage_extension SET checksum='changed'").run());
  assert.throws(() => db.prepare("DELETE FROM crm_demo_percentage_extension").run());
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  db.exec("DROP TRIGGER crm_demo_percentage_extension_no_update");
  assert.throws(() => inspectPercentageQuotationExtension(db));
  assert.throws(() => applyPercentageQuotationExtension(db));
});

test("PERCENTAGE historical zero and amount discounts remain readable and immutable, including zero/remove attempts", async t => {
  const f = await fixture(t);
  for (const discount of ["0", "5", "150"]) {
    const created = await create(f), id = created.taskId!;
    const historical = parseSavedQuotationInput({ ...quote, discount }, "percentage-create-v1", true);
    const totals = calculateSavedQuotation(historical, "percentage-create-v1", true);
    f.db.prepare(`INSERT INTO crm_demo_local_quotations(task_id,quote_number,quotation_json,totals_json,calculation_policy,created_at,updated_at)
      VALUES(?,?,?,?,'percentage-create-v1','2026-10-12T00:00:00.000Z','2026-10-12T00:00:00.000Z')`)
      .run(id, `LOCAL-QUOTE-${id}`, JSON.stringify(historical), JSON.stringify(totals));
    f.db.prepare("UPDATE tasks SET quote_number=? WHERE id=?").run(`LOCAL-QUOTE-${id}`, id);
    const before = f.db.prepare("SELECT * FROM crm_demo_local_quotations WHERE task_id=?").get(id);
    const detail = await f.s.commercial.getQuotation(f.token, id);
    assert.equal(detail.calculationPolicy, "percentage-create-v1"); assert.equal(detail.quotation.discountType, undefined);
    assert.equal(detail.totals.headerDiscount, discount);
    assert.equal((await f.s.commercial.quotationCapabilities(f.token, id)).canEdit, false);
    for (const candidate of [quote, { ...quote, discountType: "percentage", discount: "10" }, { ...quote, items: [{ ...quote.items[0], itemDiscount: "0", quantity: "1" }] }]) {
      await assert.rejects(f.s.commercial.updateQuotation(f.token, id, { operationId: randomUUID(), expectedVersion: 1,
        expectedQuoteVersion: 1, quotation: candidate }), isStatus(409));
    }
    assert.deepEqual(f.db.prepare("SELECT * FROM crm_demo_local_quotations WHERE task_id=?").get(id), before);
    assert.equal(f.db.prepare("SELECT 1 FROM crm_demo_percentage_quotations WHERE task_id=?").get(id), undefined);
  }
});

test("local quotation list returns actual source task context without mutating records or widening owner scope", async t => {
  const f = await fixture(t), created = await create(f), id = created.taskId!;
  await f.s.commercial.createQuotation(f.token, id, { operationId: randomUUID(), expectedVersion: created.version, quotation: quote });
  f.db.prepare("UPDATE tasks SET Job_Status='Hold' WHERE id=?").run(id);
  f.db.prepare("INSERT INTO permissions(key,label) VALUES('leads.manage.agents','Agent scope')").run();
  f.db.prepare("INSERT INTO admin_user_permissions(admin_user_id,permission_id) SELECT 2,id FROM permissions WHERE key='leads.manage.agents'").run();
  const beforeTask = f.db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
  const beforeQuote = f.db.prepare("SELECT * FROM crm_demo_percentage_quotations WHERE task_id=?").get(id);
  const detail = await f.s.commercial.getQuotation(f.token, id);
  const result = await f.s.commercial.listQuotations(f.token);
  const summary = result.items.find(row => row.taskId === id)!;
  assert.equal(summary.dealNumber, detail.task.dealNumber);
  assert.equal(summary.dealStatus, "Proposal/Price Quote");
  assert.equal(summary.jobStatus, "Hold");
  assert.equal(summary.createdAt, detail.createdAt);
  assert.equal(summary.subtotal, detail.totals.subtotal);
  assert.equal((await f.s.commercial.listQuotations(f.other)).total, 0);
  assert.deepEqual(f.db.prepare("SELECT * FROM tasks WHERE id=?").get(id), beforeTask);
  assert.deepEqual(f.db.prepare("SELECT * FROM crm_demo_percentage_quotations WHERE task_id=?").get(id), beforeQuote);
  for (const sort of ["createdAt", "quoteNumber", "dealNumber", "accountName", "dealStatus", "jobStatus", "assignedName", "subtotal"]) {
    assert.equal((await f.s.commercial.listQuotations(f.token, { sort, direction: "desc", pageSize: 100 })).total, 1);
    assert.equal((await f.s.commercial.listQuotations(f.other, { sort, direction: "asc", pageSize: 10 })).total, 0);
  }
  for (const input of [{ sort: "q.id; DELETE FROM tasks" }, { direction: "sideways" }, { sort: "constructor" }]) await assert.rejects(f.s.commercial.listQuotations(f.token, input), isStatus(400));
});

test("quotation Amount ordering is exact beyond floating-point precision and applied before paging", async t => {
  const f = await fixture(t), ids: string[] = [];
  for (const price of ["999999999999999999.02", "999999999999999999.01", "10"]) {
    const created = await create(f), id = created.taskId!; ids.push(id);
    await f.s.commercial.createQuotation(f.token, id, { operationId: randomUUID(), expectedVersion: created.version,
      quotation: { ...quote, items: [{ ...quote.items[0], quantity: "1", unitPrice: price }] } });
  }
  const snapshot = f.db.prepare("SELECT * FROM crm_demo_percentage_quotations ORDER BY id").all();
  assert.deepEqual((await f.s.commercial.listQuotations(f.token, { sort: "subtotal", direction: "asc", pageSize: 100 })).items.map(row => row.taskId), [ids[2], ids[1], ids[0]]);
  assert.equal((await f.s.commercial.listQuotations(f.token, { sort: "subtotal", direction: "desc", pageSize: 1 })).items[0]!.taskId, ids[0]);
  assert.equal((await f.s.commercial.listQuotations(f.token, { sort: "subtotal", direction: "desc", pageSize: 1, page: 2 })).items[0]!.taskId, ids[1]);
  assert.deepEqual(f.db.prepare("SELECT * FROM crm_demo_percentage_quotations ORDER BY id").all(), snapshot);
});

test("PERCENTAGE rejects fixed, ambiguous, negative and over-100 discounts before journal or record writes", async t => {
  const f = await fixture(t), created = await create(f);
  for (const quotation of [
    { ...quote, discountType: "fixed", discount: "5" }, { ...quote, discount: "5" },
    { ...quote, discountType: "percentage", discount: "100.000000000000000001" },
    { ...quote, discountType: "percentage", discount: "-1" },
    { ...quote, items: [{ ...quote.items[0], itemDiscount: "101" }] },
    { ...quote, items: [{ ...quote.items[0], discountType: "fixed" }] },
  ]) {
    const operationId = randomUUID();
    await assert.rejects(f.s.commercial.createQuotation(f.token, created.taskId, { operationId, expectedVersion: 1, quotation }), isStatus(400));
    assert.equal(f.db.prepare("SELECT 1 FROM crm_demo_local_operations WHERE operation_id=?").get(operationId), undefined);
  }
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM crm_demo_percentage_quotations").get() as { n: number }).n, 0);
});

test("PERCENTAGE recorded quotation dates preserve creation and stage dates across edits and reject invented issue dates", async t => {
  const f = await fixture(t), dates = ["2026-10-12T19:00:00.000Z", "2026-10-12T20:15:00.000Z", "2026-10-13T20:30:00.000Z"];
  let now = Date.parse(dates[0]!);
  const local = createLocalWorkflowService(f.db, { now: () => now });
  const created = local.createDeal(f.token, { operationId: randomUUID(), ...deal });
  now = Date.parse(dates[1]!);
  const saved = local.createQuotation(f.token, created.taskId, { operationId: randomUUID(), expectedVersion: 1,
    quotation: { ...quote, validUntil: "2026-11-10" } });
  const original = local.getQuotation(f.token, created.taskId);
  assert.equal(original.task.createdAt, dates[0]);
  assert.equal(original.createdAt, dates[1]); assert.equal(original.updatedAt, dates[1]);
  assert.equal(original.task.quoteDealDate, dates[1]);
  now = Date.parse(dates[2]!);
  const edited = local.updateQuotation(f.token, created.taskId, { operationId: randomUUID(), expectedVersion: saved.version,
    expectedQuoteVersion: saved.quoteVersion, quotation: { ...quote, discount: "5", discountType: "percentage", validUntil: "2026-11-15" } });
  const current = local.getQuotation(f.token, created.taskId);
  assert.equal(current.createdAt, original.createdAt); assert.equal(current.updatedAt, dates[2]);
  assert.equal(current.task.createdAt, dates[0]); assert.equal(current.task.quoteDealDate, original.task.quoteDealDate);
  assert.equal(current.quotation.validUntil, "2026-11-15"); assert.equal(current.quoteNumber, original.quoteNumber);
  assert.equal(current.id, original.id); assert.equal(current.version, original.version + 1);
  assert.equal(current.quotation.discountType, "percentage");
  const stored = () => ["tasks", "crm_demo_local_quotations", "crm_demo_percentage_quotations", "crm_demo_local_operations", "crm_demo_local_audit"]
    .map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before = stored();
  for (const field of ["quotation_date", "issueDate", "revisionDate", "createdAt", "updatedAt"]) {
    for (const atTopLevel of [false, true]) {
      const input = { operationId: randomUUID(), expectedVersion: edited.version, expectedQuoteVersion: edited.quoteVersion,
        quotation: { ...current.quotation, ...(atTopLevel ? {} : { [field]: "2026-01-01" }) }, ...(atTopLevel ? { [field]: "2026-01-01" } : {}) };
      assert.throws(() => local.updateQuotation(f.token, created.taskId, input), isStatus(400));
    }
  }
  assert.deepEqual(stored(), before, "rejected unsupported date inputs do not change records, journal or audit");
});

test("LOCAL WORKFLOW schema is explicit, additive, checksum-bound, immutable and fails closed", async () => {
  const db = database(); seed(db);
  const original = db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
  const runtime = createSqliteDemoRuntime(db);
  assert.equal(inspectLocalWorkflowExtension(db), false);
  assert.deepEqual(db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all(), original);
  // Construction must never apply. Use the same disposable connection only after
  // runtime drain; closing it here would also close this in-memory fixture.
  assert.equal(LOCAL_WORKFLOW_SCHEMA_OBJECTS.filter(object => object.type === "table").length, 7);
  assert.equal(LOCAL_WORKFLOW_SCHEMA_OBJECTS.filter(object => object.type === "trigger").length, 11);
  assert.deepEqual(applyLocalWorkflowExtension(db), { applied: true, checksum: LOCAL_WORKFLOW_SCHEMA_CHECKSUM });
  assert.deepEqual(applyLocalWorkflowExtension(db), { applied: false, checksum: LOCAL_WORKFLOW_SCHEMA_CHECKSUM });
  assert.equal(inspectLocalWorkflowExtension(db), true);
  assert.throws(() => db.prepare("UPDATE crm_demo_local_extension SET checksum='wrong'").run());
  assert.deepEqual(db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT GLOB 'crm_demo_local_*' AND name NOT LIKE 'sqlite_autoindex_crm_demo_local_%' ORDER BY name").all(), original);
  await runtime.close();
  const partial = database(); partial.exec("CREATE TABLE crm_demo_local_foreign(value TEXT)");
  assert.throws(() => inspectLocalWorkflowExtension(partial)); assert.throws(() => applyLocalWorkflowExtension(partial));
  assert.equal((partial.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name GLOB 'crm_demo_local_*'").get() as { n: number }).n, 1); partial.close();
});

test("LOCAL WORKFLOW real persisted deal, note, quote, won job, Accounts and attachment preserve old records on reopen", async t => {
  const dir = mkdtempSync(join(tmpdir(), "crm-local-workflow-")), filename = join(dir, "test.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = await fixture(t, filename), oldTask = f.db.prepare("SELECT * FROM tasks WHERE id=100").get();
  const oldUsers = f.db.prepare("SELECT * FROM users ORDER BY id").all(), oldGrants = f.db.prepare("SELECT * FROM admin_user_permissions ORDER BY id").all();
  assert.equal((await f.s.localWrites!.capabilities(f.token)).localWorkflow, true);
  const created = await create(f), id = created.taskId, uuid = randomUUID();
  assert.equal(created.version, 1);
  const detail = await f.s.leads.getLead(f.token, id);
  assert.equal(detail.externalId, null); assert.equal(detail.assignedExternalId, null); assert.equal(detail.assignedName, "Local user 1");
  assert.equal(detail.persistence, "local-demo"); assert.equal(detail.localOwnerId, "1");
  const note = await f.s.mutations.addNote(f.token, id, { operationId: uuid, expectedVersion: 1, title: "Test", content: "Original local note" });
  assert.equal((await f.s.leads.listNotes(f.token, id)).items[0]!.externalNoteId, null);
  const edit = await f.s.mutations.editNote(f.token, id, note.noteId!, { operationId: randomUUID(), expectedVersion: note.version, content: "Edited local note" });
  const site = await f.s.mutations.changeStage(f.token, id, { operationId: randomUUID(), expectedVersion: edit.version, stage: "Site Visit" });
  assert.deepEqual((await f.s.mutations.capabilities(f.token, id)).stages, ["Closed Lost"]);
  const saved = await f.s.commercial.createQuotation(f.token, id, { operationId: randomUUID(), expectedVersion: site.version, quotation: quote });
  assert.match(saved.quoteId!, /^local-/); assert.equal(saved.quoteVersion, 1);
  const q = await f.s.commercial.getQuotation(f.token, id);
  assert.equal(q.externalId, null); assert.equal(q.remoteModifiedAt, null); assert.equal(q.task.assignedCompany, null); assert.equal(q.task.assignedSaleName, null);
  assert.equal(q.subtotal, "200.25"); assert.equal(q.grandTotal, "210.26"); assert.equal(q.quotation.items[0]!.description, "Recorded description");
  assert.equal((await f.s.commercial.listQuotations(f.token, { query: "LOCAL-QUOTE" })).total, 1);
  assert.equal((await f.s.commercial.listQuotationCandidates(f.token)).total, 0);
  await assert.rejects(f.s.pdf.download(f.token, id), isStatus(409));
  const updated = await f.s.commercial.updateQuotation(f.token, id, { operationId: randomUUID(), expectedVersion: saved.version, expectedQuoteVersion: saved.quoteVersion, quotation: { ...quote, subject: "Updated local quote" } });
  const won = await f.s.mutations.changeStage(f.token, id, { operationId: randomUUID(), expectedVersion: updated.version, stage: "Closed Won", serviceCharge: "200.25" });
  assert.equal((await f.s.jobs.getJob(f.token, id)).jobNumber, `LOCAL-JOB-${id}`);
  assert.equal((await f.s.localReads!.listJobs(f.token, { query: "Local user 1" })).items[0]!.assignedName, "Local user 1");
  assert.equal((await f.s.localReads!.exportJobs(f.token, { query: "Local user 1" })).rowCount, 1);
  assert.equal((await f.s.localReads!.listCreatedDeals(f.token, { query: "Local user 1" })).items[0]!.assignedName, "Local user 1");
  const assigned = await f.s.departments.assignAccounts(f.token, id, { expectedVersion: won.version, userId: "1" });
  assert.equal(assigned.accounts!.userId, "1");
  assert.equal((await f.s.departments.listAssignees(f.token, "Electrical")).total, 0);
  const remarks = await f.s.jobs.updateRemarks(f.token, id, { expectedVersion: assigned.version, remarks: "New record only" });
  const hold = await f.s.jobs.updateStatus(f.token, id, { expectedVersion: remarks.version, jobStatus: "Hold" });
  const file = await f.s.attachments.upload(f.token, id, { expectedVersion: hold.version, name: "local.txt", mediaType: "text/plain" }, Buffer.from("Synthetic retained attachment"));
  assert.equal((await f.s.attachments.download(f.token, file.id)).content.toString(), "Synthetic retained attachment");
  assert.equal((await f.s.leads.listStatusHistory(f.token, id)).total, 2);
  assert.deepEqual(f.db.prepare("SELECT zoho_crm_id,assigned_to,owner_id,quote_id FROM tasks WHERE id=?").get(id), { zoho_crm_id: null, assigned_to: null, owner_id: null, quote_id: null });
  assert.deepEqual(f.db.prepare("SELECT * FROM tasks WHERE id=100").get(), oldTask);
  assert.deepEqual(f.db.prepare("SELECT * FROM users ORDER BY id").all(), oldUsers); assert.deepEqual(f.db.prepare("SELECT * FROM admin_user_permissions ORDER BY id").all(), oldGrants);
  assert.deepEqual(f.db.pragma("foreign_key_check"), []);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM crm_demo_local_operations WHERE remote_effect_possible!=0 OR remote_references!='{}'").get() as { n: number }).n, 0);
  await f.runtime.close();
  const reopened = new Database(filename); configureDatabase(reopened); const runtime = createSqliteDemoRuntime(reopened);
  try { assert.equal((await runtime.services.leads.listNotes(f.token, id)).items[0]!.content, "Edited local note");
    assert.equal((await runtime.services.commercial.getQuotation(f.token, id)).quotation.subject, "Updated local quote");
    assert.equal((await runtime.services.attachments.download(f.token, file.id)).content.toString(), "Synthetic retained attachment");
  } finally { await runtime.close(); }
});

test("LOCAL WORKFLOW ownership, no fallback, replay conflicts, stale CAS and current grant revocation", async t => {
  const f = await fixture(t), payload = { operationId: randomUUID(), ...deal }, created = await f.s.mutations.createDeal(f.token, payload);
  assert.deepEqual(await f.s.mutations.createDeal(f.token, payload), created);
  await assert.rejects(f.s.mutations.createDeal(f.token, { ...payload, companyName: "Changed" }), isStatus(409));
  await assert.rejects(f.s.mutations.createDeal(f.other, payload), isStatus(409));
  await assert.rejects(f.s.mutations.changeStage(f.token, "100", { operationId: randomUUID(), expectedVersion: 1, stage: "Site Visit" }), isStatus(403));
  await assert.rejects(f.s.mutations.changeStage(f.other, created.taskId, { operationId: randomUUID(), expectedVersion: 1, stage: "Site Visit" }), isStatus(403));
  const request = { operationId: randomUUID(), expectedVersion: 1, stage: "Site Visit" };
  const changed = await f.s.mutations.changeStage(f.token, created.taskId, request);
  assert.deepEqual(await f.s.mutations.changeStage(f.token, created.taskId, request), changed);
  await assert.rejects(f.s.mutations.changeStage(f.token, created.taskId, { ...request, operationId: randomUUID(), stage: "Closed Lost" }), isStatus(409));
  await assert.rejects(f.s.commercial.createProduct(f.token, { operationId: request.operationId, name: "Collision", description: "" }), isStatus(409));
  f.db.prepare('DELETE FROM admin_user_permissions WHERE admin_user_id=1 AND permission_id=(SELECT id FROM permissions WHERE "key"=?)').run("leads.manage");
  await assert.rejects(f.s.mutations.changeStage(f.token, created.taskId, request), isStatus(403));
  assert.equal((await f.s.mutations.capabilities(f.token, created.taskId)).canChangeStage, false);
  f.db.prepare("UPDATE users SET status='inactive' WHERE id=1").run();
  await assert.rejects(f.s.leads.getLead(f.token, created.taskId), isStatus(401));
});

test("LOCAL WORKFLOW note parent isolation, transactional audit rollback and immutable ownership", async t => {
  const f = await fixture(t), first = await create(f), second = await create(f);
  const note = await f.s.mutations.addNote(f.token, first.taskId, { operationId: randomUUID(), expectedVersion: 1, title: "First", content: "Private to first" });
  await assert.rejects(f.s.mutations.editNote(f.token, second.taskId, note.noteId!, { operationId: randomUUID(), expectedVersion: 1, content: "Wrong parent" }), isStatus(404));
  assert.throws(() => f.db.prepare("UPDATE crm_demo_local_tasks SET owner_user_id=2 WHERE task_id=?").run(first.taskId));
  f.db.exec("CREATE TRIGGER fail_local_audit BEFORE INSERT ON crm_demo_local_audit BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  const uuid = randomUUID();
  await assert.rejects(f.s.mutations.addNote(f.token, second.taskId, { operationId: uuid, expectedVersion: 1, title: "Rollback", content: "Must not persist" }), isStatus(503));
  assert.equal((await f.s.leads.listNotes(f.token, second.taskId)).total, 0); assert.equal((await f.s.leads.getLead(f.token, second.taskId)).updatedAt, (await f.s.leads.getLead(f.token, second.taskId)).createdAt);
  assert.equal(f.db.prepare("SELECT 1 FROM crm_demo_local_operations WHERE operation_id=?").get(uuid), undefined);
  assert.equal((await f.s.mutations.capabilities(f.token, second.taskId)).version, 1);
  const taskCount = (f.db.prepare("SELECT COUNT(*) n FROM tasks").get() as { n: number }).n;
  await assert.rejects(create(f), isStatus(503));
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM tasks").get() as { n: number }).n, taskCount);
  await assert.rejects(f.s.commercial.createQuotation(f.token, second.taskId, { operationId: randomUUID(), expectedVersion: 1, quotation: quote }), isStatus(503));
  assert.equal(f.db.prepare("SELECT 1 FROM crm_demo_local_quotations WHERE task_id=?").get(second.taskId), undefined);
  assert.equal((await f.s.mutations.capabilities(f.token, second.taskId)).version, 1);
});

test("LOCAL WORKFLOW quotation validation, product binding, percentage create/edit and quote CAS", async t => {
  const f = await fixture(t), created = await create(f), id = created.taskId;
  const base = { operationId: randomUUID(), expectedVersion: 1, quotation: quote };
  await assert.rejects(f.s.commercial.createQuotation(f.token, id, { ...base, quotation: { ...quote, items: [{ ...quote.items[0], productName: "Wrong" }] } }), isStatus(400));
  const saved = await f.s.commercial.createQuotation(f.token, id, base);
  assert.deepEqual(await f.s.commercial.createQuotation(f.token, id, base), saved);
  const edit = { operationId: randomUUID(), expectedVersion: saved.version, expectedQuoteVersion: saved.quoteVersion, quotation: quote };
  await assert.rejects(f.s.commercial.updateQuotation(f.token, id, { ...edit, expectedQuoteVersion: 99 }), isStatus(409));
  await assert.rejects(f.s.commercial.updateQuotation(f.token, id, { ...edit, quotation: { ...quote, discountType: "fixed" } }), isStatus(400));
  assert.equal(f.db.prepare("SELECT 1 FROM crm_demo_local_operations WHERE operation_id=?").get(edit.operationId), undefined);
  await f.s.commercial.updateQuotation(f.token, id, edit);
  const second = await create(f);
  const discounted = await f.s.commercial.createQuotation(f.token, second.taskId, { operationId: randomUUID(), expectedVersion: 1,
    quotation: { ...quote, items: [{ ...quote.items[0], itemDiscount: "10" }] } });
  assert.equal((await f.s.commercial.quotationCapabilities(f.token, second.taskId)).discountedEditBlocked, false);
  await f.s.commercial.updateQuotation(f.token, second.taskId, { operationId: randomUUID(), expectedVersion: discounted.version,
    expectedQuoteVersion: discounted.quoteVersion, quotation: { ...quote, discountType: "percentage", discount: "5", items: [{ ...quote.items[0], itemDiscount: "20" }] } });
  const detail = await f.s.commercial.getQuotation(f.token, second.taskId);
  assert.equal(detail.calculationPolicy, "percentage-only-v2"); assert.equal(detail.quotation.discountType, "percentage");
  assert.equal(detail.totals.exactSubtotal, "160.2"); assert.equal(detail.totals.headerDiscount, "8.01"); assert.equal(detail.grandTotal, "159.80");
});

test("LOCAL WORKFLOW own-agent reads use true local owner, retain legacy scope and paginate combined records", async t => {
  const f = await fixture(t), first = await create(f);
  const second = await f.s.mutations.createDeal(f.other, { operationId: randomUUID(), ...deal });
  const grant = f.db.prepare('INSERT INTO permissions("key",label) VALUES(?,?)').run("leads.manage.agents", "own only");
  f.db.prepare("INSERT INTO admin_user_permissions(admin_user_id,permission_id) VALUES(1,?)").run(grant.lastInsertRowid);
  assert.equal((await f.s.leads.getLead(f.token, first.taskId)).localOwnerId, "1");
  await assert.rejects(f.s.leads.getLead(f.token, second.taskId), isStatus(404));
  await assert.rejects(f.s.leads.getLead(f.token, "100"), isStatus(404));
  const pipeline = await f.s.leads.listPipeline(f.token, { pageSize: 1 }); assert.equal(pipeline.scope, "own"); assert.equal(pipeline.total, 1); assert.equal(pipeline.items[0]!.id, first.taskId);
  const candidates = await f.s.commercial.listQuotationCandidates(f.token); assert.equal(candidates.total, 1); assert.equal(candidates.items[0]!.taskId, first.taskId);
  assert.equal((await f.s.leads.listPipeline(f.other, { pageSize: 1 })).total, 3);
});

test("LOCAL WORKFLOW Express endpoints enforce real authentication, CSRF, versions and honest provenance", async t => {
  const f = await fixture(t), origin = "http://127.0.0.1:3001";
  const app = createApp({ environment: "test", host: "127.0.0.1", port: 3002, appOrigin: origin }, { auth: f.runtime.auth, crmServices: f.s });
  const server = createServer(app), lifecycle = createHttpLifecycle(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => lifecycle.stop());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  function cookie(response: Response) { return response.headers.getSetCookie().map(value => value.split(";")[0]).join("; "); }
  const challenge = await fetch(`${base}/auth/csrf`, { headers: { origin } });
  const csrf = (await challenge.json() as { csrfToken: string }).csrfToken;
  const signed = await fetch(`${base}/auth/login`, { method: "POST", headers: { origin, cookie: cookie(challenge), "content-type": "application/json", "x-csrf-token": csrf },
    body: JSON.stringify({ email: "local-1@example.invalid", password }) });
  assert.equal(signed.status, 200); const nextCsrf = (await signed.json() as { csrfToken: string }).csrfToken;
  const headers = { origin, cookie: cookie(signed), "content-type": "application/json", "x-csrf-token": nextCsrf };
  assert.equal((await fetch(`${base}/deals`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ operationId: randomUUID(), ...deal }) })).status, 401);
  assert.equal((await fetch(`${base}/deals`, { method: "POST", headers: { ...headers, "x-csrf-token": "invalid" }, body: JSON.stringify({ operationId: randomUUID(), ...deal }) })).status, 403);
  const response = await fetch(`${base}/deals`, { method: "POST", headers, body: JSON.stringify({ operationId: randomUUID(), ...deal }) });
  assert.equal(response.status, 200); const created = await response.json() as { taskId: string; version: number; persistence: string };
  assert.equal(created.persistence, "local-demo");
  const detail = await fetch(`${base}/leads/${created.taskId}`, { headers }); assert.equal(detail.status, 200);
  assert.equal((await detail.json() as { externalId: null }).externalId, null);
  const saved = await fetch(`${base}/quotations`, { method: "POST", headers, body: JSON.stringify({ taskId: created.taskId, operationId: randomUUID(), expectedVersion: created.version, quotation: quote }) });
  assert.equal(saved.status, 200);
  assert.equal((await fetch(`${base}/quotations/${created.taskId}/pdf`, { headers })).status, 409);
  const stale = await fetch(`${base}/leads/${created.taskId}/stage`, { method: "PATCH", headers,
    body: JSON.stringify({ operationId: randomUUID(), expectedVersion: 1, stage: "Closed Won" }) });
  assert.equal(stale.status, 409);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM crm_demo_local_operations").get() as { n: number }).n, 2);
});

test("LOCAL WORKFLOW optional attention persists blank through local create, reads, edits and PDF without remote effects", async t => {
  const f = await fixture(t, ":memory:", { company: "VOLTRONIX CONTRACTING LLC", salesperson: "Synthetic salesperson" });
  const users = f.db.prepare("SELECT * FROM users ORDER BY id").all();
  const grants = f.db.prepare("SELECT * FROM admin_user_permissions ORDER BY id").all();
  const created = await create(f), input = { ...quote, kindAttention: "" };
  const saved = await f.s.commercial.createQuotation(f.token, created.taskId, { operationId: randomUUID(), expectedVersion: 1, quotation: input });
  const detail = await f.s.commercial.getQuotation(f.token, created.taskId);
  assert.equal(detail.quotation.kindAttention, "");
  assert.equal(detail.subtotal, "200.25"); assert.equal(detail.grandTotal, "210.26");
  assert.equal((await f.s.commercial.quotationCapabilities(f.token, created.taskId)).canEdit, true);
  assert.equal((await f.s.pdf.download(f.token, created.taskId)).bytes.subarray(0, 8).toString(), "%PDF-1.7");
  await f.s.commercial.updateQuotation(f.token, created.taskId, { operationId: randomUUID(), expectedVersion: saved.version,
    expectedQuoteVersion: saved.quoteVersion, quotation: { ...input, subject: "Optional attention retained" } });
  const updated = await f.s.commercial.getQuotation(f.token, created.taskId);
  assert.equal(updated.quotation.kindAttention, ""); assert.deepEqual(updated.totals, detail.totals);
  const stored = f.db.prepare("SELECT quotation_json FROM crm_demo_percentage_quotations WHERE task_id=?").get(created.taskId) as { quotation_json: string };
  assert.equal(JSON.parse(stored.quotation_json).kindAttention, "");
  assert.equal(stored.quotation_json.includes("Default Last Name"), false);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM crm_demo_local_operations WHERE remote_effect_possible!=0 OR remote_references!='{}'").get() as { n: number }).n, 0);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM crm_commercial_operations").get() as { n: number }).n, 0);
  assert.deepEqual(f.db.prepare("SELECT * FROM users ORDER BY id").all(), users);
  assert.deepEqual(f.db.prepare("SELECT * FROM admin_user_permissions ORDER BY id").all(), grants);
  assert.deepEqual(f.db.pragma("foreign_key_check"), []);
});

test("LOCAL WORKFLOW approved issuer snapshots enable only new local PDFs and never alter account identity", async t => {
  const issuer = { company: "VOLTRONIX CONTRACTING LLC", salesperson: "nishad" }, f = await fixture(t, ":memory:", issuer);
  const users = f.db.prepare("SELECT * FROM users ORDER BY id").all(), created = await create(f);
  const saved = await f.s.commercial.createQuotation(f.token, created.taskId, { operationId: randomUUID(), expectedVersion: 1, quotation: quote });
  const detail = await f.s.commercial.getQuotation(f.token, created.taskId);
  assert.equal(detail.task.assignedCompany, issuer.company); assert.equal(detail.task.assignedSaleName, "nishad");
  assert.equal(detail.task.assignedExternalId, null); assert.equal(detail.task.assignedLocalId, "1");
  assert.equal((await f.s.commercial.quotationCapabilities(f.token, created.taskId)).pdfAvailable, true);
  const pdf = await f.s.pdf.download(f.token, created.taskId); assert.equal(pdf.bytes.subarray(0, 8).toString(), "%PDF-1.7"); assert.equal(pdf.pages, 1);
  assert.throws(() => f.db.prepare("UPDATE crm_demo_local_issuer SET salesperson='replacement'").run());
  assert.throws(() => f.db.prepare("UPDATE crm_demo_percentage_quotations SET issuer_salesperson='replacement' WHERE task_id=?").run(created.taskId));
  assert.throws(() => applyLocalWorkflowExtension(f.db, { ...issuer, salesperson: "replacement" }));
  await f.s.commercial.updateQuotation(f.token, created.taskId, { operationId: randomUUID(), expectedVersion: saved.version, expectedQuoteVersion: 1, quotation: { ...quote, subject: "Edited" } });
  assert.equal((await f.s.commercial.getQuotation(f.token, created.taskId)).task.assignedSaleName, "nishad");
  assert.deepEqual(f.db.prepare("SELECT * FROM users ORDER BY id").all(), users);
  const noIssuer = database();
  assert.throws(() => applyLocalWorkflowExtension(noIssuer, { company: "Unknown", salesperson: "nishad" }), /issuing company/);
  assert.equal(inspectLocalWorkflowExtension(noIssuer), false);
  assert.throws(() => applyLocalWorkflowExtension(noIssuer, { ...issuer, salesperson: "\n" }), /salesperson/);
  applyLocalWorkflowExtension(noIssuer);
  assert.throws(() => applyLocalWorkflowExtension(noIssuer, issuer), /retrofitted/); noIssuer.close();
});
