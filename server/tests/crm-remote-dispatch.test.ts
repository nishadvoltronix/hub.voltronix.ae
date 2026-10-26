import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { MysqlDatabase } from "../src/crm/db/mysql/database.js";
import type { MysqlWireConnection } from "../src/crm/db/mysql/driver.js";
import { createCrmServices } from "../src/crm/router.js";
import { LeadMutationError } from "../src/crm/lead-mutations/service.js";
import { CommercialPersistenceError } from "../src/crm/commercial/service.js";
import { LocalWorkflowError } from "../src/crm/local-workflow/service.js";
import type { ZohoRequest, ZohoTransport } from "../src/crm/lead-mutations/contracts.js";
import type { CommercialRequest, CommercialTransport } from "../src/crm/commercial/transport.js";

// In-memory wire/transaction model only. No sockets, credentials, environment
// files or real schema are used; this does not certify actual MySQL isolation.
type Row = Record<string, unknown>;
type State = { tables: Record<string, Row[]>; local: boolean; provenance: boolean; nextId: number };
const token = "a".repeat(43);
const rows = (value: unknown[]): [unknown, unknown] => [value, []];
const changed = (count = 1, id = 0): [unknown, unknown] => [{ affectedRows: count, insertId: id }, []];
const ok = (id: string) => ({ status: 200, body: { data: [{ code: "SUCCESS", status: "success", details: { id } }] } });
const taskRow = { id: "1", zoho_crm_id: "201", assigned_to: "101", status: "Pending", version: 1, quote_number: null, quote_id: null };
const deal = { firstName: "Synthetic", lastName: "Contact", companyName: "Synthetic company", email: "synthetic@example.invalid",
  phone: "000", mobile: "001", department: "VOLTRONIX CONTRACTING LLC" };
const quotation = { subject: "Synthetic quote", kindAttention: "Synthetic contact", discountType: "percentage", discount: "0", adjustment: "0",
  items: [{ productId: "301", productName: "Synthetic product", description: "Synthetic description", uom: "NOS", quantity: "1", unitPrice: "10", itemDiscount: "0" }] };

