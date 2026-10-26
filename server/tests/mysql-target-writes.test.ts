import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createLocalWorkflowService, LocalWorkflowError } from "../src/crm/local-workflow/service.js";
import { createLocalMysqlWrites } from "../src/crm/local-workflow/writes.js";
import { createCrmServices } from "../src/crm/router.js";
import { LeadMutationError } from "../src/crm/lead-mutations/service.js";
import { CommercialPersistenceError } from "../src/crm/commercial/service.js";
import { targetChanged, targetFixture, targetNow, targetRows, targetToken, type TargetCall } from "./mysql-target-write-wire.js";

type Row = Record<string, unknown>;
type Model = { tables: Record<string, Row[]>; nextId: number };
const deal = { firstName: "Synthetic", lastName: "Owner", companyName: "Synthetic customer", email: "customer@example.invalid",
  mobile: "00000", phone: "00001", department: "VOLTRONIX CONTRACTING LLC", poBox: "", trn: "", address: "Synthetic address", description: "Synthetic description" };
const quotation = { subject: "Synthetic quotation", kindAttention: "Synthetic customer", discountType: "percentage", discount: "10", adjustment: "0",
  items: [{ productId: "90001", productName: "Synthetic product", description: "", uom: "NOS", quantity: "2", unitPrice: "100", itemDiscount: "0" }] };
