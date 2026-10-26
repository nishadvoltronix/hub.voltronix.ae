import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { hashSync } from "bcryptjs";
import { createAuthService } from "./sqlite-reference/auth/service";
import { createCommercialService, CommercialPersistenceError } from "./sqlite-reference/commercial/service";
import type { CommercialRequest } from "./sqlite-reference/commercial/transport";
import { configureDatabase, openDatabase } from "./sqlite-reference/db/connection";
import { migrateDatabase } from "./sqlite-reference/db/migrations";
import { createLeadMutationsService, LeadMutationError } from "./sqlite-reference/lead-mutations/service";
import type { ZohoRequest } from "./sqlite-reference/lead-mutations/contracts";
import { filesystemFixture } from "./database-fixture";

// Explicit in-process replies and synthetic test databases only. No network adapter,
// credentials, approved sandbox, production data, or reconciliation repair is implied.
const now = () => Date.parse("2026-10-10T10:00:00Z");
const password = "Synthetic integration gate password", hash = hashSync(password, 4);
const acknowledgement = (id: string) => ({ status: 200, body: { data: [{ code: "SUCCESS", status: "success", details: { id } }] } });
const leadError = (status: number) => (error: unknown) => error instanceof LeadMutationError && error.status === status;
const commercialError = (status: number) => (error: unknown) => error instanceof CommercialPersistenceError && error.status === status;
const noteInput = () => ({ operationId: randomUUID(), expectedVersion: 1, title: "Synthetic note", content: "Fixture text" });
const productInput = () => ({ operationId: randomUUID(), name: "Synthetic product", description: "Fixture text" });
const quoteInput = () => ({ operationId: randomUUID(), expectedVersion: 1, quotation: {
  subject: "Synthetic quotation", kindAttention: "Synthetic contact", discount: "0", adjustment: "0",
  items: [{ productId: "101", productName: "Synthetic product", description: "Fixture text", uom: "PCS", quantity: "1", unitPrice: "100", itemDiscount: "0" }],
} });
async function populate(db: Database.Database) {
  db.prepare("INSERT INTO users(id,user_id,username,email,password,status) VALUES(1,'1001','Synthetic agent','gates@example.invalid',?,'active')").run(hash);
  for (const key of ["leads.manage.agents", "items.write"]) {
    db.prepare("INSERT INTO permissions(key,label) VALUES(?,?)").run(key, key);
    db.prepare("INSERT INTO admin_user_permissions(admin_user_id,permission_id) SELECT 1,id FROM permissions WHERE key=?").run(key);
  }
  db.prepare("INSERT INTO tasks(id,zoho_crm_id,assigned_to,deal_name,status) VALUES(1,'201','1001','Synthetic deal','Qualification')").run();
  db.prepare("INSERT INTO products(product_id,product_name,description,created_at,updated_at) VALUES('101','Synthetic product','Fixture text',?,?)")
    .run(new Date(now()).toISOString(), new Date(now()).toISOString());
  const auth = createAuthService(db, { now });
  const token = (await auth.login("gates@example.invalid", password, "isolated integration gates")).sessionToken;
  return { db, token, auth };
}
async function fixture(t: TestContext) {
  const db = new Database(":memory:"); configureDatabase(db); migrateDatabase(db); t.after(() => db.close());
  return populate(db);
}
function count(db: Database.Database, table: "job_notes" | "tasks_status_log" | "crm_quotations" | "crm_lead_audit_events" | "crm_commercial_audit_events") {
  return (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
}

test("invalid transport status cannot masquerade as a successful lead acknowledgement", async (t) => {
  for (const status of [NaN, 200.5, Infinity, -Infinity]) {
    const f = await fixture(t), input = noteInput(); let calls = 0;
    const service = createLeadMutationsService(f.db, { now, transport: { async request() {
      calls++; return { ...acknowledgement("301"), status };
    } } });
    await assert.rejects(service.addNote(f.token, "1", input), leadError(503));
    assert.equal(calls, 1); assert.equal(count(f.db, "job_notes"), 0); assert.equal(count(f.db, "crm_lead_audit_events"), 0);
    assert.deepEqual(f.db.prepare("SELECT state,remote_effect_possible,remote_references FROM crm_lead_operations").get(),
      { state: "reconciliation", remote_effect_possible: 1, remote_references: "{}" });
    await assert.rejects(service.addNote(f.token, "1", input), leadError(409));
    await assert.rejects(service.addNote(f.token, "1", noteInput()), leadError(409));
    assert.equal(calls, 1);
  }
});

test("rate limits and remote server errors never automatically repeat lead writes or expose remote bodies", async (t) => {
  for (const status of [429, 500, 503]) {
    const f = await fixture(t), input = noteInput(); let calls = 0;
    const service = createLeadMutationsService(f.db, { now, transport: { async request() {
      calls++; return { status, body: { error: "SYNTHETIC_PRIVATE_REMOTE_BODY" } };
    } } });
    await assert.rejects(service.addNote(f.token, "1", input), (error: unknown) => {
      assert.ok(error instanceof LeadMutationError); assert.equal(error.status, 503);
      assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE_REMOTE_BODY/); return true;
    });
    await assert.rejects(service.addNote(f.token, "1", noteInput()), leadError(409));
    assert.equal(calls, 1); assert.equal(count(f.db, "job_notes"), 0);
    assert.doesNotMatch(JSON.stringify(f.db.prepare("SELECT * FROM crm_lead_operations").all()), /SYNTHETIC_PRIVATE_REMOTE_BODY/);
    assert.equal(createLeadMutationsService(f.db, { now }).capabilities(f.token, "1").blockedOperationId, input.operationId);
  }
});