function fixture() {
  let state: State = { tables: { tasks: [{ ...taskRow }], products: [{ product_id: "301", product_name: "Synthetic product" }],
    job_notes: [{ id: "9", deal_id: "201", zoho_note_id: "209", note_title: "Old title", note_content: "Old content" }] },
    local: false, provenance: false, nextId: 10 };
  const grants = ["leads.view", "leads.manage", "items.write", "deals.manage"];
  const calls: { sql: string; values: readonly unknown[]; connection: number; transactional: boolean }[] = [];
  const events: { event: string; connection: number }[] = [];
  const unhandled: string[] = [];
  const active = new Set<number>();
  let connectionId = 0, failAudit = false, bound = true;
  const table = (value: State, name: string) => value.tables[name] ??= [];
  function execute(value: State, sql: string, params: readonly unknown[]): [unknown, unknown] {
    if (sql.includes("FROM crm_sessions s JOIN users")) return rows([{ local_id: "1", user_id: "101", username: "Synthetic owner",
      email: "owner@example.invalid", password: "synthetic-password", status: "active", expires_at: Number.MAX_SAFE_INTEGER,
      password_fingerprint: createHash("sha256").update("synthetic-password").digest("hex"), csrf_hash: "unused" }]);
    if (sql.startsWith("SELECT 1 FROM crm_zoho_user_bindings binding")) return rows([]);
    if (sql.startsWith("SELECT p.`key`")) return rows(grants.map(key => ({ key })));
    if (sql.startsWith("SELECT origin,state,last_synced_at,source_modified_at,external_id FROM (")
      || sql.startsWith("SELECT 1 FROM crm_zoho_sync_records WHERE organization_id=?")
      || sql === "SELECT 1 FROM crm_zoho_sync_records WHERE module_api_name='Products' AND external_id=? AND state!='active' LIMIT 1") return rows([]);
    if (sql.includes("FROM crm_zoho_user_bindings b JOIN users")) return rows(bound ? [{ organizationId: "3001", moduleName: "VZ_app_users",
      externalId: "101", currentExternalId: "101", status: "active", boundEmail: "owner@example.invalid", currentEmail: "owner@example.invalid" }] : []);
    if (sql === "SELECT 1 FROM crm_local_tasks WHERE task_id=?") return rows(value.local ? [{ present: 1 }] : []);
    if (sql.includes("FROM crm_local_tasks l JOIN tasks")) return rows(value.provenance ? [{ id: "1", ownerId: "1", status: "Pending", version: 1, quoteNumber: null }] : []);
    if (sql.startsWith("SELECT assigned_to FROM tasks")) return rows(table(value, "tasks").filter(row => row.id === params[0]).map(row => ({ assigned_to: row.assigned_to })));
    if (sql.startsWith("SELECT CAST(id AS CHAR) id,zoho_crm_id externalId")) return rows(table(value, "tasks").filter(row => row.id === params[0]).map(row => ({
      id: row.id, externalId: row.zoho_crm_id, assignedTo: row.assigned_to, status: row.status, version: row.version,
      quoteId: row.quote_number, quoteNumber: row.quote_number, quoteExternalId: row.quote_id })));
    if (sql.includes("FROM departments_assign")) return rows([]);
    if (sql.includes("FROM crm_quotations") || sql.includes("FROM crm_zoho_quotations")) return rows([]);
    if (sql.includes("FROM job_notes WHERE")) return rows(table(value, "job_notes").filter(row => row.id === params[0] && row.deal_id === params[1])
      .map(row => ({ id: row.id, externalId: row.zoho_note_id, title: row.note_title, content: row.note_content })));
    if (sql.startsWith("SELECT") && sql.includes("crm_lead_operations") && sql.includes("UNION ALL")) {
      return rows([...table(value, "crm_lead_operations"), ...table(value, "crm_commercial_operations")]
        .filter(row => row.task_id === params[0] && row.state !== "completed").slice(0, 1));
    }
    if (sql.startsWith("SELECT") && /FROM crm_(lead|commercial)_operations/.test(sql)) {
      const name = /FROM (crm_\w+_operations)/.exec(sql)![1]!;
      const found = table(value, name).filter(row => sql.includes("WHERE operation_id=?") ? row.operation_id === params[0]
        : row.actor_user_id === params[0] && row.state !== "completed");
      return rows(found.map(row => ({ ...row, actor: row.actor_user_id, taskId: row.task_id })));
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM products")) return rows(table(value, "products").filter(row => row.product_id === params[0]));
    if (sql.startsWith("INSERT INTO")) {
      const parsed = /^INSERT INTO (\w+)\(([^)]+)\) VALUES\((.+)\)$/.exec(sql);
      assert.ok(parsed, sql);
      const name = parsed[1]!, columns = parsed[2]!.split(","), expressions = parsed[3]!.split(",");
      if (failAudit && name.endsWith("audit_events")) throw new Error("Synthetic private audit failure");
      const row: Row = {}; let index = 0;
      for (const [i, column] of columns.entries()) {
        const expression = expressions[i]!.trim();
        row[column.trim()] = expression === "?" ? params[index++] : expression.startsWith("'") ? expression.slice(1, -1) : Number(expression);
      }
      assert.equal(index, params.length);
      if (name.endsWith("_operations")) Object.assign(row, { task_id: row.task_id ?? null, remote_effect_possible: 0, remote_references: "{}", result_json: null });
      else row.id = String(value.nextId++);
      table(value, name).push(row); return changed(1, Number(row.id ?? 0));
    }
    if (sql.startsWith("UPDATE crm_lead_operations") || sql.startsWith("UPDATE crm_commercial_operations")) {
      const name = /^UPDATE (\w+)/.exec(sql)![1]!;
      const row = table(value, name).find(entry => entry.operation_id === params.at(-1) && entry.state === "inflight");
      if (!row) return changed(0);
      if (sql.includes("remote_effect_possible=1")) row.remote_effect_possible = 1;
      else if (sql.includes("remote_references=json_set")) {
        const lead = name === "crm_lead_operations", key = String(params[lead ? 1 : 0]).slice(2);
        row.remote_references = JSON.stringify({ ...JSON.parse(String(row.remote_references)), [key]: params[lead ? 2 : 1] });
        if (lead) row.remote_id = params[0];
      } else if (sql.includes("state='reconciliation'")) row.state = "reconciliation";
      else if (sql.includes("state='completed'")) {
        row.state = "completed";
        if (name === "crm_commercial_operations") row.result_json = params[0];
        else Object.assign(row, { result_task_id: params[0], result_note_id: params[1], result_version: params[2] });
      } else assert.fail(sql);
      return changed();
    }
    if (sql === "UPDATE tasks SET version=version+1,updated_at=? WHERE id=? AND version=?") {
      const row = table(value, "tasks").find(entry => entry.id === params[1] && entry.version === params[2]);
      if (!row) return changed(0); row.version = Number(row.version) + 1; return changed();
    }
    unhandled.push(sql); throw new Error("Unhandled synthetic SQL");
  }
  const db = new MysqlDatabase({ provider: "mysql", environment: "test", host: "127.0.0.1", port: 3308,
    database: "crm_test_remote_dispatch", user: "synthetic", password: "synthetic-only" }, {
    verify: async () => {}, connect: async (): Promise<MysqlWireConnection> => {
      const connection = ++connectionId;
      let transaction: State | undefined;
      const savepoints = new Map<string, State>();
      const event = (event: string) => { events.push({ event, connection }); };
      return {
        async execute(rawSql, values = []) {
          const sql = rawSql.replace(/\s+/g, " ").trim();
          calls.push({ sql, values, connection, transactional: transaction !== undefined });
          if (sql === "SELECT id FROM crm_app_lock WHERE id=1 FOR UPDATE") { assert.ok(transaction); return rows([{ id: 1 }]); }
          return execute(transaction ?? state, sql, values);
        },
        async query(sql) {
          if (sql.startsWith("SET SESSION")) return rows([]);
          assert.ok(transaction); event(sql);
          if (sql.startsWith("SAVEPOINT ")) savepoints.set(sql.slice(10), structuredClone(transaction));
          else if (sql.startsWith("ROLLBACK TO SAVEPOINT ")) transaction = structuredClone(savepoints.get(sql.slice(22))!);
          else if (sql.startsWith("RELEASE SAVEPOINT ")) savepoints.delete(sql.slice(18));
          else assert.fail(sql);
          return rows([]);
        },
        async beginTransaction() { assert.equal(transaction, undefined); transaction = structuredClone(state); active.add(connection); event("BEGIN"); },
        async commit() { assert.ok(transaction); state = transaction; transaction = undefined; active.delete(connection); event("COMMIT"); },
        async rollback() { transaction = undefined; active.delete(connection); event("ROLLBACK"); },
        async end() { assert.equal(transaction, undefined); event("END"); },
        destroy() { transaction = undefined; active.delete(connection); event("DESTROY"); },
      };
    },
  });
  return { db, grants, calls, events, unhandled, state: () => state, failAudit: () => { failAudit = true; }, revokeBinding: () => { bound = false; },
    networkBoundary() { assert.equal(db.inTransaction, false); assert.equal(active.size, 0, "no routing or reservation transaction may span remote I/O"); },
    operation(id: string) { return [...table(state, "crm_lead_operations"), ...table(state, "crm_commercial_operations")].find(row => row.operation_id === id); },
    assertReserved(id: string) {
      const operation = this.operation(id); assert.ok(operation, "reservation must already be committed, not merely staged");
      assert.equal(operation.state, "inflight");
    },
  };
}
function services(f: ReturnType<typeof fixture>, request: (request: ZohoRequest | CommercialRequest) => Promise<{ status: number; body: unknown }>) {
  const leads: ZohoTransport = { request }, commercial: CommercialTransport = { request };
  return createCrmServices(f.db, { integration: { leads, commercial, accountOwnerId: "501" } });
}
const leadFailure = (status: number) => (error: unknown) => error instanceof LeadMutationError && error.status === status;