const status = (code: number) => (error: unknown) => error instanceof LocalWorkflowError && error.status === code;
const table = (state: Model, name: string) => state.tables[name] ??= [];
const rowBy = (state: Model, name: string, key: string, id: unknown) => (state.tables[name] ?? []).find(row => String(row[key]) === String(id));
function insert(state: Model, sql: string, values: readonly unknown[]) {
  const parsed = /^INSERT INTO ([a-z_]+)\(([^)]+)\) VALUES\((.+)\)$/.exec(sql);
  assert.ok(parsed, `Unhandled insert: ${sql}`);
  const name = parsed[1]!, columns = parsed[2]!.split(",").map(s => s.trim()), expressions = parsed[3]!.split(",").map(s => s.trim());
  let index = 0;
  const row: Row = {};
  for (const [i, column] of columns.entries()) {
    const expression = expressions[i]!;
    row[column] = expression === "?" ? values[index++] : expression.startsWith("'") ? expression.slice(1, -1) : Number(expression);
  }
  assert.equal(index, values.length, "all inserted data is bound");
  if (name === "tasks" || name === "crm_local_notes" || name === "crm_percentage_quotations") row.id = String(state.nextId++);
  if (name === "tasks") Object.assign(row, { version: 1, zoho_crm_id: null, assigned_to: null, owner_id: null, quote_id: null, quote_number: null });
  if (name === "crm_percentage_quotations") row.version = 1;
  if (name === "crm_local_operations") Object.assign(row, { remote_effect_possible: 0, remote_references: "{}" });
  if (name === "crm_commercial_operations") Object.assign(row, { task_id: null, remote_effect_possible: 0, remote_references: "{}", result_json: null });
  if (name !== "tasks" && "task_id" in row && row.task_id !== null) assert.ok(rowBy(state, "tasks", "id", row.task_id), "synthetic task FK");
  if (name === "crm_local_tasks") assert.ok(rowBy(state, "crm_local_operations", "operation_id", row.creation_operation_id), "operation must precede non-deferred ownership FK");
  if (name === "crm_local_audit") assert.ok(rowBy(state, "crm_local_operations", "operation_id", row.operation_id), "operation must precede immutable audit FK");
  if (name === "crm_commercial_audit_events") assert.ok(rowBy(state, "crm_commercial_operations", "operation_id", row.operation_id), "commercial operation must precede audit FK");
  if (row.operation_id) assert.ok(!rowBy(state, name, "operation_id", row.operation_id), "synthetic operation uniqueness");
  table(state, name).push(row);
  return targetChanged(1, Number(row.id ?? 0));
}
function update(state: Model, sql: string, values: readonly unknown[]) {
  const parsed = /^UPDATE ([a-z_]+) SET (.+) WHERE (.+)$/.exec(sql); assert.ok(parsed, `Unhandled update: ${sql}`);
  const changes: Row = {}, increments: string[] = []; let index = 0;
  for (const assignment of parsed[2]!.split(",")) {
    const part = /^([a-z_]+)=(.+)$/.exec(assignment.trim()); assert.ok(part, `Unhandled assignment: ${assignment}`);
    const [column, expression] = [part[1]!, part[2]!];
    if (expression === "?") changes[column] = values[index++];
    else if (expression === `${column}+1`) increments.push(column);
    else if (/^'[^']*'$/.test(expression)) changes[column] = expression.slice(1, -1);
    else assert.fail(`Unhandled expression: ${expression}`);
  }
  const conditions = parsed[3]!.split(" AND ").map(condition => {
    const part = /^([a-z_]+)=(\?|'[^']*')$/.exec(condition); assert.ok(part, `Unhandled condition: ${condition}`);
    return [part[1]!, part[2] === "?" ? values[index++] : part[2]!.slice(1, -1)] as const;
  });
  assert.equal(index, values.length);
  const rows = table(state, parsed[1]!).filter(row => conditions.every(([key, value]) => String(row[key]) === String(value)));
  for (const row of rows) { Object.assign(row, changes); for (const key of increments) row[key] = Number(row[key]) + 1; }
  return targetChanged(rows.length);
}
function modelReply(state: Model, { sql, values }: TargetCall) {
  if (sql.startsWith("INSERT INTO ")) return insert(state, sql, values);
  if (sql.startsWith("UPDATE ")) return update(state, sql, values);
  assert.match(sql, /^SELECT /, "no hard delete or unreviewed statement is introduced");
  if (sql.startsWith("SELECT origin,state,last_synced_at,source_modified_at,external_id FROM (")) return targetRows([]);
  if (sql.includes("FROM crm_lead_operations")) {
    if (sql.includes("WHERE operation_id=?")) {
      const conflict = (sql.includes("FROM crm_local_operations") && rowBy(state, "crm_local_operations", "operation_id", values[0]))
        || (sql.includes("FROM crm_commercial_operations") && rowBy(state, "crm_commercial_operations", "operation_id", values[0]));
      return targetRows(conflict ? [{ present: 1 }] : []);
    }
    return targetRows([]);
  }
  if (sql.includes("FROM crm_commercial_operations")) {
    if (sql.includes("WHERE actor_user_id=?")) return targetRows((state.tables.crm_commercial_operations ?? []).filter(row => String(row.actor_user_id) === String(values[0]) && row.state !== "completed"));
    const row = rowBy(state, "crm_commercial_operations", "operation_id", values[0]);
    return targetRows(row ? [{ ...row, actor: String(row.actor_user_id), taskId: row.task_id === null ? null : String(row.task_id) }] : []);
  }
  if (sql.includes("FROM departments_assign")) return targetRows([]);
  if (sql.includes("FROM crm_local_operations")) {
    const row = rowBy(state, "crm_local_operations", "operation_id", values[0]);
    return targetRows(row ? [{ ...row, actor: String(row.actor_user_id), taskId: String(row.task_id) }] : []);
  }
  if (sql.startsWith("SELECT assigned_to FROM tasks")) { const row = rowBy(state, "tasks", "id", values[0]); return targetRows(row ? [{ assigned_to: row.assigned_to }] : []); }
  if (sql.startsWith("SELECT CAST(id AS CHAR) id,zoho_crm_id externalId")) {
    const row = rowBy(state, "tasks", "id", values[0]);
    return targetRows(row ? [{ id: String(row.id), externalId: row.zoho_crm_id, assignedTo: row.assigned_to, status: row.status,
      version: row.version, quoteId: row.quote_number, quoteNumber: row.quote_number, quoteExternalId: row.quote_id }] : []);
  }
  if (sql.includes("FROM crm_local_tasks l JOIN tasks t")) {
    assert.match(sql, /o\.kind='deal.create'/); assert.match(sql, /t\.zoho_crm_id IS NULL/);
    assert.match(sql, /o\.remote_effect_possible=0/); assert.match(sql, /o\.state='completed'/);
    const row = rowBy(state, "tasks", "id", values[0]), local = rowBy(state, "crm_local_tasks", "task_id", values[0]);
    const op = local && rowBy(state, "crm_local_operations", "operation_id", local.creation_operation_id);
    return targetRows(row && local && op && row.zoho_crm_id === null ? [{ id: String(row.id), ownerId: String(local.owner_user_id), status: row.status,
      version: row.version, quoteNumber: row.quote_number, createdAt: row.created_at }] : []);
  }
  if (sql.includes("FROM crm_local_tasks")) {
    const row = rowBy(state, "crm_local_tasks", "task_id", values[0]);
    return targetRows(row && (values.length === 1 || row.creation_operation_id === values[1]) ? [{ ...row, ownerId: String(row.owner_user_id) }] : []);
  }
  if (sql.includes("FROM crm_local_notes")) {
    const row = rowBy(state, "crm_local_notes", "id", values[0]); return targetRows(row && String(row.task_id) === String(values[1]) ? [{ ...row, id: String(row.id) }] : []);
  }
  if (sql.includes("FROM crm_percentage_quotations")) { const row = rowBy(state, "crm_percentage_quotations", "task_id", values[0]); return targetRows(row ? [{ ...row }] : []); }
  if (sql.includes("FROM crm_zoho_quotations")) { const row = rowBy(state, "crm_zoho_quotations", "task_id", values[0]); return targetRows(row ? [{ ...row }] : []); }
  if (sql.includes("FROM crm_quotations")) { const row = rowBy(state, "crm_quotations", "task_id", values[0]); return targetRows(row ? [{ ...row }] : []); }
  if (sql.includes("FROM products")) { const row = rowBy(state, "products", "product_id", values[0]); return targetRows(row ? [{ ...row }] : []); }
  if (sql.includes("FROM tasks t") && sql.includes("dealName")) {
    const row = rowBy(state, "tasks", "id", values[0]); if (!row) return targetRows([]);
    return targetRows([{ id: String(row.id), dealName: row.deal_name, dealNumber: row.deal_number, accountName: row.account_name, customerName: row.customer_name,
      customerEmail: row.customer_email, customerContact: row.customer_contact, address: row.address, status: row.status, jobStatus: null,
      assignedExternalId: null, assignedName: "Synthetic owner", assignedCompany: null, assignedSaleName: null, createdAt: row.created_at,
      quoteDealDate: row.quote_deal_date, quoteDealNumber: row.quote_deal_number, pBox: row.p_box, trn: row.trn, taxTotal: null }]);
  }
  throw new Error(`Unexpected synthetic target query: ${sql}`);
}
function fixture(extraTables: Record<string, Row[]> = {}, override?: (state: Model, call: TargetCall) => ReturnType<typeof targetRows> | undefined) {
  const f = targetFixture<Model>({ nextId: 10, tables: { products: [{ product_id: "90001", product_name: "Synthetic product", description: "Recorded description" }], ...extraTables } },
    (state, call) => override?.(state, call) ?? modelReply(state, call));
  return { ...f, service: createLocalWorkflowService(f.db, { now: () => targetNow }) };
}
const create = (f: ReturnType<typeof fixture>, operationId = randomUUID()) => f.service.createDeal(targetToken, { operationId, ...deal });

