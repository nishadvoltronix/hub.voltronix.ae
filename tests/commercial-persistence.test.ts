import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { hashSync } from "bcryptjs";
import { createAuthService, SESSION_LIFETIME_MS } from "./sqlite-reference/auth/service";
import { configureDatabase, openDatabase } from "./sqlite-reference/db/connection";
import { migrateDatabase, migrations } from "./sqlite-reference/db/migrations";
import { createCommercialService, CommercialPersistenceError } from "./sqlite-reference/commercial/service";
import type { CommercialRequest, CommercialTransport } from "./sqlite-reference/commercial/transport";
import { filesystemFixture } from "./database-fixture";
import { createLeadMutationsService, LeadMutationError } from "./sqlite-reference/lead-mutations/service";
import { createQuotationPdfService } from "./sqlite-reference/quotation-pdf/service";

// Isolated synthetic rows and injected in-process replies only: no live CRM connections.
const password = "Synthetic commercial test password", hash = hashSync(password, 4);
const initialNow = Date.parse("2026-10-10T12:00:00Z");
const line = { productId: "101", productName: "Fixture product", description: "Test description", uom: "PCS", quantity: "2", unitPrice: "100", itemDiscount: "0" };
const quotation = { subject: "Synthetic quotation", kindAttention: "Fixture contact", discount: "5", adjustment: "-1", items: [line] };
const write = (id: string) => ({ status: 200, body: { data: [{ code: "SUCCESS", status: "success", details: { id } }] } });
const contact = { status: 200, body: { data: [{ id: "301", Last_Name: "Fixture contact" }] } };
const remoteQuote = (id = "401", number = "Q-2026-9") => ({ status: 200, body: { data: [{ id, Quote_No: number, Modified_Time: "2026-10-10T12:00:00+04:00" }] } });
const quoteReplies = (edit = false) => [contact, write("401"), remoteQuote(), ...(edit ? [] : [write("201")])];
function error(status: number) { return (value: unknown) => value instanceof CommercialPersistenceError && value.status === status; }
function mock(replies: Array<{ status: number; body: unknown } | Error>, before?: (request: CommercialRequest, index: number) => void) {
  const calls: CommercialRequest[] = [];
  const transport: CommercialTransport = { async request(request) {
    calls.push(structuredClone(request)); before?.(request, calls.length);
    const reply = replies.shift(); if (reply instanceof Error) throw reply;
    assert.ok(reply, "Unexpected commercial mock request"); return reply;
  } };
  return { calls, transport };
}
async function populate(db: Database.Database) {
  let clock = initialNow;
  for (let id = 1; id <= 5; id++) db.prepare("INSERT INTO users(id,user_id,username,email,password,status,company,sale_name) VALUES(?,?,?,?,?,'active',?,?)")
    .run(id, String(1000 + id), `Commercial fixture ${id}`, `commercial-${id}@example.invalid`, hash, "VOLTRONIX CONTRACTING LLC", `Sales fixture ${id}`);
  const grant = (id: number, permission: string) => {
    db.prepare("INSERT INTO permissions(key,label) VALUES(?,?) ON CONFLICT(key) DO NOTHING").run(permission, permission);
    db.prepare("INSERT INTO admin_user_permissions(admin_user_id,permission_id) SELECT ?,id FROM permissions WHERE key=?").run(id, permission);
  };
  grant(1, "leads.manage.agents"); grant(1, "items.write"); grant(1, "items.view");
  grant(2, "leads.view"); grant(2, "items.view"); grant(3, "leads.manage.agents"); grant(3, "leads.view");
  grant(4, "electrical.manage");
  for (const [id, owner, external] of [[1, "1001", "201"], [2, "1003", "202"], [3, "1001", "203"]] as const)
    db.prepare("INSERT INTO tasks(id,assigned_to,zoho_crm_id,deal_name,status,deal_number,account_name) VALUES(?,?,?,?,'Qualification',?,?)")
      .run(id, owner, external, `Synthetic deal ${id}`, `TEST-${id}`, "Synthetic account");
  db.prepare("INSERT INTO products(product_id,product_name,description,unit_price,created_at,updated_at) VALUES('101','Fixture product','Test description','100',?,?)")
    .run(new Date(clock).toISOString(), new Date(clock).toISOString());
  db.prepare("INSERT INTO departments_assign(task_id,user_id,department,status) VALUES(1,4,'Electrical','Assigned')").run();
  const auth = createAuthService(db, { now: () => clock });
  const login = async (id: number) => (await auth.login(`commercial-${id}@example.invalid`, password, "commercial fixture")).sessionToken;
  return { db, auth, grant, owner: await login(1), reader: await login(2), other: await login(3), worker: await login(4), denied: await login(5),
    service: (transport?: CommercialTransport) => createCommercialService(db, { transport, now: () => clock }), setNow: (value: number) => { clock = value; } };
}
async function fixture(t: TestContext) {
  const db = new Database(":memory:"); configureDatabase(db); migrateDatabase(db); t.after(() => db.close()); return populate(db);
}
function count(db: Database.Database, table: "products" | "crm_quotations" | "proposal_items" | "crm_commercial_operations" | "crm_commercial_audit_events") {
  return (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
}
const create = (value = quotation) => ({ operationId: randomUUID(), expectedVersion: 1, quotation: value });

test("commercial migration upgrades v7 without changing preexisting source fields or inventing rows", () => {
  const db = new Database(":memory:"); configureDatabase(db);
  try {
    db.exec("CREATE TABLE crm_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP) STRICT");
    for (const migration of migrations.filter((entry) => entry.version <= 7)) {
      db.exec(migration.sql); db.prepare("INSERT INTO crm_schema_migrations(version,name,checksum) VALUES(?,?,?)")
        .run(migration.version, migration.name, createHash("sha256").update(migration.sql).digest("hex"));
    }
    db.prepare("INSERT INTO users(id,user_id,username,email,password,status) VALUES(1,'1001','Synthetic migration user','migration@example.invalid',?,'active')").run(hash);
    db.prepare("INSERT INTO tasks(id,assigned_to,deal_name,status,service_charge,quote_number) VALUES(1,'1001','Synthetic prior task','Qualification','123.45','SOURCE-7')").run();
    const before = db.prepare("SELECT * FROM tasks").get() as Record<string, unknown>;
    assert.equal(migrateDatabase(db), migrations.length - 7); assert.equal(migrateDatabase(db), 0);
    const after = db.prepare("SELECT * FROM tasks").get() as Record<string, unknown>;
    for (const [key, value] of Object.entries(before)) assert.equal(after[key], value);
    assert.equal(after.quote_id, null);
    assert.deepEqual(db.prepare("SELECT company,sale_name FROM users").get(), { company: null, sale_name: null });
    for (const table of ["products", "crm_quotations", "proposal_items", "crm_commercial_operations", "crm_commercial_audit_events"] as const) assert.equal(count(db, table), 0);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally { db.close(); }
});

test("unconfigured runtime denies valid writes without business rows, journal reservations or fabricated success", async (t) => {
  const f = await fixture(t), service = f.service();
  await assert.rejects(service.createProduct(f.owner, { operationId: randomUUID(), name: "Product", description: "" }), error(503));
  await assert.rejects(service.createQuotation(f.owner, "1", create()), error(503));
  assert.equal(count(f.db, "products"), 1); assert.equal(count(f.db, "crm_quotations"), 0);
  assert.equal(count(f.db, "crm_commercial_operations"), 0); assert.equal(count(f.db, "crm_commercial_audit_events"), 0);
  assert.equal(service.getCapabilities(f.owner).integrationAvailable, false);
});

test("product acknowledgement persists exact external identity, fields, unknown price and immutable audit, with idempotent replay", async (t) => {
  const f = await fixture(t), port = mock([write("102")]), service = f.service(port.transport);
  const input = { operationId: randomUUID(), name: "Synthetic 100% product", description: "Fixture description\nsecond line" };
  const result = await service.createProduct(f.owner, input);
  assert.deepEqual(result, { operationId: input.operationId, productId: "102", version: 1 });
  assert.equal(service.getProduct(f.reader, "102").unitPrice, null);
  assert.equal(service.getProduct(f.reader, "102").description, input.description);
  assert.equal(service.listProducts(f.reader, { query: "100%", pageSize: 1 }).total, 1);
  assert.equal(service.listProducts(f.reader, { query: "_" }).total, 0);
  assert.deepEqual(await service.createProduct(f.owner, input), result); assert.equal(port.calls.length, 1);
  await assert.rejects(service.createProduct(f.owner, { ...input, name: "Changed" }), error(409));
  assert.equal(count(f.db, "crm_commercial_audit_events"), 1);
  assert.deepEqual(f.db.prepare("SELECT actor_user_id,action,target_id FROM crm_commercial_audit_events").get(), { actor_user_id: 1, action: "product.create", target_id: "102" });
  assert.throws(() => f.db.prepare("UPDATE crm_commercial_audit_events SET target_id='x'").run(), /immutable/);
  assert.throws(() => f.db.prepare("DELETE FROM crm_commercial_audit_events").run(), /immutable/);
});

test("quote create atomically persists source headers, relational lines, exact totals, identities, task transition and audit", async (t) => {
  const f = await fixture(t), port = mock(quoteReplies()), service = f.service(port.transport);
  const input = create({ ...quotation, items: [{ ...line, itemDiscount: "10" }] });
  const result = await service.createQuotation(f.owner, "1", input), detail = service.getQuotation(f.reader, "1");
  assert.equal(result.version, 2); assert.equal(result.quoteVersion, 1); assert.equal(detail.externalId, "401");
  assert.equal(detail.quoteNumber, "Q-2026-9"); assert.equal(detail.task.quoteDealNumber, "QUOTE-9");
  assert.equal(detail.task.status, "Proposal/Price Quote"); assert.equal(detail.totals.subtotal, "180.00");
  assert.equal(detail.totals.vatAmount, "8.75"); assert.equal(detail.grandTotal, "182.75");
  assert.equal(detail.calculationPolicy, "percentage-create-v1"); assert.equal(detail.task.assignedCompany, "VOLTRONIX CONTRACTING LLC");
  assert.deepEqual(f.db.prepare("SELECT product_id,quantity,item_discount,service_charge,total FROM proposal_items").get(),
    { product_id: "101", quantity: "2", item_discount: "10", service_charge: "100", total: "180.00" });
  assert.deepEqual(f.db.prepare("SELECT quote_id,quote_number,service_charge,version FROM tasks WHERE id=1").get(),
    { quote_id: "401", quote_number: "Q-2026-9", service_charge: "180.00", version: 2 });
  assert.equal(service.quotationCapabilities(f.owner, "1").discountedEditBlocked, true);
  assert.deepEqual(await service.createQuotation(f.owner, "1", input), result); assert.equal(port.calls.length, 4);
  assert.deepEqual(f.db.prepare("SELECT state,remote_references FROM crm_commercial_operations").get(),
    { state: "completed", remote_references: '{"quoteId":"401","dealId":"201"}' });
  assert.equal(count(f.db, "crm_commercial_audit_events"), 1); assert.deepEqual(f.db.pragma("foreign_key_check"), []);
});

test("quotation list includes recorded task context and source Amount without widening agent scope or writing on read", async t => {
  const f = await fixture(t), service = f.service(mock(quoteReplies()).transport);
  await service.createQuotation(f.owner, "1", create());
  f.db.prepare("UPDATE tasks SET Job_Status='Hold' WHERE id=1").run();
  const before = f.db.prepare("SELECT * FROM tasks WHERE id=1").get();
  const result = service.listQuotations(f.owner);
  assert.equal(result.total, 1);
  assert.deepEqual({ dealNumber: result.items[0]!.dealNumber, dealStatus: result.items[0]!.dealStatus, jobStatus: result.items[0]!.jobStatus },
    { dealNumber: "TEST-1", dealStatus: "Proposal/Price Quote", jobStatus: "Hold" });
  assert.equal(result.items[0]!.subtotal, "200.00");
  assert.equal(result.items[0]!.grandTotal, "203.75");
  assert.equal(service.listQuotations(f.other).total, 0);
  assert.deepEqual(f.db.prepare("SELECT * FROM tasks WHERE id=1").get(), before);
  for (const sort of ["createdAt", "quoteNumber", "dealNumber", "accountName", "dealStatus", "jobStatus", "assignedName", "subtotal"]) {
    assert.equal(service.listQuotations(f.owner, { sort, direction: "asc", pageSize: 10 }).total, 1);
    assert.equal(service.listQuotations(f.other, { sort, direction: "desc", pageSize: 100 }).total, 0);
  }
  for (const input of [{ sort: "q.id; DELETE FROM tasks" }, { sort: "__proto__" }, { direction: "sideways" }]) assert.throws(() => service.listQuotations(f.owner, input), error(400));
});

test("item list sorts authorized records before pagination and rejects unrecognized ordering", async t => {
  const f = await fixture(t), service = f.service();
  f.db.prepare("INSERT INTO products(product_id,product_name,created_at,updated_at) VALUES('102','A first item','2026-10-11T00:00:00Z','2026-10-11T00:00:00Z')").run();
  assert.equal(service.listProducts(f.reader, { sort: "name", direction: "asc", pageSize: 1 }).items[0]!.externalId, "102");
  assert.equal(service.listProducts(f.reader, { sort: "name", direction: "desc", pageSize: 1 }).items[0]!.externalId, "101");
  assert.equal(service.listProducts(f.reader, { sort: "updatedAt", direction: "desc", pageSize: 1 }).items[0]!.externalId, "102");
  assert.equal(service.listProducts(f.reader, { sort: "name", direction: "asc", pageSize: 1, page: 2 }).items[0]!.externalId, "101");
  assert.throws(() => service.listProducts(f.denied, { sort: "name" }), error(403));
  for (const input of [{ sort: "name desc; DELETE FROM products" }, { sort: "constructor" }, { direction: "DESC" }]) assert.throws(() => service.listProducts(f.reader, input), error(400));
});

test("zero-discount edit replaces line set and header in a versioned transaction without inventing a deal transition or history", async (t) => {
  const f = await fixture(t), port = mock([...quoteReplies(), ...quoteReplies(true)]), service = f.service(port.transport);
  await service.createQuotation(f.owner, "1", create());
  const input = { operationId: randomUUID(), expectedVersion: 2, expectedQuoteVersion: 1,
    quotation: { ...quotation, subject: "Revised synthetic quote", items: [{ ...line, quantity: "0.333333333333333333", unitPrice: "3" }, { ...line, quantity: "1", unitPrice: "0.005" }] } };
  const result = await service.updateQuotation(f.owner, "1", input), detail = service.getQuotation(f.owner, "1");
  assert.equal(result.version, 3); assert.equal(result.quoteVersion, 2); assert.equal(detail.quotation.subject, input.quotation.subject);
  assert.equal(detail.quotation.items.length, 2); assert.equal(detail.totals.exactSubtotal, "1.004999999999999999");
  assert.equal(detail.subtotal, "1.00"); assert.equal(detail.task.quoteDealNumber, "QUOTE-9");
  assert.equal(port.calls.filter((request) => request.path === "/Deals").length, 1);
  assert.equal(count(f.db, "crm_commercial_audit_events"), 2);
  assert.deepEqual(await service.updateQuotation(f.owner, "1", input), result); assert.equal(port.calls.length, 7);
});

test("protected commercial reads and writes enforce current grants, external ownership, agent branch and latest department assignment", async (t) => {
  const f = await fixture(t), port = mock(quoteReplies()), service = f.service(port.transport);
  await service.createQuotation(f.owner, "1", create());
  assert.throws(() => service.listProducts(null), error(401));
  assert.throws(() => service.listProducts(f.denied), error(403));
  assert.throws(() => service.getQuotation(f.denied, "1"), error(404));
  assert.throws(() => service.getQuotation(f.other, "1"), error(404));
  assert.equal(service.listQuotations(f.other).total, 0); // coexisting broad read cannot bypass agent branch
  assert.equal(service.listQuotations(f.reader).total, 1);
  assert.equal(service.getQuotation(f.worker, "1").externalId, "401");
  f.db.prepare("INSERT INTO departments_assign(task_id,user_id,department,status) VALUES(1,NULL,'Electrical','Unassigned')").run();
  assert.throws(() => service.getQuotation(f.worker, "1"), error(404));
  await assert.rejects(service.createProduct(f.reader, {}), error(403));
  await assert.rejects(service.createQuotation(f.reader, "1", {}), error(403));
  await assert.rejects(service.createQuotation(f.other, "1", {}), error(404));
  await assert.rejects(service.createQuotation(null, "1", {}), error(401));
  assert.equal(port.calls.length, 4);
  f.db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=1").run();
  assert.throws(() => service.getQuotation(f.owner, "1"), error(404));
  f.db.prepare("UPDATE users SET status='inactive' WHERE id=2").run();
  assert.throws(() => service.listQuotations(f.reader), error(401));
  f.setNow(initialNow + SESSION_LIFETIME_MS);
  assert.throws(() => service.getCapabilities(f.other), error(401));
});

test("candidate selection and local cache lists use literal bounded search and owned persisted identities", async (t) => {
  const f = await fixture(t), service = f.service();
  assert.equal(service.listQuotationCandidates(f.owner).total, 2);
  assert.deepEqual(service.listQuotationCandidates(f.owner, { query: "TEST-3", pageSize: 1 }).items.map((item) => item.taskId), ["3"]);
  assert.equal(service.listQuotationCandidates(f.other).total, 1);
  assert.equal(service.listQuotationCandidates(f.owner, { query: "%" }).total, 0);
  assert.throws(() => service.listQuotationCandidates(f.reader), error(403));
  for (const input of [{ page: 0 }, { pageSize: 101 }, { query: "x\ny" }, { sort: "injected" }]) assert.throws(() => service.listProducts(f.reader, input), error(400));
  assert.equal(service.listProducts(f.reader, { page: 2, pageSize: 1 }).items.length, 0);
  assert.throws(() => service.getProduct(f.reader, "101 OR 1=1"), error(404));
});

test("validation, stale task and quote versions, missing products and contradictory identities fail before any journal or remote effect", async (t) => {
  const f = await fixture(t), port = mock(quoteReplies()), service = f.service(port.transport);
  for (const q of [{ ...quotation, subject: "" }, { ...quotation, kindAttention: "x),(id:equals:1)" },
    { ...quotation, items: [{ ...line, productId: "999" }] }, { ...quotation, items: [{ ...line, productName: "Spoofed name" }] },
    { ...quotation, items: [{ ...line, quantity: "0" }] }, { ...quotation, submittedTotal: "1" },
    { ...quotation, items: [{ ...line, quantity: "999999999999999999", unitPrice: "999999999999999999" }] },
    { ...quotation, items: Array.from({ length: 200 }, () => ({ ...line, description: "x".repeat(2000) })) }]) {
    await assert.rejects(service.createQuotation(f.owner, "1", { ...create(), quotation: q }), error(400));
  }
  await assert.rejects(service.createQuotation(f.owner, "1", { ...create(), expectedVersion: 2 }), error(409));
  assert.equal(count(f.db, "crm_commercial_operations"), 0); assert.equal(port.calls.length, 0);
  await service.createQuotation(f.owner, "1", create());
  await assert.rejects(service.updateQuotation(f.owner, "1", { ...create(), expectedVersion: 2, expectedQuoteVersion: 2 }), error(409));
  f.db.prepare("UPDATE tasks SET quote_id='999' WHERE id=1").run();
  await assert.rejects(service.updateQuotation(f.owner, "1", { ...create(), expectedVersion: 2, expectedQuoteVersion: 1 }), error(409));
  assert.throws(() => service.getQuotation(f.owner, "1"), error(503));
  assert.equal(count(f.db, "crm_commercial_operations"), 1); assert.equal(port.calls.length, 4);
});

test("discounted edits stay blocked for either the saved or submitted lines, including zeroing or removing existing discounts", async (t) => {
  const f = await fixture(t), port = mock([...quoteReplies(), contact, write("402"), remoteQuote("402", "Q-10"), write("203")]), service = f.service(port.transport);
  await service.createQuotation(f.owner, "1", create({ ...quotation, items: [{ ...line, itemDiscount: "10" }] }));
  await assert.rejects(service.updateQuotation(f.owner, "1", { ...create(), expectedVersion: 2, expectedQuoteVersion: 1 }), error(409));
  await service.createQuotation(f.owner, "3", create());
  await assert.rejects(service.updateQuotation(f.owner, "3", { ...create({ ...quotation, items: [{ ...line, itemDiscount: "0.0001" }] }), expectedVersion: 2, expectedQuoteVersion: 1 }), error(409));
  assert.equal(port.calls.length, 8); assert.equal(count(f.db, "crm_commercial_operations"), 2);
});

test("partial remote success preserves receipts, blocks retry and prevents a local quote when deal transition fails", async (t) => {
  const f = await fixture(t), port = mock([contact, write("401"), remoteQuote(), { status: 500, body: { private: "do not echo" } }]), service = f.service(port.transport);
  const input = create(); await assert.rejects(service.createQuotation(f.owner, "1", input), error(503));
  assert.equal(count(f.db, "crm_quotations"), 0); assert.equal(count(f.db, "proposal_items"), 0);
  assert.deepEqual(f.db.prepare("SELECT version,status,quote_id FROM tasks WHERE id=1").get(), { version: 1, status: "Qualification", quote_id: null });
  assert.deepEqual(f.db.prepare("SELECT state,remote_effect_possible,remote_references FROM crm_commercial_operations").get(),
    { state: "reconciliation", remote_effect_possible: 1, remote_references: '{"quoteId":"401"}' });
  await assert.rejects(service.createQuotation(f.owner, "1", input), error(409));
  await assert.rejects(service.createQuotation(f.owner, "1", create()), error(409));
  assert.equal(port.calls.length, 4); assert.equal(service.quotationCapabilities(f.owner, "1").canCreate, false);
});

test("grant revocation between requests prevents further effects, while acknowledged IDs remain available for reconciliation", async (t) => {
  const f = await fixture(t), port = mock([contact, write("401")], (_request, index) => {
    if (index === 2) f.db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=1").run();
  }), service = f.service(port.transport);
  await assert.rejects(service.createQuotation(f.owner, "1", create()), error(403));
  assert.equal(port.calls.length, 2); assert.equal(count(f.db, "crm_quotations"), 0);
  assert.deepEqual(f.db.prepare("SELECT state,remote_references FROM crm_commercial_operations").get(), { state: "reconciliation", remote_references: '{"quoteId":"401"}' });
});

test("concurrent local mutation during remote processing cannot overwrite the newer parent", async (t) => {
  const f = await fixture(t), port = mock([contact, write("401")], (_request, index) => {
    if (index === 2) f.db.prepare("UPDATE tasks SET version=version+1,notes='Concurrent fixture edit' WHERE id=1").run();
  }), service = f.service(port.transport);
  await assert.rejects(service.createQuotation(f.owner, "1", create()), error(409));
  assert.deepEqual(f.db.prepare("SELECT version,notes,quote_id FROM tasks WHERE id=1").get(), { version: 2, notes: "Concurrent fixture edit", quote_id: null });
  assert.equal(count(f.db, "crm_quotations"), 0); assert.equal(port.calls.length, 2);
});

test("audit failure rolls back product or quote business rows while preserving remote acknowledgement and reconciliation", async (t) => {
  for (const kind of ["product", "quote"] as const) {
    const f = await fixture(t), port = mock(kind === "product" ? [write("102")] : quoteReplies()), service = f.service(port.transport);
    f.db.exec("CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON crm_commercial_audit_events BEGIN SELECT RAISE(ABORT,'Synthetic private DB failure'); END");
    await assert.rejects(kind === "product" ? service.createProduct(f.owner, { operationId: randomUUID(), name: "New fixture", description: "" }) : service.createQuotation(f.owner, "1", create()), error(503));
    assert.equal(count(f.db, "products"), 1); assert.equal(count(f.db, "crm_quotations"), 0); assert.equal(count(f.db, "proposal_items"), 0);
    assert.equal(count(f.db, "crm_commercial_audit_events"), 0);
    assert.equal((f.db.prepare("SELECT version FROM tasks WHERE id=1").get() as { version: number }).version, 1);
    assert.equal((f.db.prepare("SELECT state FROM crm_commercial_operations").get() as { state: string }).state, "reconciliation");
  }
});

test("edit audit rollback preserves prior quote, line set and versions rather than losing an existing document", async (t) => {
  const f = await fixture(t), port = mock([...quoteReplies(), ...quoteReplies(true)]), service = f.service(port.transport);
  await service.createQuotation(f.owner, "1", create()); const before = service.getQuotation(f.owner, "1");
  f.db.exec("CREATE TRIGGER fixture_edit_audit_failure BEFORE INSERT ON crm_commercial_audit_events WHEN NEW.action='quote.edit' BEGIN SELECT RAISE(ABORT,'Synthetic failure'); END");
  await assert.rejects(service.updateQuotation(f.owner, "1", { ...create({ ...quotation, subject: "Not committed", items: [{ ...line, quantity: "9" }] }), expectedVersion: 2, expectedQuoteVersion: 1 }), error(503));
  assert.deepEqual(service.getQuotation(f.owner, "1"), before);
  assert.equal(count(f.db, "proposal_items"), 1); assert.equal(count(f.db, "crm_commercial_audit_events"), 1);
  assert.equal(service.quotationCapabilities(f.owner, "1").canEdit, false);
});

test("invalid acknowledgement, exception, conflicting remote ID and ambiguous contacts return safe errors without committing", async (t) => {
  for (const replies of [[{ status: 200, body: { data: [{ id: "missing success status" }] } }], [new Error("Synthetic secret must not escape")], [write("101")]]) {
    const f = await fixture(t), port = mock(replies), service = f.service(port.transport);
    await assert.rejects(service.createProduct(f.owner, { operationId: randomUUID(), name: "Synthetic", description: "" }), (value: unknown) => {
      assert.ok(value instanceof CommercialPersistenceError); assert.ok([409, 503].includes(value.status));
      assert.doesNotMatch(value.message, /Synthetic secret|missing success/); return true;
    });
    assert.equal(count(f.db, "products"), 1); assert.equal(count(f.db, "crm_commercial_audit_events"), 0);
  }
  const f = await fixture(t), port = mock([{ status: 200, body: { data: [{ id: "301", Last_Name: "Fixture" }, { id: "302", Last_Name: "Fixture" }] } }]), service = f.service(port.transport);
  await assert.rejects(service.createQuotation(f.owner, "1", create()), error(503));
  assert.equal(port.calls.length, 1); assert.equal(count(f.db, "crm_quotations"), 0);
  assert.equal((f.db.prepare("SELECT remote_effect_possible FROM crm_commercial_operations").get() as { remote_effect_possible: number }).remote_effect_possible, 0);
});

test("source contact creation and empty-description product fetch are verified before committing normalized lines", async (t) => {
  const f = await fixture(t), port = mock([{ status: 204, body: null }, write("301"),
    { status: 200, body: { data: [{ id: "101", Description: "Acknowledged product description" }] } }, write("401"), remoteQuote(), write("201")]), service = f.service(port.transport);
  await service.createQuotation(f.owner, "1", create({ ...quotation, items: [{ ...line, description: "" }] }));
  assert.equal(service.getQuotation(f.owner, "1").quotation.items[0]!.description, "Acknowledged product description");
  assert.deepEqual(f.db.prepare("SELECT remote_references FROM crm_commercial_operations").get(), { remote_references: '{"contactId":"301","quoteId":"401","dealId":"201"}' });
  assert.equal(port.calls[2]!.path, "/Products/101");
});

test("active lead journals block commercial mutation; current quote item task relation is enforced by SQLite", async (t) => {
  const f = await fixture(t), port = mock(quoteReplies()), service = f.service(port.transport);
  const op = randomUUID(); f.db.prepare("INSERT INTO crm_lead_operations(operation_id,actor_user_id,task_id,kind,request_hash,state,created_at,updated_at) VALUES(?,1,1,'lead.stage',?,'reconciliation',?,?)")
    .run(op, "0".repeat(64), new Date(initialNow).toISOString(), new Date(initialNow).toISOString());
  await assert.rejects(service.createQuotation(f.owner, "1", create()), error(409)); assert.equal(port.calls.length, 0);
  assert.equal(service.quotationCapabilities(f.owner, "1").blockedOperationId, op);
  f.db.prepare("UPDATE crm_lead_operations SET state='completed' WHERE operation_id=?").run(op);
  await service.createQuotation(f.owner, "1", create());
  assert.throws(() => f.db.prepare("UPDATE proposal_items SET task_id=2").run(), /FOREIGN KEY/);
  f.db.prepare("UPDATE crm_quotations SET totals_json='{}'").run();
  assert.throws(() => service.getQuotation(f.reader, "1"), error(503));
});

test("an uncertain commercial operation also blocks lead stage mutations and advertises the same operation ID", async (t) => {
  const f = await fixture(t), input = create(), port = mock([contact, write("401"), new Error("Synthetic interruption")]);
  await assert.rejects(f.service(port.transport).createQuotation(f.owner, "1", input), error(503));
  let called = false;
  const leads = createLeadMutationsService(f.db, { now: () => initialNow, transport: { async request() { called = true; return write("201"); } } });
  await assert.rejects(leads.changeStage(f.owner, "1", { operationId: randomUUID(), expectedVersion: 1, stage: "Site Visit" }),
    (value: unknown) => value instanceof LeadMutationError && value.status === 409);
  assert.equal(called, false); assert.equal(leads.capabilities(f.owner, "1").blockedOperationId, input.operationId);
});

test("the offline PDF service reads a persisted authorized quotation and refuses unrelated sessions", async (t) => {
  const f = await fixture(t), service = f.service(mock(quoteReplies()).transport);
  await service.createQuotation(f.owner, "1", create());
  const pdf = createQuotationPdfService(service), rendered = await pdf.download(f.reader, "1");
  assert.equal(rendered.bytes.subarray(0, 8).toString(), "%PDF-1.7"); assert.ok(rendered.bytes.length > 100_000);
  assert.equal(rendered.filename, "quotation_Q-2026-9.pdf");
  await assert.rejects(pdf.download(f.other, "1"), error(404));
  await assert.rejects(pdf.download(f.denied, "1"), error(404));
});

test("disk reopen preserves complete receipts and uncertain reservations; a restarted process cannot duplicate remote writes", async () => {
  const fs = filesystemFixture(); let db = openDatabase(fs.config, { create: true });
  try {
    migrateDatabase(db); const f = await populate(db), input = create(), port = mock(quoteReplies()), service = f.service(port.transport);
    const result = await service.createQuotation(f.owner, "1", input), token = f.owner;
    db.close(); db = openDatabase(fs.config);
    const forbidden = mock([]), reopened = createCommercialService(db, { transport: forbidden.transport, now: () => initialNow });
    assert.deepEqual(await reopened.createQuotation(token, "1", input), result); assert.equal(forbidden.calls.length, 0);
    assert.equal(reopened.getQuotation(token, "1").quoteNumber, "Q-2026-9");
    const uncertain = create(), failed = createCommercialService(db, { transport: mock([contact, write("402"), new Error("Fixture unavailable")]).transport, now: () => initialNow });
    await assert.rejects(failed.createQuotation(token, "3", uncertain), error(503));
    db.close(); db = openDatabase(fs.config);
    const restarted = createCommercialService(db, { transport: forbidden.transport, now: () => initialNow });
    await assert.rejects(restarted.createQuotation(token, "3", uncertain), error(409));
    await assert.rejects(restarted.createQuotation(token, "3", create()), error(409));
    assert.equal(forbidden.calls.length, 0); assert.deepEqual(db.pragma("integrity_check"), [{ integrity_check: "ok" }]); assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally { if (db.open) db.close(); fs.cleanup(); }
});