function nativeServices(f: ReturnType<typeof fixture>, request: (request: ZohoRequest | CommercialRequest) => Promise<{ status: number; body: unknown }>) {
  return createCrmServices(f.db, { integration: { leads: { request }, commercial: { request }, accountOwnerId: "501",
    accountPayloadProfile: "standard-account-contact-email-v1", dealPayloadProfile: "legacy-conversion-fields-v1",
    stagePayloadProfile: "voltronix-stage-reference-values-v1", dealPipeline: "Synthetic pipeline", production: { organizationId: "3001", dealLayoutId: "6001",
      quotationProfile: "voltronix-custom-quoted-items-v8", numberingProfile: "voltronix-hub-local-references-v1" } } });
}

test("OFFLINE native writes require the current organization-bound custom-user binding", async t => {
  const f = fixture(); t.after(() => f.db.close()); f.revokeBinding();
  const service = nativeServices(f, async () => assert.fail("unbound actor must not reach provider"));
  const caps = await service.localWrites.capabilities(token);
  assert.equal(caps.persistence, "zoho"); assert.equal(caps.productCreate, false); assert.equal(caps.dealCreate, false);
  assert.equal((await service.mutations.capabilities(token, "1")).canChangeStage, false);
  await assert.rejects(service.mutations.createDeal(token, { operationId: randomUUID(), ...deal, closingDate: "2026-11-01" }), leadFailure(403));
  await assert.rejects(service.commercial.createProduct(token, { operationId: randomUUID(), name: "Synthetic", description: "" }),
    (error: unknown) => error instanceof CommercialPersistenceError && error.status === 403);
  assert.equal(f.calls.some(call => call.sql.startsWith("INSERT")), false); assert.deepEqual(f.unhandled, []);
});