test("OFFLINE MySQL local create/read/update bind values and preserve immutable ownership provenance", async () => {
  const f = fixture(), operationId = randomUUID(), first = await create(f, operationId), id = first.taskId!;
  assert.equal(first.persistence, "local-mysql"); assert.equal(first.version, 1);
  assert.equal(await f.service.isLocal(id), true); assert.equal(await f.service.isLocal("999"), false);
  assert.equal((await f.service.capabilities(targetToken, id)).canChangeStage, true);
  assert.deepEqual(await create(f, operationId), first, "identical retry is returned without another insert");
  await assert.rejects(f.service.createDeal(targetToken, { operationId, ...deal, firstName: "Changed" }), status(409));
  const note = await f.service.addNote(targetToken, id, { operationId: randomUUID(), expectedVersion: 1, title: "Bound ' title", content: "Bound content" });
  const edited = await f.service.editNote(targetToken, id, note.noteId!, { operationId: randomUUID(), expectedVersion: 2, content: "Updated note" });
  assert.equal(edited.version, 3);
  const stage = await f.service.changeStage(targetToken, id, { operationId: randomUUID(), expectedVersion: 3, stage: "Site Visit" });
  assert.equal(stage.version, 4);
  const state = f.state(), task = rowBy(state, "tasks", "id", id)!;
  assert.equal(task.status, "Site Visit"); assert.equal(task.zoho_crm_id, null); assert.equal(task.assigned_to, null);
  assert.equal(table(state, "crm_local_tasks").length, 1); assert.equal(table(state, "crm_local_operations").length, 4);
  assert.equal(table(state, "crm_local_audit").length, 4); assert.equal(table(state, "crm_local_notes")[0]!.content, "Updated note");
  assert.equal(table(state, "crm_local_notes")[0]!.title, "Bound ' title");
  assert.ok(f.calls.every(call => !call.sql.includes("Bound ' title")), "untrusted values never become SQL");
  assert.ok(!f.calls.some(call => /^DELETE |UPDATE (?:users|admin_user_permissions|crm_sessions)\b/.test(call.sql)));
});

