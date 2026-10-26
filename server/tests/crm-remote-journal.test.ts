import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { MysqlDatabase } from "../src/crm/db/mysql/database.js";
import type { MysqlWireConnection } from "../src/crm/db/mysql/driver.js";
import { createLeadMutationsService, LeadMutationError } from "../src/crm/lead-mutations/service.js";
import { createCommercialService, CommercialPersistenceError } from "../src/crm/commercial/service.js";
import { CommercialError } from "../src/crm/commercial/validation.js";
import type { AccountPayloadProfile, DealPayloadProfile } from "../src/crm/commercial/deals.js";

// Offline transaction model only. Faults simulate loss of journal ownership or
// affectedRows=0 under the production driver's -FOUND_ROWS behavior. No sockets,
// environment files, credentials or real database are used.
type Row = Record<string, unknown>;
type State = Record<string, Row[]>;
type Fault = "lost-marker" | "lost-receipt" | "same-marker" | "same-receipt" | "wrong-marker" | "wrong-receipt" | "multiple-marker";
const token = "a".repeat(43), now = () => Date.parse("2026-10-15T00:00:00Z");
const rows = (value: unknown[]): [unknown, unknown] => [value, []];
const changed = (count = 1, id = 0): [unknown, unknown] => [{ affectedRows: count, insertId: id }, []];
const ok = (id: string) => ({ status: 200, body: { data: [{ code: "SUCCESS", status: "success", details: { id } }] } });