test("OFFLINE native deal rejects common mapped field overflow before reservation or any provider request", async t => {
  const f = fixture(); t.after(() => f.db.close());
  const service = nativeServices(f, async () => assert.fail("invalid native input must not reach provider"));
  for (const patch of [{ firstName: 'x'.repeat(41) }, { lastName: 'x'.repeat(81) }, { firstName: 'x'.repeat(40), lastName: 'x'.repeat(80) },
    { email: 'x'.repeat(90) + '@example.invalid' }, { phone: '0'.repeat(31) }, { mobile: '0'.repeat(31) }, { address: 'x'.repeat(251) }]) {
    await assert.rejects(service.mutations.createDeal(token, { operationId: randomUUID(), ...deal, closingDate: "2026-11-01", ...patch }), leadFailure(400));
  }
  assert.equal(f.calls.some(call => call.sql.startsWith('INSERT')), false); assert.deepEqual(f.unhandled, []);
});

test("OFFLINE native deal requires an explicit valid closing date before reservation or any provider request", async t => {
  const f = fixture(); t.after(() => f.db.close());
  const service = nativeServices(f, async () => assert.fail("invalid closing date must not reach provider"));
  for (const date of [undefined, "", "2026-02-30", "19/10/2026", "2026-10-19T12:00:00Z"]) {
    await assert.rejects(service.mutations.createDeal(token, { operationId: randomUUID(), ...deal,
      ...(date === undefined ? {} : { closingDate: date }) }), (error: unknown) => error instanceof Error && "status" in error && error.status === 400);
  }
  assert.equal(f.calls.some(call => call.sql.startsWith("INSERT")), false); assert.deepEqual(f.unhandled, []);
});

test("OFFLINE native deal transmits the explicit closing date and refuses changed readback before qualification update", async t => {
  const f = fixture(); t.after(() => f.db.close()); const operationId = randomUUID(); const closingDate = "2026-11-01";
  const requests: ZohoRequest[] = [];
  const service = nativeServices(f, async request => {
    f.networkBoundary(); requests.push(request);
    if (request.path.startsWith("/Accounts/search?")) return { status: 200, body: { data: [{ id: "601", Account_Name: deal.companyName }], info: { more_records: false } } };
    if (request.path === "/Accounts/601") return { status: 200, body: { data: [{ id: "601", Account_Name: deal.companyName }] } };
    if (request.path === "/Contacts") return ok("701");
    if (request.path === "/Contacts/701") return { status: 200, body: { data: [{ id: "701", First_Name: deal.firstName, Last_Name: deal.lastName,
      Email: deal.email, Account_Name: { id: "601" } }] } };
    const payload = { Deal_Name: `${deal.firstName} ${deal.lastName}`, Stage: "Qualification", VZ_App_Status: "Pending", Pipeline: "Synthetic pipeline",
      Account_Name: { id: "601" }, Contact_Name: { id: "701" }, VZ_app_user: { id: "101" }, Email: deal.email,
      $layout_id: { id: "6001" }, Assign_Department1: deal.department, Modified_Time: "2026-10-19T12:00:00+04:00" };
    if (request.path === "/Deals") {
      assert.equal(request.method, "POST"); const row = (request.body as { data: Row[] }).data[0]!;
      assert.equal(row.Closing_Date, closingDate); assert.deepEqual(row.Layout, { id: "6001" }); return ok("801");
    }
    assert.equal(request.path, "/Deals/801"); assert.equal(request.method, "GET");
    return { status: 200, body: { data: [{ ...payload, id: "801", DealNumber: "VTNX-123", Closing_Date: "2026-11-02" }] } };
  });
  await assert.rejects(service.mutations.createDeal(token, { operationId, ...deal, closingDate }), leadFailure(503));
  assert.equal(requests.length, 6); assert.equal(requests.some(request => request.method === "PUT"), false);
  assert.equal(f.operation(operationId)?.state, "reconciliation"); assert.deepEqual(f.unhandled, []);
});