test("OFFLINE MySQL workflow denies stale grants, foreign notes, missing ownership and invalid inputs before writes", async () => {
  const f = fixture(), first = await create(f), id = first.taskId!, before = f.state();
  await assert.rejects(f.service.addNote(null, id, {}), status(401));
  await assert.rejects(f.service.addNote(targetToken, "999", {}), status(404));
  await assert.rejects(f.service.editNote(targetToken, id, "999", { operationId: randomUUID(), expectedVersion: 1, content: "No match" }), status(404));
  await assert.rejects(f.service.addNote(targetToken, id, { operationId: randomUUID(), expectedVersion: 1, title: "x", content: "\0" }), status(400));
  await assert.rejects(f.service.changeStage(targetToken, id, { operationId: randomUUID(), expectedVersion: 1, stage: "Closed Won" }), status(400));
  f.grants.splice(0);
  await assert.rejects(create(f), status(403));
  await assert.rejects(f.service.addNote(targetToken, id, { operationId: randomUUID(), expectedVersion: 1, title: "x", content: "Denied" }), error => status(403)(error) || status(404)(error));
  assert.deepEqual(f.state(), before);
});

test("OFFLINE MySQL local writes never adopt pre-existing null/remote identities or a note from another task", async () => {
  const historical = [{ id: "1", zoho_crm_id: null, assigned_to: null, deal_crm_created_by: "1", status: "Pending", version: 1 },
    { id: "2", zoho_crm_id: "91234", assigned_to: "101", deal_crm_created_by: "1", status: "Pending", version: 1 }];
  const f = fixture({ tasks: historical });
  for (const id of ["1", "2"]) {
    assert.equal(await f.service.isLocal(id), false);
    await assert.rejects(f.service.capabilities(targetToken, id), status(404));
    await assert.rejects(f.service.addNote(targetToken, id, { operationId: randomUUID(), expectedVersion: 1, title: "No adoption", content: "Denied" }), status(404));
  }
  const first = await create(f), second = await create(f);
  const note = await f.service.addNote(targetToken, first.taskId!, { operationId: randomUUID(), expectedVersion: 1, title: "First task only", content: "Owned note" });
  const before = f.state();
  await assert.rejects(f.service.editNote(targetToken, second.taskId!, note.noteId!, { operationId: randomUUID(), expectedVersion: 1, content: "Cross-task edit" }), status(404));
  assert.deepEqual(f.state(), before); assert.deepEqual(table(f.state(), "tasks").slice(0, 2), historical);
});

test("OFFLINE MySQL replay rejects malformed, foreign-task and foreign-persistence receipts without writes", async () => {
  for (const alteration of ["invalid-json", "foreign-task", "foreign-persistence", "wrong-operation", "unsafe-version"] as const) {
    let corrupt = false;
    const f = fixture({}, (state, call) => {
      if (!corrupt || !call.sql.includes("FROM crm_local_operations")) return undefined;
      const reply = modelReply(state, call), rows = reply[0] as Row[], row = rows[0];
      if (!row) return reply;
      const value = JSON.parse(String(row.result_json)) as Row;
      if (alteration === "foreign-task") value.taskId = "999";
      if (alteration === "foreign-persistence") value.persistence = "local-demo";
      if (alteration === "wrong-operation") value.operationId = randomUUID();
      if (alteration === "unsafe-version") value.version = Number.MAX_SAFE_INTEGER + 1;
      return targetRows([{ ...row, result_json: alteration === "invalid-json" ? "{" : JSON.stringify(value) }]);
    });
    const operationId = randomUUID(); await create(f, operationId); const before = f.state(); corrupt = true;
    await assert.rejects(create(f, operationId), status(409)); assert.deepEqual(f.state(), before);
  }
});