function fixture(fault?: Fault) {
  let state: State = { tasks: [{ id: "1", zoho_crm_id: "201", assigned_to: "101", status: "Pending", version: 1 }],
    products: [], job_notes: [], crm_lead_operations: [], crm_commercial_operations: [] };
  let nextId = 10, injected = false, active = 0;
  const unhandled: string[] = [], proofReads: string[] = [];
  const table = (value: State, name: string) => value[name] ??= [];
  function execute(value: State, sql: string, params: readonly unknown[]): [unknown, unknown] {
    if (sql.includes("FROM crm_sessions s JOIN users")) return rows([{ local_id: "1", user_id: "101", username: "Synthetic owner",
      email: "owner@example.invalid", password: "synthetic-password", status: "active", expires_at: Number.MAX_SAFE_INTEGER,
      password_fingerprint: createHash("sha256").update("synthetic-password").digest("hex"), csrf_hash: "unused" }]);
    if (sql.startsWith("SELECT 1 FROM crm_zoho_user_bindings binding")) return rows([]);
    if (sql.startsWith("SELECT p.`key`")) return rows(["leads.view", "leads.manage", "items.write", "deals.manage"].map(key => ({ key })));
    if (sql.startsWith("SELECT origin,state,last_synced_at,source_modified_at,external_id FROM (")) return rows([]);
    if (sql.startsWith("SELECT assigned_to FROM tasks")) return rows(table(value, "tasks").filter(row => row.id === params[0]));
    if (sql.startsWith("SELECT CAST(id AS CHAR) id,zoho_crm_id externalId")) return rows(table(value, "tasks").filter(row => row.id === params[0]).map(row => ({
      id: row.id, externalId: row.zoho_crm_id, assignedTo: row.assigned_to, status: row.status, version: row.version, quoteId: null })));
    if (sql.includes("FROM departments_assign")) return rows([]);
    if (sql.startsWith("SELECT") && sql.includes("UNION ALL")) return rows([...table(value, "crm_lead_operations"), ...table(value, "crm_commercial_operations")]
      .filter(row => row.task_id === params[0] && row.state !== "completed").slice(0, 1));
    if (sql.startsWith("SELECT") && /FROM crm_(lead|commercial)_operations/.test(sql)) {
      const name = /FROM (crm_\w+_operations)/.exec(sql)![1]!;
      let found = table(value, name).filter(row => sql.includes("WHERE operation_id=?") ? row.operation_id === params[0]
        : row.actor_user_id === params[0] && row.state !== "completed");
      if (sql.endsWith("FOR UPDATE")) {
        assert.equal(active, 1, "unchanged evidence must be checked in a short locking transaction"); proofReads.push(sql);
        found = found.filter(row => row.state === "inflight");
        if (sql.includes("remote_effect_possible=1")) found = found.filter(row => row.remote_effect_possible === 1);
        else {
          const lead = name === "crm_lead_operations", key = String(params[lead ? 2 : 1]).slice(2), expected = params[lead ? 3 : 2];
          found = found.filter(row => (!lead || row.remote_id === params[1]) && JSON.parse(String(row.remote_references))[key] === expected);
        }
      }
      return rows(found.map(row => ({ ...row, actor: row.actor_user_id, taskId: row.task_id })));
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM products")) return rows(table(value, "products").filter(row => row.product_id === params[0]));
    if (sql.startsWith("INSERT INTO")) {
      const parsed = /^INSERT INTO (\w+)\(([^)]+)\) VALUES\((.+)\)$/.exec(sql); assert.ok(parsed, sql);
      const name = parsed[1]!, columns = parsed[2]!.split(","), expressions = parsed[3]!.split(","), row: Row = {};
      let index = 0;
      for (const [i, column] of columns.entries()) {
        const expression = expressions[i]!.trim();
        row[column.trim()] = expression === "?" ? params[index++] : expression.startsWith("'") ? expression.slice(1, -1) : Number(expression);
      }
      assert.equal(index, params.length);
      if (name.endsWith("_operations")) Object.assign(row, { task_id: row.task_id ?? null, remote_effect_possible: 0, remote_references: "{}", result_json: null });
      else row.id = String(nextId++);
      table(value, name).push(row); return changed(1, Number(row.id ?? 0));
    }
    if (/^UPDATE crm_(lead|commercial)_operations/.test(sql)) {
      const name = /^UPDATE (\w+)/.exec(sql)![1]!, row = table(value, name).find(entry => entry.operation_id === params.at(-1));
      if (!row || row.state !== "inflight") return changed(0);
      const marker = sql.includes("remote_effect_possible=1"), receipt = sql.includes("remote_references=json_set"), lead = name === "crm_lead_operations";
      const expected = () => {
        if (marker) Object.assign(row, { remote_effect_possible: 1, updated_at: params[0] });
        else if (receipt) {
          const key = String(params[lead ? 1 : 0]).slice(2);
          row.remote_references = JSON.stringify({ ...JSON.parse(String(row.remote_references)), [key]: params[lead ? 2 : 1] });
          row.updated_at = params[lead ? 3 : 2]; if (lead) row.remote_id = params[0];
        }
      };
      if (!injected && fault?.endsWith(marker ? "marker" : receipt ? "receipt" : "never")) {
        injected = true;
        if (fault.startsWith("lost")) { row.state = "reconciliation"; return changed(0); }
        if (fault.startsWith("same")) expected();
        if (fault.startsWith("wrong")) return changed(0);
        if (fault.startsWith("multiple")) return changed(2);
      }
      const before = JSON.stringify(row);
      if (marker || receipt) expected();
      else if (sql.includes("state='reconciliation'")) row.state = "reconciliation";
      else if (sql.includes("state='completed'")) {
        row.state = "completed";
        if (lead) Object.assign(row, { result_task_id: params[0], result_note_id: params[1], result_version: params[2] });
        else row.result_json = params[0];
      } else assert.fail(sql);
      return changed(before === JSON.stringify(row) ? 0 : 1);
    }
    if (sql === "UPDATE tasks SET version=version+1,updated_at=? WHERE id=? AND version=?") {
      const row = table(value, "tasks").find(entry => entry.id === params[1] && entry.version === params[2]);
      if (!row) return changed(0); row.version = Number(row.version) + 1; return changed();
    }
    unhandled.push(sql); throw new Error("Unhandled synthetic SQL");
  }
  const db = new MysqlDatabase({ provider: "mysql", environment: "test", host: "127.0.0.1", port: 3308,
    database: "crm_test_remote_journal", user: "synthetic", password: "synthetic-only" }, {
    verify: async () => {}, connect: async (): Promise<MysqlWireConnection> => {
      let transaction: State | undefined;
      const savepoints = new Map<string, State>();
      return {
        async execute(rawSql, values = []) {
          const sql = rawSql.replace(/\s+/g, " ").trim();
          if (sql === "SELECT id FROM crm_app_lock WHERE id=1 FOR UPDATE") { assert.ok(transaction); return rows([{ id: 1 }]); }
          return execute(transaction ?? state, sql, values);
        },
        async query(sql) {
          if (sql.startsWith("SET SESSION")) return rows([]);
          assert.ok(transaction);
          if (sql.startsWith("SAVEPOINT ")) savepoints.set(sql.slice(10), structuredClone(transaction));
          else if (sql.startsWith("ROLLBACK TO SAVEPOINT ")) transaction = structuredClone(savepoints.get(sql.slice(22))!);
          else if (sql.startsWith("RELEASE SAVEPOINT ")) savepoints.delete(sql.slice(18));
          else assert.fail(sql);
          return rows([]);
        },
        async beginTransaction() { assert.equal(transaction, undefined); transaction = structuredClone(state); active++; },
        async commit() { assert.ok(transaction); state = transaction; transaction = undefined; active--; },
        async rollback() { transaction = undefined; active--; },
        async end() { assert.equal(transaction, undefined); },
        destroy() { if (transaction) active--; transaction = undefined; },
      };
    },
  });
  return { db, unhandled, proofReads, state: () => state,
    operation(id: string) { return [...table(state, "crm_lead_operations"), ...table(state, "crm_commercial_operations")].find(row => row.operation_id === id); },
    networkBoundary() { assert.equal(db.inTransaction, false); assert.equal(active, 0, "journal transaction must commit before remote I/O"); },
  };
}