test("OFFLINE native site stage never writes Hub references into remote legacy counter fields", async t => {
  const f = fixture(); t.after(() => f.db.close()); const operationId = randomUUID(); let requests = 0;
  const service = nativeServices(f, async request => {
    f.networkBoundary(); requests++;
    if (request.method === 'GET') return { status: 200, body: { data: [{ id: '201', VZ_app_user: { id: '101' },
      Modified_Time: '2026-10-19T12:00:00+04:00', $layout_id: { id: '6001' }, Pipeline: 'Synthetic pipeline', Stage: 'Qualification', VZ_App_Status: 'Pending', SiteDealNumber: null }] } };
    assert.equal(request.method, 'PUT');
    assert.deepEqual(request.body, { data: [{ Stage: 'Site Visit', VZ_App_Status: 'Site Visit' }] });
    assert.equal(request.ifUnmodifiedSince, '2026-10-19T12:00:00+04:00');
    throw new Error('Synthetic stop after inspecting outbound stage fields');
  });
  await assert.rejects(service.mutations.changeStage(token, '1', { operationId, expectedVersion: 1, stage: 'Site Visit' }), leadFailure(503));
  assert.equal(requests, 2); assert.deepEqual(f.unhandled, []);
});

test("OFFLINE native account search rejects incomplete absence or singleton evidence before creating records", async t => {
  for (const data of [[], [{ id: "601", Account_Name: deal.companyName }]]) {
    const f = fixture(); t.after(() => f.db.close()); const operationId = randomUUID(); let requests = 0;
    const service = nativeServices(f, async request => {
      f.networkBoundary(); requests++; assert.equal(request.method, "GET"); assert.match(request.path, /^\/Accounts\/search\?/);
      return { status: 200, body: { data } };
    });
    await assert.rejects(service.mutations.createDeal(token, { operationId, ...deal, closingDate: "2026-11-01" }), leadFailure(503));
    assert.equal(requests, 1); assert.equal(f.operation(operationId)?.remote_effect_possible, 0); assert.deepEqual(f.unhandled, []);
  }
});

test("OFFLINE native account acknowledgement is durable before its verification readback", async t => {
  const f = fixture(); t.after(() => f.db.close()); const operationId = randomUUID();
  const service = nativeServices(f, async request => {
    f.networkBoundary(); f.assertReserved(operationId);
    if (request.path.startsWith("/Accounts/search?")) return { status: 204, body: null };
    if (request.path === "/Accounts" && request.method === "POST") return ok("601");
    assert.equal(request.path, "/Accounts/601"); assert.equal(request.method, "GET");
    assert.equal(f.operation(operationId)?.remote_references, '{"accountId":"601"}');
    throw new Error("Synthetic account verification failure");
  });
  await assert.rejects(service.mutations.createDeal(token, { operationId, ...deal, closingDate: "2026-11-01" }), leadFailure(503));
  assert.equal(f.operation(operationId)?.state, "reconciliation");
  assert.equal(f.operation(operationId)?.remote_references, '{"accountId":"601"}'); assert.deepEqual(f.unhandled, []);
});

test("OFFLINE native reused Account is directly verified before any Contact write", async t => {
  const f = fixture(); t.after(() => f.db.close()); const operationId = randomUUID(); const paths: string[] = [];
  const service = nativeServices(f, async request => {
    f.networkBoundary(); paths.push(request.path); assert.equal(request.method, "GET");
    if (request.path.startsWith("/Accounts/search?")) return { status: 200, body: { data: [{ id: "601", Account_Name: deal.companyName }], info: { more_records: false } } };
    assert.equal(request.path, "/Accounts/601"); return { status: 200, body: { data: [{ id: "601", Account_Name: "Changed account" }] } };
  });
  await assert.rejects(service.mutations.createDeal(token, { operationId, ...deal, closingDate: "2026-11-01" }), leadFailure(503));
  assert.equal(paths.length, 2); assert.equal(f.operation(operationId)?.remote_effect_possible, 0); assert.deepEqual(f.unhandled, []);
});

