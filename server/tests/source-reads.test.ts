import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { unzipSync, strFromU8 } from "fflate";
import { MysqlDatabase } from "../src/crm/db/mysql/database.js";
import type { MysqlWireConnection } from "../src/crm/db/mysql/driver.js";
import { createSourceReads, SourceReadError } from "../src/crm/source-reads/service.js";
import { createCrmServices } from "../src/crm/router.js";
import { MAX_EXPORT_ROWS } from "../src/crm/exports/xlsx.js";

// Injected in-memory wire only: these tests never open MySQL, files or listeners.
const config = { provider: "mysql", environment: "test", host: "127.0.0.1", port: 3308,
  database: "crm_local_crm_0123456789ab4def8123456789abcdef", user: "synthetic", password: "synthetic-test-only" } as const;
const token = "a".repeat(43), now = Date.parse("2026-10-14T21:00:00Z");
const job = { id: "9007199254740993", dealName: "Synthetic", accountName: null, jobNumber: "JOB-1", salesStatus: "Closed Won",
  jobStatus: "Hold", remarks: null, holdByExternalId: null, version: 7, updatedAt: "2026-10-14T00:00:00Z", jobDate: null,
  assignedName: "Synthetic Agent", serviceCharge: "123456789.01" };
const exported = { createdAt: "2026-10-14", jobNumber: "JOB-1", jobDate: null, accountName: "=SUM(1,2)", status: "Closed Won",
  electrical: "Process", civil: null, pm: "Completed", accounts: "Pending", serviceCharge: "123456789.01" };
function fixture(permissions = ["dashboard.view", "deals.view"], options: { localOwnership?: boolean } = {}) {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  let count = 1, exports = [exported], connections = 0, failure = false;
  const connection: MysqlWireConnection = {
    async query() { return [[], []]; }, async beginTransaction() {}, async commit() {}, async rollback() {}, async end() {}, destroy() {},
    async execute(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes("crm_app_lock")) return [[{ id: 1 }], []];
      if (sql.includes("FROM crm_sessions")) return [[{ local_id: "1", user_id: "101", username: "Synthetic", email: "fixture@example.invalid",
        password: "synthetic-hash", status: "active", csrf_hash: "unused", expires_at: now + 60_000,
        password_fingerprint: createHash("sha256").update("synthetic-hash").digest("hex") }], []];
      if (sql.startsWith("SELECT 1 FROM crm_zoho_user_bindings binding")) return [[], []];
      if (sql.includes("FROM permissions")) return [permissions.map(key => ({ key })), []];
      if (failure) throw new Error("private driver detail");
      assert.match(sql, /^SELECT /, "source reads issue no business mutations");
      if (sql.startsWith("SELECT COUNT")) return [[{ n: count }], []];
      if (sql.startsWith("SELECT CAST(da.task_id")) return [[
        { taskId: job.id, department: "PM", status: "Completed", userName: "PM Worker" },
        { taskId: job.id, department: "Electrical", status: "Process", userName: "DEWA Worker" },
      ], []];
      if (sql.includes(" imported,t.created_at AS createdAt")) return [exports, []];
      if (sql.includes("qualificationNumber")) return [[{ id: job.id, createdAt: "2026-10-14", qualificationNumber: null,
        jobNumber: "JOB-1", accountName: null, status: "Closed Won", assignedName: "Synthetic Agent", serviceCharge: "123456789.01" }], []];
      return [[job], []];
    },
  };
  const db = new MysqlDatabase(config, { connect: async () => { connections++; return connection; }, verify: async () => {} });
  return { db, reads: createSourceReads(db, { now: () => now, ...options }), calls, permissions, connections: () => connections,
    count(value: number) { count = value; }, exports(value: typeof exports) { exports = value; }, fail() { failure = true; } };
}
const status = (expected: number) => (error: unknown) => error instanceof SourceReadError && error.status === expected;