test("OFFLINE MySQL percentage quotations retain values on read/edit, validate product references and require explicit issuer", async () => {
  const f = fixture(), first = await create(f), id = first.taskId!;
  await assert.rejects(f.service.createQuotation(targetToken, id, { operationId: randomUUID(), expectedVersion: 1,
    quotation: { ...quotation, items: [{ ...quotation.items[0], productId: "99999" }] } }), status(400));
  const created = await f.service.createQuotation(targetToken, id, { operationId: randomUUID(), expectedVersion: 1, quotation });
  assert.equal(created.quoteVersion, 1); assert.equal(created.version, 2);
  const detail = await f.service.getQuotation(targetToken, id), before = f.state();
  assert.equal(detail.calculationPolicy, "percentage-only-v2"); assert.equal(detail.totals.subtotal, "200.00");
  assert.equal(detail.totals.headerDiscountAmount, "20.00"); assert.equal(detail.totals.grandTotal, "189.00");
  assert.equal(detail.quotation.items[0]!.description, "Recorded description"); assert.equal(detail.pdfAvailable, false);
  assert.deepEqual(f.state(), before, "read never silently recalculates saved records");
  const updated = await f.service.updateQuotation(targetToken, id, { operationId: randomUUID(), expectedVersion: 2, expectedQuoteVersion: 1,
    quotation: { ...quotation, discount: "20" } });
  assert.equal(updated.quoteVersion, 2); assert.equal(updated.version, 3);
  const edited = await f.service.getQuotation(targetToken, id);
  assert.equal(edited.totals.subtotal, "200.00"); assert.equal(edited.totals.headerDiscountAmount, "40.00");
  assert.equal(edited.totals.grandTotal, "168.00"); assert.equal(edited.quoteNumber, detail.quoteNumber);
  await assert.rejects(f.service.updateQuotation(targetToken, id, { operationId: randomUUID(), expectedVersion: 3, expectedQuoteVersion: 1, quotation }), status(409));
});

test("OFFLINE MySQL task, note, journal and audit roll back atomically on a late write failure", async () => {
  const f = fixture(), first = await create(f), id = first.taskId!, before = f.state();
  f.fail(/^INSERT INTO crm_local_audit/, "ER_DISK_FULL");
  await assert.rejects(f.service.addNote(targetToken, id, { operationId: randomUUID(), expectedVersion: 1, title: "Rollback", content: "Synthetic" }),
    error => status(503)(error) && error instanceof Error && !error.message.includes("private"));
  assert.deepEqual(f.state(), before);
  assert.equal(f.events.at(-2)?.event, "ROLLBACK");
  f.clearFault();
  assert.equal((await f.service.addNote(targetToken, id, { operationId: randomUUID(), expectedVersion: 1, title: "Retry with new ID", content: "Synthetic" })).version, 2);
});

test("OFFLINE MySQL FK/unique/constraint failures are atomic and sanitized without automatic retries", async () => {
  for (const code of ["ER_NO_REFERENCED_ROW_2", "ER_DUP_ENTRY", "ER_CHECK_CONSTRAINT_VIOLATED", "ER_SIGNAL_EXCEPTION", "ER_LOCK_DEADLOCK"]) {
    const f = fixture(), first = await create(f), id = first.taskId!, before = f.state();
    f.fail(/^INSERT INTO crm_local_notes/, code);
    await assert.rejects(f.service.addNote(targetToken, id, { operationId: randomUUID(), expectedVersion: 1, title: "Failure", content: "Synthetic" }),
      error => (status(409)(error) || status(503)(error)) && error instanceof Error && !error.message.includes("private"));
    assert.deepEqual(f.state(), before); assert.equal(f.calls.filter(call => call.sql.startsWith("INSERT INTO crm_local_notes")).length, 1);
  }
});