for (const scenario of ["binding-revoked", "stage-changed"] as const) test(`OFFLINE native stage rechecks ${scenario} after remote preflight and never sends stale mutation`, async t => {
  const f = fixture(); t.after(() => f.db.close()); const operationId = randomUUID(); let requests = 0;
  const service = nativeServices(f, async request => {
    f.networkBoundary(); requests++; assert.equal(request.method, "GET"); assert.equal(request.path, "/Deals/201");
    if (scenario === "binding-revoked") f.revokeBinding();
    return { status: 200, body: { data: [{ id: "201", VZ_app_user: { id: "101" }, $layout_id: { id: '6001' }, Modified_Time: "2026-10-19T12:00:00+04:00",
      Pipeline: "Synthetic pipeline", Stage: scenario === "stage-changed" ? "Closed Won" : "Qualification", VZ_App_Status: "Pending" }] } };
  });
  await assert.rejects(service.mutations.changeStage(token, "1", { operationId, expectedVersion: 1, stage: "Site Visit" }),
    leadFailure(scenario === "binding-revoked" ? 403 : 409));
  assert.equal(requests, 1); assert.equal(f.operation(operationId)?.remote_effect_possible, 0); assert.deepEqual(f.unhandled, []);
});

test("OFFLINE explicit pipeline reaches the deal request through actual CRM composition", async t => {
  const f = fixture(); t.after(() => f.db.close()); const operationId = randomUUID(); let requests = 0;
  const request = async (request: ZohoRequest | CommercialRequest) => {
    f.networkBoundary(); f.assertReserved(operationId); requests++;
    if (request.method === "GET") return { status: 200, body: { data: [{ id: "601", Account_Name: deal.companyName }] } };
    if (request.path === "/Contacts") return ok("701");
    assert.equal(request.path, "/Deals");
    assert.equal((request.body as { data: Row[] }).data[0]!.Pipeline, "Synthetic pipeline");
    throw new Error("Synthetic outbound stop");
  };
  const service = createCrmServices(f.db, { integration: { leads: { request }, commercial: { request }, accountOwnerId: "501", dealPipeline: "Synthetic pipeline" } });
  await assert.rejects(service.mutations.createDeal(token, { operationId, ...deal }), leadFailure(503));
  assert.equal(requests, 3); assert.equal(f.operation(operationId)?.state, "reconciliation"); assert.deepEqual(f.unhandled, []);
});

test("OFFLINE explicit account profile travels from CRM composition to the actual account write", async t => {
  const f = fixture(); t.after(() => f.db.close()); const operationId = randomUUID(); let requests = 0;
  const request = async (request: ZohoRequest | CommercialRequest) => {
    f.networkBoundary(); f.assertReserved(operationId); requests++;
    if (request.method === "GET") return { status: 204, body: null };
    assert.equal(request.path, "/Accounts");
    assert.deepEqual(request.body, { data: [{ Account_Name: deal.companyName, Phone: deal.phone, Owner: { id: "501" } }] });
    throw new Error("Synthetic outbound stop");
  };
  const service = createCrmServices(f.db, { integration: { leads: { request }, commercial: { request }, accountOwnerId: "501",
    accountPayloadProfile: "standard-account-contact-email-v1" } });
  await assert.rejects(service.mutations.createDeal(token, { operationId, ...deal }), leadFailure(503));
  assert.equal(requests, 2); assert.equal(f.operation(operationId)?.state, "reconciliation");
  assert.equal(f.state().tables.tasks!.length, 1); assert.deepEqual(f.unhandled, []);
});

for (const kind of ["stage", "note.create", "note.edit"] as const) {
  test(`OFFLINE remote ${kind} dispatch commits reservation before I/O and retains reconciliation after failure`, async t => {
    const f = fixture(); t.after(() => f.db.close());
    const operationId = randomUUID(); let requests = 0;
    const service = services(f, async request => {
      f.networkBoundary(); f.assertReserved(operationId); requests++;
      assert.equal(f.operation(operationId)?.remote_effect_possible, 1);
      assert.equal(request.path, kind === "stage" ? "/Deals/201" : kind === "note.create" ? "/Deals/201/Notes" : "/Notes/209");
      throw new Error("private remote response");
    });
    const invoke = () => kind === "stage" ? service.mutations.changeStage(token, "1", { operationId, expectedVersion: 1, stage: "Site Visit" })
      : kind === "note.create" ? service.mutations.addNote(token, "1", { operationId, expectedVersion: 1, title: "Synthetic title", content: "Synthetic content" })
        : service.mutations.editNote(token, "1", "9", { operationId, expectedVersion: 1, content: "Synthetic edit" });
    await assert.rejects(invoke(), leadFailure(503));
    assert.equal(f.operation(operationId)?.state, "reconciliation");
    assert.equal(f.state().tables.tasks![0]!.version, 1);
    await assert.rejects(invoke(), leadFailure(409));
    assert.equal(requests, 1); assert.deepEqual(f.unhandled, []);
  });
}

