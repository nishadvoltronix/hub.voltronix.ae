import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { hashSync } from "bcryptjs";
import { createAuthService } from "./sqlite-reference/auth/service";
import { configureDatabase, openDatabase } from "./sqlite-reference/db/connection";
import { migrateDatabase } from "./sqlite-reference/db/migrations";
import { createLeadMutationsService, LeadMutationError } from "./sqlite-reference/lead-mutations/service";
import type { ZohoRequest, ZohoTransport } from "./sqlite-reference/lead-mutations/contracts";
import { filesystemFixture } from "./database-fixture";

const NOW = Date.parse("2026-10-10T10:00:00.000Z"), password = "Synthetic lead mutation password", passwordHash = hashSync(password, 4);
function grant(db: Database.Database, id: number, key: string) {
  db.prepare('INSERT INTO permissions("key",label) VALUES(?,?) ON CONFLICT("key") DO NOTHING').run(key, key);
  db.prepare('INSERT INTO admin_user_permissions(admin_user_id,permission_id) SELECT ?,id FROM permissions WHERE "key"=?').run(id, key);
}
function setup(db: Database.Database) {
  for (let id = 1; id <= 5; id++) db.prepare("INSERT INTO users(id,user_id,username,email,password,status) VALUES(?,?,?,?,?,'active')")
    .run(id, id === 5 ? null : `90000000000000${id}`, `Synthetic agent ${id}`, `lead-${id}@example.invalid`, passwordHash);
  for (const key of ["leads.manage.agents", "deals.manage"]) grant(db, 1, key);
  for (const key of ["leads.view", "leads.manage", "deals.manage"]) grant(db, 2, key);
  grant(db, 3, "leads.view"); grant(db, 5, "deals.manage");
  for (const id of [1, 2]) db.prepare("INSERT INTO tasks(id,zoho_crm_id,deal_name,status,assigned_to) VALUES(?,?,?,'Pending',?)")
    .run(id, `70000000000000${id}`, `Synthetic lead ${id}`, `90000000000000${id}`);
}
const ok = (id: string) => ({ status: 200, body: { data: [{ code: "SUCCESS", status: "success", details: { id } }] } });
function fixtureTransport(db: Database.Database) {
  const calls: ZohoRequest[] = [];
  let stage = "Site Visit";
  const transport: ZohoTransport = { async request(req) {
    assert.equal(db.inTransaction, false, "network must not hold a SQLite transaction"); calls.push(req);
    if (req.method === "PUT" && req.path.startsWith("/Deals/")) {
      stage = (req.body as { data: Array<{ Stage: string }> }).data[0]!.Stage; return ok(req.path.split("/")[2]!);
    }
    if (req.method === "GET") return { status: 200, body: { data: [{ id: req.path.split("/")[2], Stage: stage,
      DealNumber: "SYNTHETIC-D-1", SiteDealNumber: "SYNTHETIC-S-1", QuoteDealNumber: "SYNTHETIC-Q-1", JobDealNumber: "SYNTHETIC-J-1",
      Site_Deal_Date: "2026-10-10T14:00:00+04:00" }] } };
    return ok(req.path.startsWith("/Notes/") ? req.path.split("/")[2]! : `80000000000000${calls.length}`);
  } };
  return { calls, transport };
}
async function populate(db: Database.Database) {
  setup(db);
  const auth = createAuthService(db, { now: () => NOW });
  const login = async (id: number) => (await auth.login(`lead-${id}@example.invalid`, password, "synthetic-test")).sessionToken;
  const mock = fixtureTransport(db);
  return { db, auth, mock, login, owner: await login(1), broad: await login(2), reader: await login(3), denied: await login(4), localCreator: await login(5),
    service: createLeadMutationsService(db, { transport: mock.transport, now: () => NOW, wait: async () => {} }) };
}
async function fixture(t: TestContext) {
  const db = new Database(":memory:"); configureDatabase(db); migrateDatabase(db); t.after(() => db.close()); return populate(db);
}
const code = (expected: number) => (error: unknown) => error instanceof LeadMutationError && error.status === expected;
const noteInput = (expectedVersion = 1) => ({ operationId: randomUUID(), expectedVersion, title: "Synthetic note", content: "Synthetic note content" });
const stageInput = (expectedVersion = 1, stage = "Site Visit") => ({ operationId: randomUUID(), expectedVersion, stage });
function state(db: Database.Database, operationId: string) {
  return db.prepare("SELECT state,remote_effect_possible,remote_id,remote_references FROM crm_lead_operations WHERE operation_id=?").get(operationId) as
    { state: string; remote_effect_possible: number; remote_id: string | null; remote_references: string } | undefined;
}
function count(db: Database.Database, table: string) { return (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n; }

test("lead mutations authenticate and require explicit grants before parsing input", async (t) => {
  const f = await fixture(t);
  for (const [token, status] of [[null, 401], [f.reader, 403], [f.denied, 403]] as const) {
    for (const work of [() => f.service.changeStage(token, "bad", {}), () => f.service.addNote(token, "bad", {}),
      () => f.service.editNote(token, "bad", "bad", {}), () => f.service.createDeal(token, {})]) await assert.rejects(work, code(status));
  }
  assert.equal(f.mock.calls.length, 0); assert.equal(count(f.db, "crm_lead_operations"), 0);
});
test("lead mutation capabilities preserve owner scope and runtime absence never starts an operation", async (t) => {
  const f = await fixture(t), runtime = createLeadMutationsService(f.db, { now: () => NOW });
  assert.deepEqual(runtime.capabilities(f.owner, "1"), { version: 1, canChangeStage: true, canWriteNotes: true,
    stages: ["Site Visit", "Closed Lost"], integrationAvailable: false });
  assert.equal(runtime.capabilities(f.reader, "1").canWriteNotes, false);
  assert.throws(() => runtime.capabilities(f.owner, "2"), code(404));
  await assert.rejects(() => runtime.addNote(f.owner, "1", noteInput()), code(503));
  await assert.rejects(() => runtime.changeStage(f.owner, "1", stageInput()), code(503));
  assert.equal(count(f.db, "crm_lead_operations"), 0); assert.equal(count(f.db, "crm_lead_audit_events"), 0);
});
test("stage changes require exact owner, current source transition and quotation prerequisite", async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => f.service.changeStage(f.broad, "1", stageInput()), code(403));
  await assert.rejects(() => f.service.changeStage(f.owner, "2", stageInput()), code(404));
  for (const target of ["Closed Won", "Big Project", "Omitted", "Qualification", "Closed Lost; DROP TABLE tasks"])
    await assert.rejects(() => f.service.changeStage(f.owner, "1", stageInput(1, target)), code(400));
  f.db.prepare("UPDATE tasks SET status='Site Visit' WHERE id=1").run();
  await assert.rejects(() => f.service.changeStage(f.owner, "1", stageInput(1, "Proposal/Price Quote")), code(400));
  assert.equal(f.mock.calls.length, 0); assert.equal(count(f.db, "crm_lead_operations"), 0);
  f.db.prepare("UPDATE tasks SET quote_number='600000000000001' WHERE id=1").run();
  assert.ok(f.service.capabilities(f.owner, "1").stages.includes("Proposal/Price Quote"));
});
test("stage integration commits exact amount, numbers, normalized dates, history and audit once", async (t) => {
  const f = await fixture(t), input = { ...stageInput(), serviceCharge: "123456789012345678.123456789012345678" };
  const saved = await f.service.changeStage(f.owner, "1", input);
  assert.equal(saved.version, 2);
  assert.deepEqual(f.db.prepare("SELECT status,service_charge,site_deal_number,site_deal_date,version FROM tasks WHERE id=1").get(), {
    status: "Site Visit", service_charge: input.serviceCharge, site_deal_number: "SYNTHETIC-S-1", site_deal_date: "2026-10-10T10:00:00.000Z", version: 2 });
  assert.deepEqual(f.db.prepare("SELECT Task_ID,User_ID,Status FROM tasks_status_log").all(), [{ Task_ID: 1, User_ID: 1, Status: "Site Visit" }]);
  assert.deepEqual(await f.service.changeStage(f.owner, "1", input), saved);
  assert.equal(f.mock.calls.length, 2); assert.equal(count(f.db, "crm_lead_audit_events"), 1);
  assert.equal(state(f.db, input.operationId)?.state, "completed");
  const audit = f.db.prepare("SELECT changed_fields FROM crm_lead_audit_events").get() as { changed_fields: string };
  assert.ok(audit.changed_fields.includes("service_charge")); assert.ok(!audit.changed_fields.includes(input.serviceCharge));
  assert.throws(() => f.db.prepare("DELETE FROM crm_lead_audit_events").run(), /immutable/);
});
test("entire source stage progression and lost terminal state are supported without fabricated numbers", async (t) => {
  const f = await fixture(t);
  await f.service.changeStage(f.owner, "1", stageInput());
  f.db.prepare("UPDATE tasks SET quote_number='600000000000001' WHERE id=1").run();
  await f.service.changeStage(f.owner, "1", stageInput(2, "Proposal/Price Quote"));
  await f.service.changeStage(f.owner, "1", { ...stageInput(3, "Closed Won"), serviceCharge: "0" });
  assert.deepEqual(f.service.capabilities(f.owner, "1").stages, []);
  await assert.rejects(() => f.service.changeStage(f.owner, "1", stageInput(4)), code(400));
  await f.service.changeStage(f.broad, "2", stageInput(1, "Closed Lost"));
  assert.deepEqual(f.db.prepare("SELECT status,lost_deal_number FROM tasks WHERE id=2").get(), { status: "Closed Lost", lost_deal_number: null });
});
test("mutations reject malformed IDs, versions, amounts, unknown fields and invalid note text before transport", async (t) => {
  const f = await fixture(t);
  for (const id of ["0", "1 OR 1=1", "9223372036854775808", 1, null]) await assert.rejects(() => f.service.addNote(f.owner, id, noteInput()), code(404));
  for (const charge of ["", "-1", "01.00", "1e3", "1.0000000000000000001", "NaN"]) await assert.rejects(() => f.service.changeStage(f.owner, "1", { ...stageInput(), serviceCharge: charge }), code(400));
  for (const input of [{ ...noteInput(), injected: true }, { ...noteInput(), title: " " }, { ...noteInput(), content: "x\0y" },
    { ...noteInput(), operationId: "not-uuid" }, { ...noteInput(), expectedVersion: 1.5 }, { ...noteInput(), content: "x".repeat(10_001) }])
    await assert.rejects(() => f.service.addNote(f.owner, "1", input), code(400));
  await assert.rejects(() => f.service.addNote(f.owner, "1", noteInput(2)), code(409));
  assert.equal(f.mock.calls.length, 0); assert.equal(count(f.db, "crm_lead_operations"), 0);
});
test("note creation and edit persist remote-first, default titles and safe local actor audit", async (t) => {
  const f = await fixture(t), input = noteInput();
  const created = await f.service.addNote(f.owner, "1", input);
  assert.ok(created.noteId); assert.equal(created.version, 2);
  assert.deepEqual(await f.service.addNote(f.owner, "1", input), created);
  const edited = await f.service.editNote(f.owner, "1", created.noteId, { ...noteInput(2), title: "", content: "Revised synthetic content" });
  assert.equal(edited.version, 3);
  assert.deepEqual(f.db.prepare("SELECT deal_id,note_title,note_content FROM job_notes").get(), {
    deal_id: "700000000000001", note_title: "Synthetic note", note_content: "Revised synthetic content" });
  assert.equal(f.mock.calls[0]!.method, "POST"); assert.equal(f.mock.calls[0]!.path, "/Deals/700000000000001/Notes");
  assert.equal(f.mock.calls[1]!.method, "PUT"); assert.match(f.mock.calls[1]!.path, /^\/Notes\//);
  assert.equal(count(f.db, "crm_lead_audit_events"), 2);
  assert.ok(!JSON.stringify(f.db.prepare("SELECT * FROM crm_lead_operations").all()).includes("Revised synthetic"));
});
test("unlinked legacy note editing creates a remote note and never edits another parent's note", async (t) => {
  const f = await fixture(t);
  const id = String(f.db.prepare("INSERT INTO job_notes(deal_id,note_title,note_content) VALUES('700000000000001','','Synthetic old note')").run().lastInsertRowid);
  await assert.rejects(() => f.service.editNote(f.broad, "2", id, noteInput()), code(404));
  await f.service.editNote(f.owner, "1", id, { operationId: randomUUID(), expectedVersion: 1, content: "Synthetic revision" });
  assert.equal(f.mock.calls[0]!.method, "POST");
  assert.equal((f.db.prepare("SELECT note_title FROM job_notes WHERE id=?").get(id) as { note_title: string }).note_title, "Lead Note");
});
test("remote exceptions are redacted, leave local state untouched and block duplicate retry even with a new key", async (t) => {
  const f = await fixture(t), input = noteInput(); let calls = 0;
  const service = createLeadMutationsService(f.db, { now: () => NOW, transport: { async request() { calls++; throw new Error("private remote response must never escape"); } } });
  await assert.rejects(() => service.addNote(f.owner, "1", input), (e) => code(503)(e) && !String(e).includes("private remote"));
  assert.equal(state(f.db, input.operationId)?.state, "reconciliation"); assert.equal(state(f.db, input.operationId)?.remote_effect_possible, 1);
  await assert.rejects(() => service.addNote(f.owner, "1", input), code(409));
  await assert.rejects(() => service.addNote(f.owner, "1", noteInput()), code(409));
  assert.equal(calls, 1); assert.equal(count(f.db, "job_notes"), 0); assert.equal(count(f.db, "crm_lead_audit_events"), 0);
  assert.ok(!JSON.stringify(f.db.prepare("SELECT * FROM crm_lead_operations").all()).includes("private remote"));
});
test("same operation key cannot change content, actor or operation type", async (t) => {
  const f = await fixture(t), input = noteInput(); await f.service.addNote(f.owner, "1", input);
  await assert.rejects(() => f.service.addNote(f.owner, "1", { ...input, content: "different" }), code(409));
  await assert.rejects(() => f.service.addNote(f.broad, "1", input), code(409));
  await assert.rejects(() => f.service.changeStage(f.owner, "1", { operationId: input.operationId, expectedVersion: 1, stage: "Site Visit" }), code(409));
  assert.equal(f.mock.calls.length, 1);
});
test("concurrent operations reserve one task and local edits during remote waits are not overwritten", async (t) => {
  const f = await fixture(t); let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; }), block = new Promise<void>((resolve) => { release = resolve; });
  const service = createLeadMutationsService(f.db, { now: () => NOW, transport: { async request() { entered(); await block; return ok("800000000000001"); } } });
  const input = noteInput(), pending = service.addNote(f.owner, "1", input); await started;
  await assert.rejects(() => service.addNote(f.owner, "1", noteInput()), code(409));
  f.db.prepare("UPDATE tasks SET version=version+1,Admin_Remarks='Concurrent synthetic job edit' WHERE id=1").run();
  release(); await assert.rejects(pending, code(409));
  assert.equal(count(f.db, "job_notes"), 0); assert.equal(state(f.db, input.operationId)?.state, "reconciliation");
  assert.equal((f.db.prepare("SELECT Admin_Remarks FROM tasks WHERE id=1").get() as { Admin_Remarks: string }).Admin_Remarks, "Concurrent synthetic job edit");
});
test("revoked grants and sessions are rechecked after remote success and before committing local data", async (t) => {
  for (const revoke of ["grant", "logout"] as const) {
    const f = await fixture(t), input = noteInput();
    const service = createLeadMutationsService(f.db, { now: () => NOW, transport: { async request() {
      if (revoke === "grant") f.db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=1").run(); else f.auth.logout(f.owner);
      return ok("800000000000001");
    } } });
    await assert.rejects(() => service.addNote(f.owner, "1", input), code(revoke === "grant" ? 403 : 401));
    assert.equal(state(f.db, input.operationId)?.remote_id, "800000000000001"); assert.equal(state(f.db, input.operationId)?.state, "reconciliation");
    assert.equal(count(f.db, "job_notes"), 0);
  }
});
test("audit failure rolls back all local writes while preserving remote receipt for reconciliation", async (t) => {
  const f = await fixture(t), input = noteInput();
  f.db.exec("CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON crm_lead_audit_events BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  await assert.rejects(() => f.service.addNote(f.owner, "1", input), code(503));
  assert.equal(count(f.db, "job_notes"), 0); assert.equal((f.db.prepare("SELECT version FROM tasks WHERE id=1").get() as { version: number }).version, 1);
  assert.equal(state(f.db, input.operationId)?.state, "reconciliation"); assert.ok(state(f.db, input.operationId)?.remote_id);
});
test("stage polling is bounded, validates record identity and never persists unconfirmed status", async (t) => {
  for (const mode of ["not-ready", "wrong-id", "invalid-date"] as const) {
    const f = await fixture(t), input = stageInput(); let reads = 0, waits = 0;
    const service = createLeadMutationsService(f.db, { now: () => NOW, wait: async () => { waits++; }, transport: { async request(req) {
      if (req.method === "PUT") return ok("700000000000001"); reads++;
      return { status: 200, body: { data: [{ id: mode === "wrong-id" ? "999" : "700000000000001", Stage: mode === "not-ready" ? "Pending" : "Site Visit",
        DealNumber: "SYNTHETIC-D", SiteDealNumber: "SYNTHETIC-S", Site_Deal_Date: mode === "invalid-date" ? "yesterday" : undefined }] } };
    } } });
    await assert.rejects(() => service.changeStage(f.owner, "1", input), code(503));
    assert.equal(reads, mode === "not-ready" ? 12 : 1); assert.equal(waits, mode === "not-ready" ? 11 : 0);
    assert.equal((f.db.prepare("SELECT status FROM tasks WHERE id=1").get() as { status: string }).status, "Pending");
    assert.equal(count(f.db, "tasks_status_log"), 0);
  }
});
test("malformed remote acknowledgements are never accepted as successful note persistence", async (t) => {
  for (const response of [{ status: 200, body: { data: [{ details: { id: "123" } }] } }, { status: 401, body: { secret: "remote secret" } },
    { status: 200, body: { data: [{ code: "SUCCESS", status: "success", details: { id: "../../private" } }] } }]) {
    const f = await fixture(t), input = noteInput();
    const service = createLeadMutationsService(f.db, { now: () => NOW, transport: { async request() { return response; } } });
    await assert.rejects(() => service.addNote(f.owner, "1", input), code(503));
    assert.equal(count(f.db, "job_notes"), 0); assert.equal(state(f.db, input.operationId)?.state, "reconciliation");
  }
});

const dealInput = () => ({ operationId: randomUUID(), firstName: "Synthetic", lastName: "Customer", companyName: "Synthetic CRM test company",
  email: "synthetic-customer@example.invalid", mobile: "+000000", phone: "+000001", department: "VOLTRONIX CONTRACTING LLC", address: "Synthetic test only address" });
function creationTransport(db: Database.Database, existingAccount = false) {
  const calls: ZohoRequest[] = [];
  const transport: ZohoTransport = { async request(req) {
    assert.equal(db.inTransaction, false); calls.push(req);
    if (req.path.startsWith("/Accounts/search?")) return existingAccount ? { status: 200, body: { data: [{ id: "111", Account_Name: "Synthetic CRM test company" }] } } : { status: 204, body: undefined };
    if (req.method === "POST") return ok(req.path === "/Accounts" ? "111" : req.path === "/Contacts" ? "222" : "333");
    return { status: 200, body: { data: [{ id: "333", Deal_Name: "Synthetic Customer", Stage: "Qualification", DealNumber: "SYNTHETIC-DEAL-333",
      Account_Name: { name: "Synthetic CRM test company" }, Contact_Name: { name: "Synthetic Customer" }, Email: "synthetic-customer@example.invalid",
      Phone: "+000001", Description: "Synthetic CRM fixture", Owner: { id: "444" } }] } };
  } };
  return { calls, transport };
}
test("deal creation requires explicit external actor and integration owner configuration without default identities", async (t) => {
  const f = await fixture(t), input = dealInput();
  await assert.rejects(() => f.service.createDeal(f.localCreator, input), code(403));
  await assert.rejects(() => f.service.createDeal(f.owner, input), code(503));
  await assert.rejects(() => f.service.createDeal(f.owner, { ...input, unknown: "field" }), code(400));
  await assert.rejects(() => f.service.createDeal(f.owner, { ...input, email: "invalid" }), code(400));
  await assert.rejects(() => f.service.createDeal(f.owner, { ...input, companyName: "Injected):or:(field" }), code(400));
  assert.equal(f.mock.calls.length, 0); assert.equal(count(f.db, "crm_lead_operations"), 0);
});
test("deal creation performs account/contact/deal sequence, source mapping and exactly-once local persistence", async (t) => {
  for (const existingAccount of [false, true]) {
    const f = await fixture(t), mock = creationTransport(f.db, existingAccount), input = dealInput();
    const service = createLeadMutationsService(f.db, { now: () => NOW, transport: mock.transport, accountOwnerId: "555", wait: async () => {} });
    const result = await service.createDeal(f.owner, input); assert.equal(result.version, 1);
    assert.deepEqual(await service.createDeal(f.owner, input), result);
    assert.deepEqual(mock.calls.filter((r) => r.method === "POST").map((r) => r.path), existingAccount ? ["/Contacts", "/Deals"] : ["/Accounts", "/Contacts", "/Deals"]);
    assert.deepEqual(f.db.prepare("SELECT zoho_crm_id,status,assigned_to,deal_crm_created_by,version FROM tasks WHERE id=?").get(result.taskId), {
      zoho_crm_id: "333", status: "Pending", assigned_to: "900000000000001", deal_crm_created_by: 1, version: 1 });
    assert.equal(count(f.db, "tasks"), 3); assert.equal(count(f.db, "crm_lead_audit_events"), 1);
    assert.deepEqual(JSON.parse(state(f.db, input.operationId)!.remote_references), { accountId: "111", contactId: "222", dealId: "333" });
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  }
});
test("partial deal creation retains known remote IDs, blocks automatic duplicate creates and writes no local fiction", async (t) => {
  const f = await fixture(t), mock = creationTransport(f.db), input = dealInput(); let calls = 0;
  const service = createLeadMutationsService(f.db, { now: () => NOW, accountOwnerId: "555", transport: { async request(req) {
    calls++; if (req.path === "/Deals" && req.method === "POST") throw new Error("remote connection lost"); return mock.transport.request(req);
  } } });
  await assert.rejects(() => service.createDeal(f.owner, input), code(503));
  assert.deepEqual(JSON.parse(state(f.db, input.operationId)!.remote_references), { accountId: "111", contactId: "222" });
  assert.equal(state(f.db, input.operationId)?.state, "reconciliation");
  await assert.rejects(() => service.createDeal(f.owner, input), code(409));
  await assert.rejects(() => service.createDeal(f.owner, dealInput()), code(409));
  assert.equal(calls, 4); assert.equal(count(f.db, "tasks"), 2); assert.equal(count(f.db, "crm_lead_audit_events"), 0);
});
test("deal creation refuses revoked permissions after remote acknowledgement", async (t) => {
  const f = await fixture(t), mock = creationTransport(f.db), input = dealInput();
  const service = createLeadMutationsService(f.db, { now: () => NOW, accountOwnerId: "555", transport: { async request(req) {
    const response = await mock.transport.request(req);
    if (req.method === "GET" && req.path === "/Deals/333") f.db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=1").run();
    return response;
  } } });
  await assert.rejects(() => service.createDeal(f.owner, input), code(403));
  assert.equal(count(f.db, "tasks"), 2); assert.equal(state(f.db, input.operationId)?.remote_id, "333");
});
test("operation journal survives connection restart and prevents repeating an uncertain remote effect", async () => {
  const fixture = filesystemFixture(); let db = openDatabase(fixture.config, { create: true });
  try {
    migrateDatabase(db); const f = await populate(db), input = noteInput();
    const failing = createLeadMutationsService(db, { now: () => NOW, transport: { async request() { throw new Error("synthetic timeout"); } } });
    await assert.rejects(() => failing.addNote(f.owner, "1", input), code(503)); db.close();
    db = openDatabase(fixture.config); let calls = 0;
    const afterRestart = createLeadMutationsService(db, { now: () => NOW, transport: { async request() { calls++; return ok("999"); } } });
    await assert.rejects(() => afterRestart.addNote(f.owner, "1", input), code(409)); assert.equal(calls, 0);
    assert.equal(state(db, input.operationId)?.state, "reconciliation"); assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally { db.close(); fixture.cleanup(); }
});