for (const kind of ["lead", "commercial"] as const) {
  for (const fault of ["lost-marker", "wrong-marker", "multiple-marker", "lost-receipt", "wrong-receipt"] as const) {
    test(`OFFLINE ${kind} ${fault} blocks further effects and never commits a business row`, async t => {
      const f = fixture(fault); t.after(() => f.db.close()); const operationId = randomUUID(); let requests = 0;
      const transport = { async request() { f.networkBoundary(); requests++; return ok(kind === "lead" ? "210" : "301"); } };
      const promise = kind === "lead"
        ? createLeadMutationsService(f.db, { transport, now }).addNote(token, "1", { operationId, expectedVersion: 1, title: "Synthetic", content: "Synthetic" })
        : createCommercialService(f.db, { transport, now }).createProduct(token, { operationId, name: "Synthetic", description: "Synthetic" });
      await assert.rejects(promise, (error: unknown) => kind === "lead"
        ? error instanceof LeadMutationError && error.status === 409
        : error instanceof CommercialPersistenceError && error.status === 409);
      assert.equal(requests, fault.endsWith("receipt") ? 1 : 0);
      assert.equal(f.operation(operationId)?.state, "reconciliation");
      assert.equal(f.state().products!.length, 0); assert.equal(f.state().job_notes!.length, 0);
      assert.equal(f.state().tasks![0]!.version, 1); assert.deepEqual(f.unhandled, []);
    });
  }
  for (const fault of ["same-marker", "same-receipt"] as const) {
    test(`OFFLINE ${kind} ${fault} accepts only the exact already-persisted inflight evidence`, async t => {
      const f = fixture(fault); t.after(() => f.db.close()); const operationId = randomUUID(); let requests = 0;
      const transport = { async request() { f.networkBoundary(); requests++; return ok(kind === "lead" ? "210" : "301"); } };
      const result = kind === "lead"
        ? await createLeadMutationsService(f.db, { transport, now }).addNote(token, "1", { operationId, expectedVersion: 1, title: "Synthetic", content: "Synthetic" })
        : await createCommercialService(f.db, { transport, now }).createProduct(token, { operationId, name: "Synthetic", description: "Synthetic" });
      assert.equal(result.operationId, operationId); assert.equal(requests, 1);
      assert.equal(f.proofReads.length, 1); assert.equal(f.operation(operationId)?.state, "completed");
      assert.equal(f.state()[kind === "lead" ? "job_notes" : "products"]!.length, 1); assert.deepEqual(f.unhandled, []);
    });
  }
}