test("OFFLINE MySQL concurrent same-version mutations serialize and only one commits", async () => {
  const f = fixture(), first = await create(f), id = first.taskId!;
  const results = await Promise.allSettled(["First", "Second"].map(title => f.service.addNote(targetToken, id,
    { operationId: randomUUID(), expectedVersion: 1, title, content: "Concurrent synthetic write" })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected"); assert.ok(rejected?.status === "rejected" && status(409)(rejected.reason));
  const state = f.state(); assert.equal(table(state, "crm_local_notes").length, 1); assert.equal(rowBy(state, "tasks", "id", id)!.version, 2);
  assert.equal(table(state, "crm_local_audit").length, 2);
});

test("OFFLINE MySQL concurrent identical requests replay one journal result; uncertain commit never retries", async () => {
  const f = fixture(), operationId = randomUUID(), results = await Promise.all([create(f, operationId), create(f, operationId)]);
  assert.deepEqual(results[0], results[1]); assert.equal(table(f.state(), "tasks").length, 1);
  const failing = fixture(); failing.failCommit();
  await assert.rejects(create(failing), status(503));
  assert.equal(failing.events.filter(event => event.event === "COMMIT").length, 1);
  assert.ok(failing.events.some(event => event.event === "DESTROY"));
});

test("OFFLINE MySQL products commit one idempotent local result, reject cross-journal reuse and obey fresh grants", async () => {
  const f = fixture(), writes = createLocalMysqlWrites(f.db, { now: () => targetNow });
  assert.equal((await writes.capabilities(targetToken)).productCreate, true);
  const input = { operationId: randomUUID(), name: "Synthetic new product", description: "Bound multiline\nvalue" };
  const results = await Promise.all([writes.createProduct(targetToken, input), writes.createProduct(targetToken, input)]);
  assert.deepEqual(results[0], results[1]); assert.equal(results[0]!.persistence, "local-mysql"); assert.match(results[0]!.productId!, /^9[0-9]{39}$/);
  assert.equal(table(f.state(), "products").length, 2); assert.equal(table(f.state(), "crm_commercial_audit_events").length, 1);
  assert.equal(table(f.state(), "crm_commercial_operations")[0]!.remote_effect_possible, 0);
  assert.equal(table(f.state(), "crm_commercial_operations")[0]!.remote_references, "{}");
  await assert.rejects(writes.createProduct(targetToken, { ...input, description: "Changed request" }), status(409));
  await assert.rejects(create(f, input.operationId), status(409));
  const dealId = randomUUID(); await create(f, dealId);
  await assert.rejects(writes.createProduct(targetToken, { ...input, operationId: dealId }), status(409));
  const before = f.state(); f.grants.splice(0);
  assert.equal((await writes.capabilities(targetToken)).productCreate, false);
  await assert.rejects(writes.createProduct(targetToken, { ...input, operationId: randomUUID() }), status(403));
  await assert.rejects(writes.createProduct(null, input), status(401));
  assert.deepEqual(f.state(), before);
});

test("OFFLINE MySQL product insertion rolls back with its journal on immutable-audit failure", async () => {
  const f = fixture(), writes = createLocalMysqlWrites(f.db, { now: () => targetNow }), before = f.state();
  f.fail(/^INSERT INTO crm_commercial_audit_events/, "ER_NO_REFERENCED_ROW_2");
  await assert.rejects(writes.createProduct(targetToken, { operationId: randomUUID(), name: "Rollback product", description: "Synthetic" }), status(409));
  assert.deepEqual(f.state(), before); assert.ok(f.events.some(event => event.event === "ROLLBACK"));
});

test("OFFLINE Express service factory selects native MySQL writes and newly proven local records", async () => {
  const f = fixture(), services = createCrmServices(f.db);
  assert.equal(f.calls.length, 0, "construction neither opens a connection nor writes data");
  const capabilities = await services.localWrites.capabilities(targetToken);
  assert.equal(capabilities.persistence, "local-mysql"); assert.equal(capabilities.productCreate, true);
  assert.equal(capabilities.dealCreate, true); assert.equal(capabilities.integrationAvailable, false);
  const created = await services.mutations.createDeal(targetToken, { operationId: randomUUID(), ...deal }), id = created.taskId!;
  const detail = await services.leads.getLead(targetToken, id);
  assert.equal(detail.id, id); assert.equal(detail.persistence, "local-mysql"); assert.equal(detail.localOwnerId, "1");
  assert.deepEqual(await services.auth.getAuthorizedTask(targetToken, id), { id, dealName: "Synthetic Owner", status: "Pending" });
  assert.equal((await services.mutations.capabilities(targetToken, id)).canWriteNotes, true);
  const note = await services.mutations.addNote(targetToken, id, { operationId: randomUUID(), expectedVersion: 1, title: "Native route", content: "Recorded" });
  assert.equal(note.version, 2);
  assert.equal((await services.mutations.changeStage(targetToken, id, { operationId: randomUUID(), expectedVersion: 2, stage: "Site Visit" })).version, 3);
  assert.equal((await services.commercial.quotationCapabilities(targetToken, id)).canCreate, true);
  await services.commercial.createQuotation(targetToken, id, { operationId: randomUUID(), expectedVersion: 3, quotation });
  assert.equal((await services.commercial.getQuotation(targetToken, id)).persistence, "local-mysql");
  const product = await services.commercial.createProduct(targetToken, { operationId: randomUUID(), name: "Factory product", description: "Synthetic" });
  assert.equal(product.persistence, "local-mysql");
});

test("OFFLINE Express service factory keeps historical remote stage, notes and quotes integration-gated", async () => {
  const historical = { id: "2", zoho_crm_id: "91234", assigned_to: "101", deal_crm_created_by: "1", status: "Pending", version: 1, quote_number: null, quote_id: null };
  const f = fixture({ tasks: [historical] }), services = createCrmServices(f.db), before = f.state();
  const capabilities = await services.mutations.capabilities(targetToken, "2");
  assert.equal(capabilities.integrationAvailable, false); assert.equal(capabilities.canWriteNotes, false);
  await assert.rejects(services.mutations.changeStage(targetToken, "2", { operationId: randomUUID(), expectedVersion: 1, stage: "Site Visit" }),
    error => error instanceof LeadMutationError && error.status === 503);
  await assert.rejects(services.mutations.addNote(targetToken, "2", { operationId: randomUUID(), expectedVersion: 1, title: "Remote note", content: "Must not persist locally" }),
    error => error instanceof LeadMutationError && error.status === 503);
  await assert.rejects(services.commercial.createQuotation(targetToken, "2", { operationId: randomUUID(), expectedVersion: 1, quotation }),
    error => error instanceof CommercialPersistenceError && error.status === 503);
  assert.deepEqual(f.state(), before);
  assert.equal(f.calls.some(call => /^(?:INSERT|UPDATE|DELETE)\b/.test(call.sql)), false);
});

test("OFFLINE MySQL quotation PDF snapshots the explicit issuer and retains it across edits and rendering", async () => {
  const f = fixture(), issuer = { company: "VOLTRONIX CONTRACTING LLC", salesperson: "Synthetic approved salesperson" };
  const services = createCrmServices(f.db, { issuer });
  issuer.salesperson = "Caller object changed after construction";
  const created = await services.mutations.createDeal(targetToken, { operationId: randomUUID(), ...deal }), id = created.taskId!;
  await services.commercial.createQuotation(targetToken, id, { operationId: randomUUID(), expectedVersion: 1, quotation });
  const first = await services.commercial.getQuotation(targetToken, id);
  assert.equal(first.pdfAvailable, true); assert.equal(first.task.assignedCompany, "VOLTRONIX CONTRACTING LLC");
  assert.equal(first.task.assignedSaleName, "Synthetic approved salesperson"); assert.equal(first.task.assignedExternalId, null);
  const replacement = createCrmServices(f.db, { issuer: { company: "VOLTRONIX SWITCHGEAR LLC", salesperson: "Different future issuer" } });
  await replacement.commercial.updateQuotation(targetToken, id, { operationId: randomUUID(), expectedVersion: 2, expectedQuoteVersion: 1,
    quotation: { ...quotation, discount: "20" } });
  const edited = await replacement.commercial.getQuotation(targetToken, id);
  assert.equal(edited.task.assignedCompany, first.task.assignedCompany); assert.equal(edited.task.assignedSaleName, first.task.assignedSaleName);
  assert.equal(edited.quoteNumber, first.quoteNumber); assert.equal(edited.createdAt, first.createdAt);
  const before = f.state(), pdf = await replacement.pdf.download(targetToken, id);
  assert.equal(pdf.bytes.subarray(0, 5).toString(), "%PDF-"); assert.ok(pdf.pages > 0); assert.ok(pdf.bytes.length > 1_000);
  assert.deepEqual(f.state(), before, "PDF and repeated authorization do not alter quotation or account data");
});