test("OFFLINE remote acknowledgement survives a failed local note/audit transaction", async t => {
  const f = fixture(); t.after(() => f.db.close()); f.failAudit();
  const operationId = randomUUID();
  const service = services(f, async () => { f.networkBoundary(); f.assertReserved(operationId); return ok("210"); });
  await assert.rejects(service.mutations.addNote(token, "1", { operationId, expectedVersion: 1, title: "Synthetic", content: "Synthetic" }), leadFailure(503));
  assert.equal(f.state().tables.job_notes!.length, 1, "new business note was rolled back");
  assert.equal(f.state().tables.tasks![0]!.version, 1);
  assert.equal(f.operation(operationId)?.state, "reconciliation");
  assert.equal(f.operation(operationId)?.remote_id, "210");
  assert.equal(f.operation(operationId)?.remote_references, '{"noteId":"210"}');
  assert.ok(f.events.some(event => event.event === "ROLLBACK")); assert.deepEqual(f.unhandled, []);
});

test("OFFLINE supplied integration selects remote product creation and preserves completed replay", async t => {
  const f = fixture(); t.after(() => f.db.close()); const operationId = randomUUID(); let requests = 0;
  const service = services(f, async request => {
    f.networkBoundary(); f.assertReserved(operationId); requests++;
    assert.equal(request.method, "POST"); assert.equal(request.path, "/Products");
    assert.equal("apiVersion" in request && request.apiVersion, "v2.1"); return ok("302");
  });
  const input = { operationId, name: "New synthetic product", description: "Synthetic description" };
  const result = await service.commercial.createProduct(token, input);
  assert.equal(result.productId, "302"); assert.equal("persistence" in result, false);
  assert.deepEqual(await service.commercial.createProduct(token, input), result);
  assert.equal(requests, 1); assert.equal(f.operation(operationId)?.state, "completed");
  assert.equal(f.operation(operationId)?.remote_effect_possible, 1); assert.deepEqual(f.unhandled, []);
});

test("OFFLINE supplied integration selects remote deal creation and passes the explicit account owner", async t => {
  const f = fixture(); t.after(() => f.db.close()); const operationId = randomUUID(); const paths: string[] = [];
  const service = services(f, async request => {
    f.networkBoundary(); f.assertReserved(operationId); paths.push(request.path);
    if (request.method === "GET") { assert.match(request.path, /^\/Accounts\/search\?/); return { status: 204, body: null }; }
    assert.equal(request.path, "/Accounts");
    assert.deepEqual((request.body as { data: { Owner: unknown }[] }).data[0]!.Owner, { id: "501" });
    throw new Error("Synthetic remote failure");
  });
  await assert.rejects(service.mutations.createDeal(token, { operationId, ...deal }), leadFailure(503));
  assert.equal(paths.length, 2); assert.equal(f.operation(operationId)?.state, "reconciliation");
  assert.equal(f.state().tables.tasks!.length, 1); assert.deepEqual(f.unhandled, []);
});

test("OFFLINE per-lead integration capabilities still enforce fresh grants and ownership", async t => {
  const f = fixture(); t.after(() => f.db.close());
  const service = services(f, async () => assert.fail("capabilities never call the transport"));
  assert.equal((await createCrmServices(f.db).mutations.capabilities(token, "1")).canWriteNotes, false);
  const capabilities = await service.mutations.capabilities(token, "1");
  assert.equal(capabilities.integrationAvailable, true); assert.equal(capabilities.canWriteNotes, true);
  f.grants.splice(f.grants.indexOf("leads.manage"), 1);
  assert.equal((await service.mutations.capabilities(token, "1")).canWriteNotes, false);
  await assert.rejects(service.mutations.addNote(token, "1", { operationId: randomUUID(), expectedVersion: 1, title: "Synthetic", content: "Synthetic" }), leadFailure(403));
  assert.deepEqual(f.unhandled, []);
});