test("OFFLINE lead multi-write flow with a frozen clock preserves receipts through repeated zero-changed markers", async t => {
  const f = fixture(); t.after(() => f.db.close()); const operationId = randomUUID(), paths: string[] = [];
  const service = createLeadMutationsService(f.db, { now, accountOwnerId: "501", transport: {
    async request(request) {
      f.networkBoundary(); paths.push(request.path);
      if (request.method === "GET") return { status: 204, body: null };
      if (request.path === "/Accounts") return ok("601");
      if (request.path === "/Contacts") return ok("701");
      throw new Error("Synthetic remote outage");
    },
  } });
  await assert.rejects(service.createDeal(token, { operationId, firstName: "Synthetic", lastName: "Contact", companyName: "Synthetic company",
    email: "synthetic@example.invalid", phone: "000", mobile: "001", department: "VOLTRONIX CONTRACTING LLC" }),
  (error: unknown) => error instanceof LeadMutationError && error.status === 503);
  assert.deepEqual(paths.map(path => path.split("?")[0]), ["/Accounts/search", "/Accounts", "/Contacts", "/Deals"]);
  assert.equal(f.proofReads.length, 2);
  assert.equal(f.operation(operationId)?.state, "reconciliation");
  assert.equal(f.operation(operationId)?.remote_references, '{"accountId":"601","contactId":"701"}');
  assert.equal(f.state().tasks!.length, 1); assert.deepEqual(f.unhandled, []);
});

const account = { id: "601", Account_Name: "Synthetic company" };
const dealInput = { firstName: "Synthetic", lastName: "Contact", companyName: "Synthetic company",
  email: "synthetic@example.invalid", phone: "000", mobile: "001", department: "VOLTRONIX CONTRACTING LLC" };

test("OFFLINE explicit pipeline reaches the deal transport and is part of operation identity", async t => {
  const operationId = randomUUID(), hashes: string[] = [];
  for (const dealPipeline of [undefined, "Synthetic pipeline", "Other synthetic pipeline"]) {
    const f = fixture(); t.after(() => f.db.close()); let writes = 0;
    const service = createLeadMutationsService(f.db, { now, accountOwnerId: "501",
      ...(dealPipeline === undefined ? {} : { dealPipeline }), transport: { async request(request) {
        f.networkBoundary();
        if (request.method === "GET") return { status: 200, body: { data: [account] } };
        writes++;
        if (request.path === "/Contacts") return ok("701");
        assert.equal(request.path, "/Deals");
        const row = (request.body as { data: Row[] }).data[0]!;
        assert.equal(row.Pipeline, dealPipeline); assert.equal(row.Stage, "Qualification");
        throw new Error("Synthetic outbound stop");
      } } });
    await assert.rejects(service.createDeal(token, { operationId, ...dealInput }), (error: unknown) => error instanceof LeadMutationError && error.status === 503);
    hashes.push(String(f.operation(operationId)?.request_hash)); assert.equal(writes, 2); assert.deepEqual(f.unhandled, []);
    assert.throws(() => createLeadMutationsService(f.db, { dealPipeline: " invalid " }), (error: unknown) => error instanceof CommercialError && error.status === 400);
  }
  assert.equal(new Set(hashes).size, 3);
});

test("OFFLINE invalid account profiles refuse before journal or transport work", async t => {
  const f = fixture(); t.after(() => f.db.close());
  for (const invalid of [null, "", "automatic", {}, ["standard-account-contact-email-v1"]]) {
    assert.throws(() => createLeadMutationsService(f.db, { accountPayloadProfile: invalid as AccountPayloadProfile }),
      (error: unknown) => error instanceof CommercialError && error.status === 400);
  }
  assert.deepEqual(f.state().crm_lead_operations, []); assert.deepEqual(f.unhandled, []);
});