test("OFFLINE MySQL source lists display and search proven local owners without guessing historical ownership", async () => {
  const f = fixture(undefined, { localOwnership: true });
  await f.reads.listCreatedDeals(token, { query: "Owner_100%" });
  await f.reads.listJobs(token, { query: "Owner_100%", cohort: "pending" });
  await f.reads.exportJobs(token, { query: "Owner_100%", cohort: "pending" });
  const calls = f.calls.filter(({ sql }) => sql.includes("FROM tasks t LEFT JOIN users"));
  assert.equal(calls.length, 5);
  for (const call of calls) {
    assert.match(call.sql, /LEFT JOIN crm_local_tasks l ON l.task_id=t.id/);
    assert.match(call.sql, /WHEN l.task_id IS NULL THEN COALESCE\(u.username,\(SELECT/);
    assert.match(call.sql, /JSON_EXTRACT\(sync_agent.source_json,'\$\.assignedTo.name'\)/);
    assert.match(call.sql, /o.operation_id=l.creation_operation_id/);
    assert.match(call.sql, /o.actor_user_id=l.owner_user_id/);
    assert.match(call.sql, /o.remote_effect_possible=0/);
    assert.match(call.sql, /o.state='completed'/);
    assert.match(call.sql, /THEN local_owner.username ELSE NULL END/);
    assert.doesNotMatch(call.sql, /Owner_100%/);
    assert.equal(call.values[0], "%Owner!_100!%%");
  }
  assert.match(calls[0]!.sql, /t.deal_crm_created_by IS NOT NULL/);
  assert.match(calls[2]!.sql, /t.status IN \('Close to Won','Closed Won'\)/);
  assert.equal(f.calls.some(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
});

test("OFFLINE MySQL composition includes reads and native writes without opening connections", () => {
  const f = fixture(), services = createCrmServices(f.db);
  assert.equal(typeof services.localReads.listCreatedDeals, "function");
  assert.equal(typeof services.localReads.listJobs, "function");
  assert.equal(typeof services.localReads.exportJobs, "function");
  assert.equal(typeof services.localWrites.capabilities, "function"); assert.equal(f.connections(), 0);
});

test("OFFLINE created deals preserve source all-created scope, exact stored values, literal search and paging", async () => {
  const f = fixture(), result = await f.reads.listCreatedDeals(token, { query: "Agent%_!'", page: 3, pageSize: 10 });
  assert.equal(result.items[0]?.id, job.id); assert.equal(result.items[0]?.serviceCharge, "123456789.01");
  assert.equal(result.items[0]?.qualificationNumber, null); assert.equal(result.total, 1);
  const queries = f.calls.filter(call => call.sql.includes("FROM tasks t"));
  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.match(query.sql, /t\.deal_crm_created_by IS NOT NULL/); assert.doesNotMatch(query.sql, /deal_crm_created_by\s*=\s*\?/);
    assert.match(query.sql, /u\.user_id=t\.assigned_to/); assert.doesNotMatch(query.sql, /Agent%/);
    assert.equal(query.values[0], "%Agent!%!_!!'%");
  }
  assert.deepEqual(queries[1]?.values.slice(-2), [10, 20]);
});

test("OFFLINE central cohort lists and exports share source filters and retain current department summaries", async () => {
  for (const cohort of ["all", "pending", "process", "completed", "hold", "closed"] as const) {
    const f = fixture(), result = await f.reads.listJobs(token, { cohort, query: "Sales_100%" });
    assert.deepEqual(result.items[0]?.departments, [
      { department: "Electrical", status: "Process", userName: "DEWA Worker" },
      { department: "PM", status: "Completed", userName: "PM Worker" },
    ]);
    assert.equal(result.items[0]?.jobDate, null); assert.equal(result.items[0]?.assignedName, "Synthetic Agent");
    await f.reads.exportJobs(token, { cohort, query: "Sales_100%" });
    const count = f.calls.find(call => call.sql.startsWith("SELECT COUNT"))!;
    const list = f.calls.find(call => call.sql.startsWith("SELECT CAST(t.id"))!;
    const exp = f.calls.find(call => call.sql.includes(" imported,t.created_at AS createdAt"))!;
    const filter = (sql: string) => sql.slice(sql.indexOf("FROM tasks t")).split(" ORDER BY t.job_deal_number")[0]!.trim();
    assert.equal(filter(count.sql), filter(list.sql)); assert.equal(filter(count.sql), filter(exp.sql));
    assert.deepEqual(count.values, list.values.slice(0, -2)); assert.deepEqual(count.values, exp.values.slice(0, -1));
    assert.equal(exp.values.at(-1), MAX_EXPORT_ROWS + 1); assert.match(count.sql, /COALESCE\(u.username,\(SELECT/);
    if (cohort === "pending") {
      assert.match(count.sql, /NOT EXISTS \(SELECT 1 FROM departments_assign da WHERE da.task_id=t.id\)/);
      assert.match(count.sql, /t.Job_Status!='Closed'/); assert.doesNotMatch(count.sql, /da.user_id/);
    } else if (cohort === "process" || cohort === "completed") {
      assert.match(count.sql, /SELECT MAX\(newer.id\)/);
      assert.ok(count.sql.includes(cohort === "process" ? "'Assigned','Process'" : "'Completed'"));
      assert.doesNotMatch(count.sql, /Job_Status|COUNT\(DISTINCT/); // Either department may qualify; cohorts can overlap.
    } else if (cohort === "hold" || cohort === "closed") assert.equal(count.values[0], cohort === "hold" ? "Hold" : "Closed");
    const summaries = f.calls.find(call => call.sql.startsWith("SELECT CAST(da.task_id"))!;
    assert.match(summaries.sql, /SELECT MAX\(newer.id\)/); assert.deepEqual(summaries.values, [job.id]);
  }
});

test("OFFLINE source lists require current grants and validate inputs before task reads", async () => {
  const f = fixture([]);
  await assert.rejects(f.reads.listCreatedDeals(null), status(401));
  await assert.rejects(f.reads.listCreatedDeals(token), status(403));
  await assert.rejects(f.reads.listJobs(token), status(403));
  await assert.rejects(f.reads.exportJobs(token), status(403));
  assert.ok(!f.calls.some(call => call.sql.includes("FROM tasks t")));
  f.permissions.push("dashboard.view", "deals.view");
  for (const input of [{ cohort: "unknown" }, { page: 0 }, { pageSize: 101 }, { query: "\0" }, { actorId: "1" }]) {
    await assert.rejects(f.reads.listJobs(token, input), status(400));
  }
  await assert.rejects(f.reads.listCreatedDeals(token, { scope: "own" }), status(400));
  await assert.rejects(f.reads.exportJobs(token, { page: 1 }), status(400));
  assert.ok(!f.calls.some(call => call.sql.includes("FROM tasks t")));
  await f.reads.listJobs(token, { jobStatus: "Active" });
  const activeQuery = f.calls.find(call => call.sql.startsWith("SELECT COUNT"))!.sql;
  assert.match(activeQuery, /t.Job_Status='Active' OR \(\(t.Job_Status IS NULL OR t.Job_Status=''\) AND NOT EXISTS/);
  assert.match(activeQuery, /sync_record.origin='imported'/, "missing source job status must not be invented as Active");
  f.permissions.splice(0); await assert.rejects(f.reads.listJobs(token), status(403));
});

test("OFFLINE source exports preserve exact decimals, escape formulas and enforce bounded output", async () => {
  const f = fixture(), result = await f.reads.exportJobs(token, { cohort: "completed" });
  assert.equal(result.filename, "All_Jobs_2026-10-15.xlsx"); assert.equal(result.rowCount, 1);
  const xml = strFromU8(unzipSync(result.bytes)["xl/worksheets/sheet1.xml"]!);
  assert.match(xml, /123456789\.01/); assert.match(xml, /=SUM\(1,2\)/); assert.doesNotMatch(xml, /<f[ >]/);
  f.exports(Array.from({ length: MAX_EXPORT_ROWS + 1 }, () => exported));
  await assert.rejects(f.reads.exportJobs(token), status(413));
});

test("OFFLINE source reads fail closed on unsafe counts and redact driver failures", async () => {
  const f = fixture(); f.count(Number.MAX_SAFE_INTEGER + 1);
  await assert.rejects(f.reads.listJobs(token), status(503));
  f.fail(); await assert.rejects(f.reads.listCreatedDeals(token), error => status(503)(error)
    && error instanceof Error && !error.message.includes("private driver detail"));
});