test("commercial failures distinguish read-only discovery from a possible write and retain both reservations", async (t) => {
  for (const writeAttempt of [false, true]) {
    const f = await fixture(t), calls: CommercialRequest[] = [], input = writeAttempt ? productInput() : quoteInput();
    const service = createCommercialService(f.db, { now, transport: { async request(request) {
      calls.push(request); return { status: 429, body: { error: "SYNTHETIC_PRIVATE_REMOTE_BODY" } };
    } } });
    const invoke = () => writeAttempt ? service.createProduct(f.token, input) : service.createQuotation(f.token, "1", input);
    await assert.rejects(invoke(), commercialError(503)); await assert.rejects(invoke(), commercialError(409));
    assert.equal(calls.length, 1); assert.equal(calls[0]!.method, writeAttempt ? "POST" : "GET");
    assert.deepEqual(f.db.prepare("SELECT state,remote_effect_possible,remote_references FROM crm_commercial_operations").get(),
      { state: "reconciliation", remote_effect_possible: Number(writeAttempt), remote_references: "{}" });
    assert.equal(count(f.db, "crm_quotations"), 0); assert.equal(count(f.db, "crm_commercial_audit_events"), 0);
    assert.doesNotMatch(JSON.stringify(f.db.prepare("SELECT * FROM crm_commercial_operations").all()), /SYNTHETIC_PRIVATE_REMOTE_BODY/);
  }
});