test("OFFLINE selected pipeline must match remote readback before a created deal can commit locally", async t => {
  for (const pipeline of [undefined, "Other pipeline", { name: "Synthetic pipeline" }]) {
    const f = fixture(); t.after(() => f.db.close()); const operationId = randomUUID(); let reads = 0;
    const service = createLeadMutationsService(f.db, { now, accountOwnerId: "501", dealPipeline: "Synthetic pipeline", transport: {
      async request(request) {
        f.networkBoundary();
        if (request.path.startsWith("/Accounts/search")) return { status: 200, body: { data: [account] } };
        if (request.path === "/Contacts") return ok("701");
        if (request.path === "/Deals") return ok("801");
        assert.equal(request.path, "/Deals/801"); reads++;
        return { status: 200, body: { data: [{ id: "801", DealNumber: "TEST-1", Deal_Name: "Synthetic Contact", Stage: "Qualification", Pipeline: pipeline }] } };
      },
    } });
    await assert.rejects(service.createDeal(token, { operationId, ...dealInput }), (error: unknown) => error instanceof LeadMutationError && error.status === 503);
    assert.equal(reads, 1); assert.equal(f.state().tasks!.length, 1); assert.equal(f.operation(operationId)?.state, "reconciliation");
    assert.equal(f.operation(operationId)?.remote_references, '{"accountId":"601","contactId":"701","dealId":"801"}');
    assert.deepEqual(f.unhandled, []);
  }
});

test("OFFLINE account contract selection reaches the request, retains email and binds the journal hash", async t => {
  const operationId = randomUUID(), hashes: string[] = [];
  for (const profile of [undefined, "legacy-account-email-v1", "standard-account-contact-email-v1"] as const) {
    const f = fixture(); t.after(() => f.db.close()); const paths: string[] = [];
    const service = createLeadMutationsService(f.db, { now, accountOwnerId: "501",
      ...(profile === undefined ? {} : { accountPayloadProfile: profile }), transport: {
        async request(request) {
          f.networkBoundary(); paths.push(request.path);
          if (request.method === "GET") return { status: 204, body: null };
          const row = (request.body as { data: Record<string, unknown>[] }).data[0]!;
          if (request.path === "/Accounts") {
            assert.equal("Email" in row, profile !== "standard-account-contact-email-v1");
            assert.deepEqual(row.Owner, { id: "501" }); return ok("601");
          }
          assert.equal(row.Email, dealInput.email);
          if (request.path === "/Contacts") return ok("701");
          assert.equal(request.path, "/Deals"); throw new Error("Synthetic outbound stop");
        },
      } });
    await assert.rejects(service.createDeal(token, { operationId, ...dealInput }),
      (error: unknown) => error instanceof LeadMutationError && error.status === 503);
    assert.deepEqual(paths.map(path => path.split("?")[0]), ["/Accounts/search", "/Accounts", "/Contacts", "/Deals"]);
    hashes.push(String(f.operation(operationId)?.request_hash));
    assert.equal(f.operation(operationId)?.state, "reconciliation");
    assert.equal(f.operation(operationId)?.remote_references, '{"accountId":"601","contactId":"701"}');
    assert.equal(f.state().tasks!.length, 1); assert.deepEqual(f.unhandled, []);
  }
  assert.equal(hashes[0], hashes[1]); assert.notEqual(hashes[1], hashes[2]);
});

test("OFFLINE stage profile travels through the service request and binds the journal hash", async t => {
  const operationId = randomUUID(), hashes: string[] = [];
  for (const profile of [undefined, "legacy-stage-v1", "voltronix-stage-labels-v1"] as const) {
    const f = fixture(); t.after(() => f.db.close()); let calls = 0;
    const service = createLeadMutationsService(f.db, { now,
      ...(profile === undefined ? {} : { stagePayloadProfile: profile }), transport: {
        async request(request) {
          f.networkBoundary(); calls++;
          assert.equal(request.method, "PUT");
          assert.deepEqual(request.body, { data: [{ Stage: profile === "voltronix-stage-labels-v1" ? "Needs Analysis" : "Site Visit",
            VZ_App_Status: "Site Visit", Amount: "12.50" }] });
          throw new Error("Synthetic outbound stop");
        },
      } });
    await assert.rejects(service.changeStage(token, "1", { operationId, expectedVersion: 1, stage: "Site Visit", serviceCharge: "12.50" }),
      (error: unknown) => error instanceof LeadMutationError && error.status === 503);
    assert.equal(calls, 1);
    assert.equal(f.operation(operationId)?.state, "reconciliation");
    assert.equal(f.state().tasks![0]!.status, "Pending");
    hashes.push(String(f.operation(operationId)?.request_hash));
    assert.deepEqual(f.unhandled, []);
  }
  assert.equal(hashes[0], hashes[1]);
  assert.notEqual(hashes[1], hashes[2]);
});

