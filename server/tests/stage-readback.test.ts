import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { MysqlDatabase } from "../src/crm/db/mysql/database.js";
import type { MysqlWireConnection } from "../src/crm/db/mysql/driver.js";
import { createLeadMutationsService, LeadMutationError } from "../src/crm/lead-mutations/service.js";
import type { StagePayloadProfile } from "../src/crm/lead-mutations/stage-profile.js";

// Synthetic wire and transaction state only: no sockets, .env, live account or
// installed database. The real service runs through its injected database port.
type Row = Record<string, unknown>;
type State = { task: Row; operations: Row[]; logs: Row[]; audits: Row[] };
const token = "a".repeat(43), now = () => Date.parse("2026-10-15T00:00:00Z");
const rows = (value: unknown[]): [unknown, unknown] => [value, []];
const changed = (count = 1): [unknown, unknown] => [{ affectedRows: count, insertId: 0 }, []];
const failure = (status: number) => (error: unknown) => error instanceof LeadMutationError && error.status === status;

function fixture(amounts: readonly unknown[], profile: StagePayloadProfile = "legacy-stage-v1") {
  let state: State = { task: { id: "1", externalId: "201", assignedTo: "101", status: "Pending", version: 1,
    quoteId: null, service_charge: "5.00" }, operations: [], logs: [], audits: [] }, active = 0;
  const unhandled: string[] = [], waits: number[] = [], requests: { method: string; body?: unknown }[] = [];
  let reads = 0, businessUpdates = 0;
  function execute(value: State, sql: string, params: readonly unknown[]): [unknown, unknown] {
    if (sql.includes("FROM crm_sessions s JOIN users")) return rows([{ local_id: "1", user_id: "101", username: "Synthetic owner",
      email: "owner@example.invalid", password: "synthetic-password", status: "active", expires_at: Number.MAX_SAFE_INTEGER,
      password_fingerprint: createHash("sha256").update("synthetic-password").digest("hex"), csrf_hash: "unused" }]);
    if (sql.startsWith("SELECT 1 FROM crm_zoho_user_bindings binding")) return rows([]);
    if (sql.startsWith("SELECT p.`key`")) return rows(["leads.view", "leads.manage"].map(key => ({ key })));
    if (sql.startsWith("SELECT origin,state,last_synced_at,source_modified_at,external_id FROM (")) return rows([]);
    if (sql.startsWith("SELECT assigned_to FROM tasks")) return rows(params[0] === "1" ? [{ assigned_to: value.task.assignedTo }] : []);
    if (sql.startsWith("SELECT CAST(id AS CHAR) id,zoho_crm_id externalId")) return rows(params[0] === "1" ? [{ ...value.task }] : []);
    if (sql.startsWith("SELECT") && sql.includes("UNION ALL")) return rows(value.operations.filter(row => row.task_id === params[0] && row.state !== "completed"));
    if (sql.startsWith("SELECT") && sql.includes("FROM crm_lead_operations")) return rows(value.operations.filter(row => row.operation_id === params[0]));
    if (sql.startsWith("INSERT INTO ")) {
      const parsed = /^INSERT INTO (\w+)\(([^)]+)\) VALUES\((.+)\)$/.exec(sql); assert.ok(parsed, sql);
      const expressions = parsed[3]!.split(","), row: Row = {}; let index = 0;
      for (const [i, column] of parsed[2]!.split(",").entries()) {
        const expression = expressions[i]!.trim();
        row[column.trim()] = expression === "?" ? params[index++] : expression.slice(1, -1);
      }
      assert.equal(index, params.length);
      if (parsed[1] === "crm_lead_operations") {
        Object.assign(row, { remote_effect_possible: 0, remote_references: "{}" }); value.operations.push(row);
      } else if (parsed[1] === "tasks_status_log") value.logs.push(row);
      else if (parsed[1] === "crm_lead_audit_events") value.audits.push(row);
      else assert.fail(sql);
      return changed();
    }
    if (sql.startsWith("UPDATE crm_lead_operations")) {
      const row = value.operations.find(entry => entry.operation_id === params.at(-1) && entry.state === "inflight");
      if (!row) return changed(0);
      if (sql.includes("remote_effect_possible=1")) row.remote_effect_possible = 1;
      else if (sql.includes("remote_references=json_set")) Object.assign(row, { remote_id: params[0],
        remote_references: JSON.stringify({ dealId: params[2] }) });
      else if (sql.includes("state='reconciliation'")) row.state = "reconciliation";
      else if (sql.includes("state='completed'")) Object.assign(row, { state: "completed", result_task_id: params[0],
        result_note_id: params[1], result_version: params[2] });
      else assert.fail(sql);
      return changed();
    }
    if (sql.startsWith("UPDATE tasks SET ")) {
      assert.equal(active, 1); businessUpdates++;
      if (value.task.id !== params.at(-2) || value.task.version !== params.at(-1)) return changed(0);
      const assignments = /^UPDATE tasks SET (.+) WHERE id=\? AND version=\?$/.exec(sql); assert.ok(assignments);
      let index = 0;
      for (const assignment of assignments[1]!.split(",")) {
        const [key, expression] = assignment.split("="); assert.ok(key);
        if (expression === "version+1") value.task.version = Number(value.task.version) + 1;
        else { assert.equal(expression, "?"); value.task[key] = params[index++]; }
      }
      assert.equal(index, params.length - 2); return changed();
    }
    unhandled.push(sql); throw new Error("Unhandled synthetic SQL");
  }
  const db = new MysqlDatabase({ provider: "mysql", environment: "test", host: "127.0.0.1", port: 3308,
    database: "crm_test_stage_readback", user: "synthetic", password: "synthetic-only" }, {
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
  const service = createLeadMutationsService(db, { now, stagePayloadProfile: profile, wait: async ms => { waits.push(ms); }, transport: {
    async request(request) {
      assert.equal(db.inTransaction, false); assert.equal(active, 0, "remote I/O must not retain an application transaction");
      assert.equal(request.path, "/Deals/201"); requests.push(request);
      if (request.method === "PUT") return { status: 200, body: { data: [{ code: "SUCCESS", status: "success", details: { id: "201" } }] } };
      assert.equal(request.method, "GET");
      const amount = amounts[Math.min(reads++, amounts.length - 1)];
      return { status: 200, body: { data: [{ id: "201", Stage: profile === "legacy-stage-v1" ? "Site Visit" : "Needs Analysis",
        VZ_App_Status: "Site Visit", DealNumber: "SYNTHETIC-DEAL", SiteDealNumber: "SYNTHETIC-SITE",
        ...(amount === undefined ? {} : { Amount: amount }) }] } };
    },
  } });
  return { db, service, waits, requests, unhandled, state: () => structuredClone(state), updates: () => businessUpdates };
}

test("OFFLINE stage amount success requires exact decimal equality while preserving requested scale and replay", async t => {
  for (const profile of ["legacy-stage-v1", "voltronix-stage-labels-v1"] as const) {
    for (const [requested, returned] of [["12.50", "12.500"], ["0.000", "0"],
      ["9007199254740993.123456789123456789", "9007199254740993.123456789123456789"]]) {
      assert.ok(requested); assert.ok(returned);
      const f = fixture([returned], profile); t.after(() => f.db.close());
      const input = { operationId: randomUUID(), expectedVersion: 1, stage: "Site Visit", serviceCharge: requested };
      const result = await f.service.changeStage(token, "1", input);
      assert.equal(result.version, 2); assert.equal(f.state().task.service_charge, requested);
      assert.equal(f.state().task.status, "Site Visit"); assert.equal(f.state().operations[0]!.state, "completed");
      assert.equal(f.state().logs.length, 1); assert.equal(f.state().audits.length, 1); assert.equal(f.updates(), 1);
      assert.deepEqual(await f.service.changeStage(token, "1", input), result);
      assert.deepEqual(f.requests.map(request => request.method), ["PUT", "GET"]); assert.deepEqual(f.waits, []);
      assert.deepEqual((f.requests[0]!.body as { data: Row[] }).data[0]!.Amount, requested); assert.deepEqual(f.unhandled, []);
    }
  }
});

test("OFFLINE stage amount mismatch never commits and retains reconciliation after the existing bounded readback polls", async t => {
  for (const returned of [undefined, null, "", "12.51", " 12.50", "1.25e1", "012.50", "-12.50", "12.5000000000000000000",
    12.5, Number("9007199254740993"), NaN, Infinity, {}, { value: "12.50" }]) {
    const f = fixture([returned]); t.after(() => f.db.close()); const before = f.state().task;
    const input = { operationId: randomUUID(), expectedVersion: 1, stage: "Site Visit", serviceCharge: "12.50" };
    await assert.rejects(f.service.changeStage(token, "1", input), failure(503));
    assert.deepEqual(f.state().task, before); assert.equal(f.updates(), 0); assert.deepEqual(f.state().logs, []); assert.deepEqual(f.state().audits, []);
    const journal = f.state().operations[0]!;
    assert.equal(journal.state, "reconciliation"); assert.equal(journal.remote_effect_possible, 1);
    assert.equal(journal.remote_id, "201"); assert.equal(journal.remote_references, '{"dealId":"201"}');
    assert.equal(f.requests.filter(request => request.method === "PUT").length, 1);
    assert.equal(f.requests.filter(request => request.method === "GET").length, 12); assert.deepEqual(f.waits, Array(11).fill(2_000));
    await assert.rejects(f.service.changeStage(token, "1", input), failure(409)); assert.equal(f.requests.length, 13);
    assert.deepEqual(f.unhandled, []);
  }
});

test("OFFLINE stage readback detects a one-unit difference beyond JavaScript numeric precision", async t => {
  const f = fixture(["9007199254740993.123456789123456788"]); t.after(() => f.db.close());
  await assert.rejects(f.service.changeStage(token, "1", { operationId: randomUUID(), expectedVersion: 1, stage: "Site Visit",
    serviceCharge: "9007199254740993.123456789123456789" }), failure(503));
  assert.equal(f.updates(), 0); assert.equal(f.state().operations[0]!.state, "reconciliation"); assert.equal(f.requests.length, 13);
});

test("OFFLINE matching amount may become visible during existing polling without repeating the write", async t => {
  const f = fixture([undefined, "12.49", "12.500"], "voltronix-stage-labels-v1"); t.after(() => f.db.close());
  await f.service.changeStage(token, "1", { operationId: randomUUID(), expectedVersion: 1, stage: "Site Visit", serviceCharge: "12.50" });
  assert.deepEqual(f.requests.map(request => request.method), ["PUT", "GET", "GET", "GET"]);
  assert.deepEqual(f.waits, [2_000, 2_000]); assert.equal(f.updates(), 1); assert.equal(f.state().task.service_charge, "12.50");
  assert.equal(f.state().operations[0]!.state, "completed"); assert.deepEqual(f.unhandled, []);
});

test("OFFLINE stage change without a requested charge neither checks nor replaces the remote or saved amount", async t => {
  for (const returned of [undefined, "not-an-amount", 42]) {
    const f = fixture([returned]); t.after(() => f.db.close());
    await f.service.changeStage(token, "1", { operationId: randomUUID(), expectedVersion: 1, stage: "Site Visit" });
    assert.equal(f.state().task.service_charge, "5.00"); assert.equal(f.state().task.version, 2);
    assert.equal(f.state().operations[0]!.state, "completed"); assert.equal(f.requests.length, 2); assert.deepEqual(f.waits, []);
    assert.equal(Object.hasOwn((f.requests[0]!.body as { data: Row[] }).data[0]!, "Amount"), false); assert.deepEqual(f.unhandled, []);
  }
});