test("bounded stage readback can converge without issuing a second remote mutation", async (t) => {
  const f = await fixture(t), calls: ZohoRequest[] = [], waits: number[] = []; let reads = 0;
  const service = createLeadMutationsService(f.db, { now, wait: async (ms) => { waits.push(ms); }, transport: { async request(request) {
    calls.push(request); assert.equal(f.db.inTransaction, false);
    if (request.method === "PUT") return acknowledgement("201");
    reads++; return { status: 200, body: { data: [{ id: "201", Stage: reads < 3 ? "Qualification" : "Site Visit",
      DealNumber: "SYNTHETIC-D", SiteDealNumber: reads < 3 ? "" : "SYNTHETIC-S" }] } };
  } } });
  const input = { operationId: randomUUID(), expectedVersion: 1, stage: "Site Visit" };
  const result = await service.changeStage(f.token, "1", input);
  assert.equal(result.version, 2); assert.equal(calls.filter((request) => request.method === "PUT").length, 1);
  assert.equal(reads, 3); assert.deepEqual(waits, [2000, 2000]);
  assert.deepEqual(f.db.prepare("SELECT status,version,site_deal_number FROM tasks WHERE id=1").get(),
    { status: "Site Visit", version: 2, site_deal_number: "SYNTHETIC-S" });
  assert.equal(count(f.db, "tasks_status_log"), 1); assert.equal(count(f.db, "crm_lead_audit_events"), 1);
  assert.deepEqual(await createLeadMutationsService(f.db, { now }).changeStage(f.token, "1", input), result);
  assert.equal(calls.length, 4);
});

test("two SQLite connections serialize commercial and lead intents while external work is pending", async () => {
  const fs = filesystemFixture(), first = openDatabase(fs.config, { create: true }); let second: Database.Database | undefined;
  let release: (() => void) | undefined;
  try {
    migrateDatabase(first); const f = await populate(first); second = openDatabase(fs.config);
    const calls: CommercialRequest[] = [], gate = new Promise<void>((resolve) => { release = resolve; });
    const service = createCommercialService(first, { now, transport: { async request(request) {
      calls.push(request); assert.equal(first.inTransaction, false);
      if (request.path.startsWith("/Contacts/search?")) { await gate; return { status: 200, body: { data: [{ id: "301", Last_Name: "Synthetic contact" }] } }; }
      if (request.method === "POST") return acknowledgement("401");
      if (request.method === "GET") return { status: 200, body: { data: [{ id: "401", Quote_No: "SYNTHETIC-Q", Modified_Time: "2026-10-10T10:00:00Z" }] } };
      return acknowledgement("201");
    } } });
    const input = quoteInput(), pending = service.createQuotation(f.token, "1", input);
    let forbiddenCalls = 0;
    const forbiddenTransport = { async request() { forbiddenCalls++; return acknowledgement("999"); } };
    try {
      assert.equal(calls.length, 1);
      assert.deepEqual(second.prepare("SELECT state,remote_effect_possible FROM crm_commercial_operations").get(), { state: "inflight", remote_effect_possible: 0 });
      await assert.rejects(createCommercialService(second, { now, transport: forbiddenTransport }).createQuotation(f.token, "1", input), commercialError(409));
      await assert.rejects(createLeadMutationsService(second, { now, transport: forbiddenTransport }).addNote(f.token, "1", noteInput()), leadError(409));
      assert.equal(forbiddenCalls, 0); assert.equal(count(second, "job_notes"), 0); assert.equal(count(second, "crm_quotations"), 0);
    } finally { release!(); await pending; }
    assert.equal(count(second, "crm_quotations"), 1); assert.equal(count(second, "crm_commercial_audit_events"), 1);
    assert.equal(calls.length, 4); assert.deepEqual(second.pragma("foreign_key_check"), []);
  } finally { release?.(); second?.close(); first.close(); fs.cleanup(); }
});

test("completed commercial receipts replay without a transport but still require current permissions", async (t) => {
  const f = await fixture(t), input = productInput(); let calls = 0;
  const service = createCommercialService(f.db, { now, transport: { async request() { calls++; return acknowledgement("102"); } } });
  const result = await service.createProduct(f.token, input), disabled = createCommercialService(f.db, { now });
  assert.deepEqual(await disabled.createProduct(f.token, input), result); assert.equal(calls, 1);
  assert.equal(count(f.db, "crm_commercial_audit_events"), 1);
  f.db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=1 AND permission_id=(SELECT id FROM permissions WHERE key='items.write')").run();
  await assert.rejects(disabled.createProduct(f.token, input), commercialError(403));
  assert.equal(calls, 1); assert.equal(count(f.db, "crm_commercial_audit_events"), 1);
});