test("OFFLINE invalid deal profile refuses before journal or transport work", async t => {
  const f = fixture(); t.after(() => f.db.close());
  for (const invalid of [null, "", "__proto__", "tenant-auto", {}, ["legacy-conversion-fields-v1"]]) {
    assert.throws(() => createLeadMutationsService(f.db, { dealPayloadProfile: invalid as DealPayloadProfile }),
      (error: unknown) => error instanceof CommercialError && error.status === 400);
  }
  assert.deepEqual(f.state().crm_lead_operations, []);
  assert.deepEqual(f.unhandled, []);
});

test("OFFLINE lead service carries the selected source profile through the actual deal request and journal hash", async t => {
  const hashes: string[] = [], operationId = randomUUID();
  for (const profile of [undefined, "legacy-create-v1", "legacy-conversion-fields-v1"] as const) {
    const f = fixture(); t.after(() => f.db.close()); const paths: string[] = [];
    const service = createLeadMutationsService(f.db, { now, accountOwnerId: "501",
      ...(profile === undefined ? {} : { dealPayloadProfile: profile }), transport: {
      async request(request) {
        f.networkBoundary(); paths.push(request.path);
        if (request.method === "GET") return { status: 200, body: { data: [account] } };
        if (request.path === "/Contacts") return ok("701");
        assert.equal(request.path, "/Deals");
        const payload = (request.body as { data: Row[] }).data[0]!;
        const alternate = profile === "legacy-conversion-fields-v1";
        assert.equal(payload[alternate ? "Assign_Department1" : "Department"], dealInput.department);
        assert.equal(payload[alternate ? "P_BOX" : "P_Box"], "0007");
        assert.equal(alternate ? "Department" in payload : "Assign_Department1" in payload, false);
        assert.equal(alternate ? "P_Box" in payload : "P_BOX" in payload, false);
        assert.equal(payload.Email, dealInput.email);
        assert.equal(payload.Stage, "Qualification");
        assert.deepEqual(payload.Account_Name, { id: "601" });
        assert.deepEqual(payload.Contact_Name, { id: "701" });
        throw new Error("Synthetic stop after inspecting the outbound request");
      },
    } });
    await assert.rejects(service.createDeal(token, { operationId, ...dealInput, poBox: "0007" }),
      (error: unknown) => error instanceof LeadMutationError && error.status === 503);
    assert.equal(paths.length, 3);
    assert.equal(f.operation(operationId)?.state, "reconciliation");
    assert.equal(f.operation(operationId)?.remote_references, '{"accountId":"601","contactId":"701"}');
    hashes.push(String(f.operation(operationId)?.request_hash));
    assert.equal(f.state().tasks!.length, 1);
    assert.deepEqual(f.unhandled, []);
  }
  assert.equal(hashes[0], hashes[1], "existing default replay hashes are preserved");
  assert.notEqual(hashes[1], hashes[2], "alternate mapping is a distinct remote effect");
});