test("OFFLINE explicit service injection is not UI activation and never advertises remote creates as local", async t => {
  const f = fixture(); t.after(() => f.db.close());
  const service = services(f, async () => assert.fail("global capabilities never call the transport"));
  assert.deepEqual(await createCrmServices(f.db).localWrites.capabilities(token), {
    persistence: "local-mysql", productCreate: true, dealCreate: true, leadNotes: true, localWorkflow: true, integrationAvailable: false,
  });
  assert.deepEqual(await service.localWrites.capabilities(token), {
    persistence: "unavailable", productCreate: false, dealCreate: false, leadNotes: false, localWorkflow: false, integrationAvailable: false,
  });
  await assert.rejects(service.localWrites.capabilities("invalid-session"),
    (error: unknown) => error instanceof LocalWorkflowError && error.status === 401);
  assert.equal(f.calls.some(call => /^(INSERT|UPDATE|DELETE)\b/.test(call.sql)), false);
  assert.deepEqual(f.unhandled, []);
});

test("OFFLINE remote dispatch revalidates task identity, version and owner before reserving", async t => {
  const f = fixture(); t.after(() => f.db.close());
  const service = services(f, async () => assert.fail("failed remote authorization must cause zero effects"));
  const input = { operationId: randomUUID(), expectedVersion: 1, stage: "Site Visit" };
  f.state().tables.tasks![0]!.version = 2;
  await assert.rejects(service.mutations.changeStage(token, "1", input), leadFailure(409));
  Object.assign(f.state().tables.tasks![0]!, { version: 1, zoho_crm_id: null });
  await assert.rejects(service.mutations.changeStage(token, "1", input), leadFailure(409));
  Object.assign(f.state().tables.tasks![0]!, { zoho_crm_id: "201", assigned_to: "102" });
  await assert.rejects(service.mutations.changeStage(token, "1", input), leadFailure(403));
  assert.equal(f.state().tables.crm_lead_operations?.length ?? 0, 0); assert.deepEqual(f.unhandled, []);
});

test("OFFLINE grants revoked during remote I/O prevent local commit while retaining the receipt", async t => {
  const f = fixture(); t.after(() => f.db.close()); const operationId = randomUUID();
  const service = services(f, async () => {
    f.networkBoundary(); f.assertReserved(operationId);
    f.grants.splice(f.grants.indexOf("leads.manage"), 1); return ok("210");
  });
  await assert.rejects(service.mutations.addNote(token, "1", { operationId, expectedVersion: 1, title: "Synthetic", content: "Synthetic" }), leadFailure(403));
  assert.equal(f.state().tables.job_notes!.length, 1); assert.equal(f.state().tables.tasks![0]!.version, 1);
  assert.equal(f.operation(operationId)?.state, "reconciliation");
  assert.equal(f.operation(operationId)?.remote_references, '{"noteId":"210"}'); assert.deepEqual(f.unhandled, []);
});

test("OFFLINE local provenance is revalidated within selection transaction with no remote fallback", async t => {
  const f = fixture(); t.after(() => f.db.close()); f.state().local = true;
  const service = services(f, async () => assert.fail("damaged local provenance must never reach a remote transport"));
  await assert.rejects(service.mutations.addNote(token, "1", { operationId: randomUUID(), expectedVersion: 1, title: "Synthetic", content: "Synthetic" }),
    (error: unknown) => error instanceof LocalWorkflowError && error.status === 404);
  const selection = f.calls.find(call => call.sql === "SELECT 1 FROM crm_local_tasks WHERE task_id=?")!;
  const provenance = f.calls.find(call => call.sql.includes("FROM crm_local_tasks l JOIN tasks"))!;
  assert.equal(selection.connection, provenance.connection); assert.equal(provenance.transactional, true);
  assert.equal(f.state().tables.crm_lead_operations?.length ?? 0, 0); assert.deepEqual(f.unhandled, []);
});

test("OFFLINE explicit transport does not remove the percentage quotation persistence guard", async t => {
  const f = fixture(); t.after(() => f.db.close());
  const service = services(f, async () => assert.fail("unmigrated quotation must not reach a remote transport"));
  await assert.rejects(service.commercial.createQuotation(token, "1", { operationId: randomUUID(), expectedVersion: 1, quotation }),
    (error: unknown) => error instanceof CommercialPersistenceError && error.status === 503);
  assert.equal((await service.commercial.quotationCapabilities(token, "1")).integrationAvailable, false);
  assert.equal(f.state().tables.crm_commercial_operations?.length ?? 0, 0); assert.deepEqual(f.unhandled, []);
});