const rejectedAccountSearches: { name: string; status: number; body: unknown }[] = [
  { name: "partial empty page", status: 200, body: { data: [], info: { more_records: true } } },
  { name: "partial singleton page", status: 200, body: { data: [account], info: { more_records: true } } },
  { name: "missing pagination completeness", status: 200, body: { data: [], info: {} } },
  { name: "string pagination flag", status: 200, body: { data: [], info: { more_records: "false" } } },
  { name: "null pagination metadata", status: 200, body: { data: [], info: null } },
  { name: "error with empty data", status: 200, body: { data: [], error: "PRIVATE_PROVIDER_ERROR" } },
  { name: "error code with singleton data", status: 200, body: { data: [account], code: "PRIVATE_PROVIDER_ERROR", status: "error" } },
  { name: "two matching candidates", status: 200, body: { data: [account, { ...account, id: "602" }] } },
  { name: "unrelated company", status: 200, body: { data: [{ ...account, Account_Name: "PRIVATE_OTHER_COMPANY" }] } },
  { name: "nonexact company whitespace", status: 200, body: { data: [{ ...account, Account_Name: " Synthetic company " }] } },
  { name: "missing account identifier", status: 200, body: { data: [{ Account_Name: account.Account_Name }] } },
  { name: "numeric account identifier", status: 200, body: { data: [{ ...account, id: 601 }] } },
  { name: "missing data", status: 200, body: { info: { more_records: false } } },
  { name: "malformed data", status: 200, body: { data: null } },
  { name: "unexpected created status", status: 201, body: { data: [] } },
  { name: "unexpected accepted status", status: 202, body: { data: [account] } },
  { name: "unexpected partial status", status: 206, body: { data: [] } },
];

for (const response of rejectedAccountSearches) {
  test(`OFFLINE account search rejects ${response.name} before any business write`, async t => {
    const f = fixture(); t.after(() => f.db.close()); const operationId = randomUUID(); let requests = 0;
    const service = createLeadMutationsService(f.db, { now, accountOwnerId: "501", transport: {
      async request(request) { f.networkBoundary(); requests++; assert.equal(request.method, "GET"); return response; },
    } });
    await assert.rejects(service.createDeal(token, { operationId, ...dealInput }),
      (error: unknown) => error instanceof LeadMutationError && error.status === 503 && !error.message.includes("PRIVATE_"));
    assert.equal(requests, 1); assert.equal(f.operation(operationId)?.state, "reconciliation");
    assert.equal(f.operation(operationId)?.remote_effect_possible, 0); assert.equal(f.operation(operationId)?.remote_references, "{}");
    assert.equal(f.state().tasks!.length, 1); assert.deepEqual(f.unhandled, []);
  });
}

for (const response of [
  { name: "204 absence", status: 204, body: null, next: "/Accounts" },
  { name: "empty result", status: 200, body: { data: [] }, next: "/Accounts" },
  { name: "complete empty result", status: 200, body: { data: [], info: { more_records: false, count: "0", page: "1" } }, next: "/Accounts" },
  { name: "unique exact account", status: 200, body: { data: [account] }, next: "/Contacts" },
  { name: "complete exact account", status: 200, body: { data: [{ ...account, Owner: { id: "501" } }], info: { more_records: false, count: "1" } }, next: "/Contacts" },
]) {
  test(`OFFLINE account search accepts ${response.name} without duplicating an existing account`, async t => {
    const f = fixture(); t.after(() => f.db.close()); const operationId = randomUUID(), paths: string[] = [];
    const service = createLeadMutationsService(f.db, { now, accountOwnerId: "501", transport: {
      async request(request) {
        f.networkBoundary(); paths.push(request.path);
        if (request.method === "GET") return response;
        assert.equal(request.path, response.next);
        if (request.path === "/Contacts") assert.deepEqual((request.body as { data: { Account_Name: unknown }[] }).data[0]!.Account_Name, { id: "601" });
        throw new Error("Synthetic bounded stop before further remote mutations");
      },
    } });
    await assert.rejects(service.createDeal(token, { operationId, ...dealInput }), (error: unknown) => error instanceof LeadMutationError && error.status === 503);
    assert.equal(paths.length, 2); assert.equal(paths[1], response.next);
    assert.equal(f.operation(operationId)?.state, "reconciliation");
    assert.equal(f.operation(operationId)?.remote_references, response.next === "/Contacts" ? '{"accountId":"601"}' : "{}");
    assert.equal(f.state().tasks!.length, 1); assert.deepEqual(f.unhandled, []);
  });
}
