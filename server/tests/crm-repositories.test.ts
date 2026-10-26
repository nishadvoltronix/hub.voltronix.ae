import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { MysqlDatabase } from "../src/crm/db/mysql/database.js";
import type { MysqlWireConnection } from "../src/crm/db/mysql/driver.js";
import type { LocalMysqlConfig } from "../src/crm/config/mysql.js";
import { createJobsService, JobsError } from "../src/crm/jobs/service.js";
import { createLeadsService } from "../src/crm/leads/service.js";
import { createDashboardService, DashboardError } from "../src/crm/dashboard/service.js";
import { createReportsService } from "../src/crm/reports/service.js";
import { createCommercialService, CommercialPersistenceError } from "../src/crm/commercial/service.js";
import { createLeadMutationsService, LeadMutationError } from "../src/crm/lead-mutations/service.js";
import { createAttachmentsService, AttachmentError } from "../src/crm/attachments/service.js";
import { createDepartmentsService, DepartmentsError } from "../src/crm/departments/service.js";
import { calculateQuotation, parseQuotationInput } from "../src/crm/commercial/quotations.js";
import { createZohoSyncReads, ZohoSyncReadError } from "../src/crm/zoho-sync/service.js";
import { createLocalWorkflowReads } from "../src/crm/local-workflow/reads.js";
import type { createLocalWorkflowService } from "../src/crm/local-workflow/service.js";

// These exercise converted repositories against injected asynchronous wire replies.
// They do not evaluate SQL or establish MySQL persistence, isolation, or DDL validity.
// No environment, socket, server, real account, or business record is involved.
const config: LocalMysqlConfig = { provider: "mysql", environment: "test", host: "127.0.0.1", port: 3308,
  database: "crm_test_offline_repositories", user: "synthetic_fixture", password: "unused-test-only-value" };
const now = Date.parse("2026-10-10T12:00:00Z"), session = "a".repeat(43);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
type Reply = [unknown, unknown];
type Call = { sql: string; values: readonly unknown[] };
const records = (values: unknown[]): Reply => [values, []];
const changed = (n = 1): Reply => [{ affectedRows: n, insertId: 1 }, []];
function fixture(grants: string[], handle: (call: Call) => Reply | Promise<Reply>) {
  const calls: Call[] = [], lifecycle: string[] = [];
  const wire: MysqlWireConnection = {
    async execute(sql, values = []) {
      const call = { sql: sql.replace(/\s+/g, " ").trim(), values };
      calls.push(call);
      if (call.sql === "SELECT id FROM crm_app_lock WHERE id=1 FOR UPDATE") return records([{ id: 1 }]);
      if (call.sql.includes("FROM crm_sessions s JOIN users")) return records([{ local_id: "1", user_id: "101",
        username: "Synthetic fixture", email: "fixture@example.invalid", password: "synthetic-fingerprint-source",
        status: "active", password_fingerprint: digest("synthetic-fingerprint-source"), csrf_hash: "unused",
        expires_at: Number.MAX_SAFE_INTEGER }]);
      if (call.sql.startsWith("SELECT 1 FROM crm_zoho_user_bindings binding")) return records([]);
      if (call.sql.startsWith("SELECT p.`key` FROM permissions")) return records(grants.map((key) => ({ key })));
      if (call.sql.startsWith("SELECT origin,state,last_synced_at,source_modified_at,external_id FROM (")) return records([]);
      return handle(call);
    },
    async query(sql) { lifecycle.push(sql); return records([]); },
    async beginTransaction() { lifecycle.push("BEGIN"); },
    async commit() { lifecycle.push("COMMIT"); },
    async rollback() { lifecycle.push("ROLLBACK"); },
    async end() { lifecycle.push("END"); },
    destroy() { lifecycle.push("DESTROY"); },
  };
  const db = new MysqlDatabase(config, { connect: async () => wire, verify: async () => {} });
  return { db, calls, lifecycle };
}
const job = { id: "9007199254740993", dealName: "Synthetic job", accountName: null, jobNumber: "TEST-1",
  salesStatus: "Close to Won", jobStatus: "Active", remarks: null, holdByExternalId: null, version: 5, updatedAt: "2026-10-10T00:00:00.000Z" };

test("offline converted worker history pairs current grants with latest task assignment and never broadens cross-department writes", async () => {
  const grants = ["electrical.manage"], fileId = randomUUID(), content = Buffer.from("Synthetic retained file");
  let assigned = true;
  const f = fixture(grants, ({ sql, values }) => {
    if (sql.includes("FROM tasks t")) { assert.match(sql, /t\.status IN \('Close to Won','Closed Won'\)/); return records([job]); }
    if (sql.startsWith("SELECT a.department FROM departments_assign")) {
      assert.deepEqual(values, [job.id, "1"]); assert.match(sql, /a\.user_id=\?/); assert.match(sql, /a\.status<>'Unassigned'/);
      assert.match(sql, /MAX\(x\.id\).*x\.task_id=a\.task_id AND x\.department=a\.department/);
      return records(assigned ? [{ department: "Electrical" }] : []);
    }
    if (sql.startsWith("SELECT COUNT(*) AS n FROM crm_department_work_logs")) { assert.deepEqual(values, [job.id, "Civil"]); return records([{ n: 1 }]); }
    if (sql.includes("FROM crm_department_work_logs l JOIN users")) return records([{ id: "1", taskId: job.id, department: "Civil", actorId: "2", notes: "Civil recorded note" }]);
    if (sql.includes("FROM crm_department_log_attachments WHERE log_id")) return records([{ id: fileId, name: "synthetic.txt", mediaType: "text/plain", size: content.length }]);
    if (sql.includes("FROM crm_department_log_attachments f")) return records([{ taskId: job.id, department: "Civil" }]);
    if (sql.includes("FROM crm_department_log_attachments WHERE id")) return records([{ id: fileId, name: "synthetic.txt", mediaType: "text/plain", size: content.length, digest: createHash("sha256").update(content).digest("hex"), content }]);
    throw new Error("Unexpected history query");
  });
  const service = createDepartmentsService(f.db, { now: () => now });
  const status = (code: number) => (error: unknown) => error instanceof DepartmentsError && error.status === code;
  assert.equal((await service.listLogs(session, "Civil", job.id)).items[0]!.notes, "Civil recorded note");
  assert.deepEqual((await service.downloadLogAttachment(session, fileId)).content, content);
  await assert.rejects(service.addLog(session, "Civil", job.id, {}), status(403));
  await assert.rejects(service.updateStatus(session, "Civil", job.id, {}), status(403));
  await assert.rejects(service.listJobLogs(session, job.id, "Civil"), status(403));
  assigned = false;
  await assert.rejects(service.listLogs(session, "Civil", job.id), status(404));
  await assert.rejects(service.downloadLogAttachment(session, fileId), status(404));
  assigned = true; grants.splice(0);
  await assert.rejects(service.listLogs(session, "Civil", job.id), status(403));
  await assert.rejects(service.downloadLogAttachment(session, fileId), status(404));
  assert.equal(f.calls.some(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
});

test("offline converted jobs await fresh grants and deny before record access", async () => {
  const f = fixture([], () => { throw new Error("Unexpected business query"); });
  await assert.rejects(createJobsService(f.db, { now: () => now }).updateStatus(session, job.id,
    { expectedVersion: 5, jobStatus: "Hold" }), (error: unknown) => error instanceof JobsError && error.status === 403);
  assert.equal(f.calls.some(({ sql }) => /\bFROM tasks\b|\bUPDATE tasks\b|\bINSERT\b/.test(sql)), false);
  assert.ok(f.lifecycle.includes("ROLLBACK"));
  assert.equal(f.lifecycle.includes("COMMIT"), false);
});

test("offline department queues project recorded job dates and null without weakening current assignment scope", async () => {
  const departments = [
    ["Electrical", "electrical.manage"], ["Civil", "civil.manage"], ["PM", "project_manager.manage"],
    ["Switchgear", "switchgear.manage"], ["Maintenance", "maintenance.manage"],
  ] as const;
  for (const [department, grant] of departments) {
    const grants = [grant];
    let savedDate: string | null = "2026-09-30 23:45:12";
    const assignment = { id: "2", taskId: job.id, department, userId: "1", userName: "Synthetic worker",
      status: "Assigned", actorId: "3", assignedAt: "2026-10-01", version: 1 };
    const f = fixture(grants, ({ sql, values }) => {
      if (sql.includes("FROM tasks t JOIN departments_assign")) {
        assert.match(sql, /t\.status IN \('Close to Won','Closed Won'\)/);
        assert.match(sql, /MAX\(x\.id\).*x\.task_id=a\.task_id AND x\.department=a\.department/);
        assert.match(sql, /a\.department=\? AND a\.user_id=\?/);
        assert.match(sql, /a\.status IN \('Assigned','Process','Completed','Hold'\)/);
        assert.deepEqual(values.slice(0, 2), [department, "1"]);
        if (sql.startsWith("SELECT COUNT(*)")) return records([{ n: 1 }]);
        assert.match(sql, /t\.job_deal_date AS jobDate/);
        assert.deepEqual(values.slice(2), [25, 0]);
        return records([{ ...job, jobDate: savedDate }]);
      }
      if (sql.includes("FROM departments_assign a LEFT JOIN users")) {
        assert.deepEqual(values, [job.id, department]);
        assert.match(sql, /MAX\(x\.id\).*x\.task_id=a\.task_id AND x\.department=a\.department/);
        return records([assignment]);
      }
      throw new Error("Unexpected department queue query");
    });
    const service = createDepartmentsService(f.db, { now: () => now });
    assert.deepEqual((await service.listQueue(session, department)).items, [{ ...job, jobDate: savedDate, assignment }]);
    savedDate = null;
    assert.equal((await service.listQueue(session, department)).items[0]!.jobDate, null);
    const businessReads = () => f.calls.filter(({ sql }) => /FROM tasks|FROM departments_assign/.test(sql)).length;
    const beforeDenial = businessReads();
    grants.splice(0);
    await assert.rejects(service.listQueue(session, department),
      (error: unknown) => error instanceof DepartmentsError && error.status === 403);
    await assert.rejects(service.listQueue(undefined, department),
      (error: unknown) => error instanceof DepartmentsError && error.status === 401);
    assert.equal(businessReads(), beforeDenial);
    assert.equal(f.calls.some(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
  }
});

test("offline converted job writes await CAS and audit before commit and retain lossless IDs", async () => {
  let updated = false, audited = false;
  const f = fixture(["dashboard.view"], async ({ sql, values }) => {
    if (sql.startsWith("SELECT") && sql.includes("FROM tasks")) return records([{ ...job,
      ...(updated ? { jobStatus: "Hold", holdByExternalId: "101", version: 6 } : {}) }]);
    if (sql.startsWith("UPDATE tasks")) {
      await Promise.resolve();
      assert.equal(values.at(-2), job.id); assert.equal(values.at(-1), 5);
      updated = true; return changed();
    }
    if (sql.startsWith("INSERT INTO crm_job_audit_events")) {
      assert.equal(updated, true); assert.equal(f.lifecycle.includes("COMMIT"), false);
      await Promise.resolve(); audited = true; return changed();
    }
    throw new Error("Unexpected repository query");
  });
  const result = await createJobsService(f.db, { now: () => now }).updateStatus(session, job.id,
    { expectedVersion: 5, jobStatus: "Hold" });
  assert.equal(result.id, job.id); assert.equal(result.version, 6); assert.equal(audited, true);
  assert.equal(f.lifecycle.filter((event) => event === "COMMIT").length, 1);
});

test("offline converted job CAS loss and duplicate errors return conflict without audit or commit", async () => {
  for (const duplicate of [false, true]) {
    const f = fixture(["dashboard.view"], ({ sql }) => {
      if (sql.startsWith("SELECT") && sql.includes("FROM tasks")) return records([job]);
      if (sql.startsWith("UPDATE tasks")) {
        if (duplicate) throw Object.assign(new Error("private synthetic duplicate value"), { code: "ER_DUP_ENTRY" });
        return changed(0);
      }
      throw new Error("Unexpected audit after conflict");
    });
    await assert.rejects(createJobsService(f.db, { now: () => now }).updateRemarks(session, job.id,
      { expectedVersion: 5, remarks: "Synthetic changed note" }), (error: unknown) => error instanceof JobsError && error.status === 409);
    assert.equal(f.calls.some(({ sql }) => sql.startsWith("INSERT")), false);
    assert.ok(f.lifecycle.includes("ROLLBACK")); assert.equal(f.lifecycle.includes("COMMIT"), false);
  }
});

test("offline converted audit failure requests rollback and redacts driver details", async () => {
  const f = fixture(["dashboard.view"], ({ sql }) => {
    if (sql.startsWith("SELECT") && sql.includes("FROM tasks")) return records([job]);
    if (sql.startsWith("UPDATE tasks")) return changed();
    if (sql.startsWith("INSERT INTO crm_job_audit_events")) throw new Error("private synthetic audit detail");
    throw new Error("Unexpected repository query");
  });
  await assert.rejects(createJobsService(f.db, { now: () => now }).updateRemarks(session, job.id,
    { expectedVersion: 5, remarks: "Synthetic note" }), (error: unknown) => error instanceof JobsError && error.status === 503 && !error.message.includes("private"));
  assert.ok(f.lifecycle.includes("ROLLBACK")); assert.equal(f.lifecycle.includes("COMMIT"), false);
});

test("offline converted pipeline retains agent ownership and binds literal search and pagination", async () => {
  const query = "100%_! ' synthetic";
  const f = fixture(["leads.manage.agents", "leads.view"], ({ sql }) => {
    if (sql.includes("GROUP BY stage")) return records([{ stage: "qualification", count: 2 }]);
    if (sql.includes("FROM tasks t LEFT JOIN users")) return records([]);
    throw new Error("Unexpected repository query");
  });
  const result = await createLeadsService(f.db).listPipeline(session, { query, page: 2, pageSize: 1 });
  assert.equal(result.scope, "own"); assert.equal(result.total, 2);
  const queries = f.calls.filter(({ sql }) => sql.includes("FROM tasks t"));
  assert.equal(queries.length, 2);
  for (const call of queries) {
    assert.equal(call.values[0], "101"); assert.equal(call.values[1], "%100!%!_!! ' synthetic%");
    assert.equal(call.sql.includes(query), false);
    assert.ok(call.sql.includes("CONCAT(")); assert.ok(call.sql.includes("ESCAPE '!'"));
  }
  assert.deepEqual(queries[1]!.values.slice(-2), [1, 1]);
});

test("offline synced directory requires both fresh administration grants before reading source identities", async () => {
  for (const grants of [[], ["users.write"], ["permissions.manage"], ["leads.manage.agents"]]) {
    const f = fixture(grants, () => { throw new Error("Unexpected directory query"); });
    const service = createZohoSyncReads(f.db);
    await assert.rejects(service.listDirectory(session), (error: unknown) => error instanceof ZohoSyncReadError && error.status === 403);
    await assert.rejects(service.listDirectory(undefined), (error: unknown) => error instanceof ZohoSyncReadError && error.status === 401);
    assert.equal(f.calls.some(({ sql }) => sql.includes("FROM crm_zoho_sync_records directory")), false);
  }
});

test("offline synced directory pages safe fields and distinguishes exact verified bindings from stale or absent links", async () => {
  const base = { externalId: "901", name: "Synthetic directory user", email: "directory@example.invalid", status: "active", sourceState: "active",
    sourceModifiedAt: "2026-10-10T00:00:00.000Z", lastSyncedAt: "2026-10-10T12:00:00.000Z", boundId: "2", boundEmail: "DIRECTORY@example.invalid",
    localId: "2", localName: "Synthetic account", localEmail: "directory@example.invalid", localStatus: "active", localExternalId: "901" };
  const rows = [base, { ...base, externalId: "902", boundId: null, boundEmail: null, localId: null, localName: null, localEmail: null, localStatus: null, localExternalId: null },
    { ...base, localEmail: "changed@example.invalid" }, { ...base, localStatus: "inactive" }, { ...base, sourceState: "conflict" },
    { ...base, sourceState: "deleted", name: null, email: null, status: null }, { ...base, localExternalId: "903" }, { ...base, status: "inactive" }];
  const f = fixture(["users.write", "permissions.manage"], ({ sql, values }) => {
    assert.match(sql, /source\.id=1 AND source\.organization_id=directory\.organization_id/);
    assert.match(sql, /binding\.external_user_id=directory\.external_id/);
    assert.match(sql, /linked\.id=binding\.local_user_id/);
    assert.equal(sql.includes("100%_!"), false); assert.equal(values[0], "%100!%!_!!%");
    if (sql.startsWith("SELECT COUNT(*)")) return records([{ n: 108 }]);
    assert.deepEqual(values.slice(1), [8, 8]);
    return records(rows);
  });
  const result = await createZohoSyncReads(f.db).listDirectory(session, { query: "100%_!", page: 2, pageSize: 8 });
  assert.equal(result.total, 108); assert.equal(result.page, 2); assert.equal(result.pageSize, 8);
  assert.deepEqual(result.items.map(item => item.linkState), ["linked", "unlinked", "review-required", "review-required", "review-required", "review-required", "review-required", "review-required"]);
  assert.deepEqual(result.items[0]?.linkedUser, { id: "2", name: "Synthetic account", email: "directory@example.invalid", status: "active" });
  assert.equal(result.items[1]?.linkedUser, null); assert.equal(result.items[5]?.name, null);
  assert.equal(/boundEmail|localExternalId|source_json|password/.test(JSON.stringify(result)), false);
  assert.equal(f.calls.some(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
});

test("offline synced directory rejects unbounded inputs and redacts corrupt stored rows", async () => {
  const f = fixture(["users.write", "permissions.manage"], ({ sql }) => sql.startsWith("SELECT COUNT(*)") ? records([{ n: 1 }]) : records([{ externalId: "private invalid stored payload" }]));
  const service = createZohoSyncReads(f.db);
  for (const input of [{ page: 0 }, { pageSize: 101 }, { query: "x".repeat(121) }, { query: "\0" }, { unknown: 1 }]) {
    await assert.rejects(service.listDirectory(session, input), (error: unknown) => error instanceof ZohoSyncReadError && error.status === 400);
  }
  assert.equal(f.calls.some(({ sql }) => sql.includes("FROM crm_zoho_sync_records directory")), false);
  await assert.rejects(service.listDirectory(session), (error: unknown) => error instanceof ZohoSyncReadError && error.status === 503 && !error.message.includes("private"));
});

test("offline manager pipeline can filter and find source-only assignees while agent scope stays on verified assignment", async () => {
  for (const own of [false, true]) {
    const f = fixture(own ? ["leads.view", "leads.manage.agents"] : ["leads.view"], ({ sql }) => {
      if (sql.includes("GROUP BY stage")) return records([]);
      if (sql.startsWith("SELECT COUNT(DISTINCT")) return records([{ n: 1 }]);
      if (sql.includes("GROUP BY externalId")) return records([{ externalId: "909", name: "Synthetic source agent" }]);
      if (sql.includes("FROM tasks t")) return records([]);
      throw new Error("Unexpected pipeline query");
    });
    const service = createLeadsService(f.db);
    const result = await service.listPipeline(session, { agentId: "909" });
    assert.equal(result.scope, own ? "own" : "all");
    const stageQuery = f.calls.find(({ sql }) => sql.includes("GROUP BY stage"))!;
    assert.equal(stageQuery.sql.includes("$.assignedTo.externalId"), !own);
    assert.deepEqual(stageQuery.values, own ? ["101", "909"] : ["909"]);
    if (own) assert.match(stageQuery.sql, /t\.assigned_to = \?.*t\.assigned_to = \?/);
    const agents = await service.listAgents(session, { query: "source%", page: 2, pageSize: 1 });
    assert.equal(agents.items[0]?.externalId, "909");
    const countQuery = f.calls.find(({ sql }) => sql.startsWith("SELECT COUNT(DISTINCT"))!;
    assert.equal(countQuery.sql.includes("$.assignedTo.externalId"), !own);
    assert.equal(countQuery.sql.includes("$.assignedTo.name"), !own);
    // JSON_UNQUOTE has a different implicit collation from the production
    // connector's 0900_bin literals; the REGEXP comparison must be explicit.
    if (!own) assert.match(countQuery.sql, /externalId'\)\) COLLATE utf8mb4_0900_bin REGEXP/);
    assert.deepEqual(countQuery.values, own ? ["101", "%source!%%"] : ["%source!%%"]);
    const last = f.calls.find(({ sql }) => sql.includes("GROUP BY externalId"))!;
    assert.deepEqual(last.values.slice(-2), [1, 1]);
    await service.listPipeline(session, { agentId: "unassigned" });
    const unassigned = f.calls.filter(({ sql }) => sql.includes("GROUP BY stage")).at(-1)!;
    assert.match(unassigned.sql, /IS NULL/); assert.equal(unassigned.sql.includes("$.assignedTo.externalId"), !own);
  }
});

test("offline native pipeline overlay retains local ownership and strict own assignment beside manager source filters", async () => {
  for (const own of [false, true]) {
    const f = fixture([], ({ sql }) => { assert.match(sql, /FROM tasks t/); return records([]); });
    const workflow = { current: async () => ({ localUserId: "1", externalUserId: "101", name: "Synthetic", email: "fixture@example.invalid",
      permissions: own ? ["leads.view", "leads.manage.agents"] : ["leads.view"] }) } as unknown as ReturnType<typeof createLocalWorkflowService>;
    const service = createLocalWorkflowReads(f.db, workflow, createLeadsService(f.db), createCommercialService(f.db));
    const result = await service.listPipeline(session, { agentId: "909" });
    assert.equal(result.scope, own ? "own" : "all");
    const query = f.calls.find(({ sql }) => sql.includes("GROUP BY stage"))!;
    assert.equal(query.sql.includes("$.assignedTo.externalId"), !own);
    assert.match(query.sql, /l\.task_id IS NULL/);
    if (own) assert.match(query.sql, /l\.task_id IS NULL AND t\.assigned_to=\?\) OR l\.owner_user_id=\?/);
    assert.deepEqual(query.values, own ? ["101", "1", "909"] : ["909"]);
    assert.equal(f.calls.some(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
  }
});

test("offline converted attachment authorization cannot turn an asynchronous permission predicate into an upload grant", async () => {
  const f = fixture(["leads.view"], ({ sql }) => {
    if (sql.startsWith("SELECT status,version FROM tasks")) return records([{ status: "Pending", version: 5 }]);
    if (sql.startsWith("SELECT assigned_to FROM tasks")) return records([{ assigned_to: "202" }]);
    throw new Error("Unexpected query from a read-only identity");
  });
  await assert.rejects(createAttachmentsService(f.db, { now: () => now }).upload(session, "1",
    { expectedVersion: 5, name: "fixture.txt", mediaType: "text/plain" }, Buffer.from("Synthetic fixture")),
    (error: unknown) => error instanceof AttachmentError && error.status === 403);
  assert.equal(f.calls.some(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
  assert.ok(f.lifecycle.includes("ROLLBACK"));
});

test("offline converted Dubai report preserves inclusive date boundaries with parameterized MySQL date expressions", async () => {
  const f = fixture(["dashboard.view"], ({ sql }) => sql.includes("COUNT(*)") ? records([{ n: 0 }]) : records([]));
  const report = await createReportsService(f.db, { now: () => now }).employeePerformance(session,
    { dateFrom: "2026-10-01", dateTo: "2026-10-10" });
  assert.equal(report.timeZone, "Asia/Dubai"); assert.equal(report.summary.wonAmount, "0.00");
  const rangeQueries = f.calls.filter(({ values }) => values.length === 2 && values[0] === "2026-09-30T20:00:00.000Z");
  assert.equal(rangeQueries.length, 2);
  for (const call of rangeQueries) {
    assert.equal(call.values[1], "2026-10-10T20:00:00.000Z");
    assert.ok(call.sql.includes("AS DATETIME(3)")); assert.equal(/julianday|strftime/.test(call.sql), false);
  }
  const month = f.calls.find(({ sql }) => sql.includes("DATE_ADD("));
  assert.ok(month?.sql.includes("INTERVAL 4 HOUR"));
  assert.deepEqual(month?.values, ["2026-04-30T20:00:00.000Z"]);
});

test("offline converted dashboard preserves exact 18-place money and decodes only bounded SUM counts", async () => {
  const f = fixture(["dashboard.view", "electric_dashboard.view"], ({ sql }) => {
    if (sql.includes("service_charge FROM tasks")) return records([{ id: job.id, service_charge: "9007199254740993.123456789012345678" }]);
    if (sql.includes("a.received_amount")) return records([{ taskId: job.id, received_amount: "9007199254740993.000000000000000001" }]);
    if (sql.includes("AS assignedToday")) return records([{ total: 1, pending: "1", process: "0", completed: "0", hold: "0", assignedToday: "1", completedAssignedThisMonth: "0" }]);
    if (sql.includes("COUNT(*) AS n") && !sql.includes("GROUP BY")) return records([{ n: 0 }]);
    return records([]);
  });
  const result = await createDashboardService(f.db, { now: () => now }).getDashboard(session);
  assert.equal(result.global?.accounts.totalPending, "0.123456789012345677");
  assert.equal(result.departments[0]?.assignedToday, 1); assert.equal(result.departments[0]?.pending, 1);
  const bad = fixture(["electric_dashboard.view"], () => records([{ total: 1, pending: "9007199254740992" }]));
  await assert.rejects(createDashboardService(bad.db, { now: () => now }).getDashboard(session),
    (error: unknown) => error instanceof DashboardError && error.status === 503);
});

test("offline converted product replay is idempotent and changed requests conflict without transport", async () => {
  const input = { operationId: randomUUID(), name: "Synthetic product", description: "Synthetic description" };
  const result = { operationId: input.operationId, productId: "303", version: 1 };
  const f = fixture(["items.write"], ({ sql }) => {
    if (sql.includes("FROM crm_commercial_operations WHERE operation_id")) return records([{ actor: "1", taskId: null,
      kind: "product.create", request_hash: digest(JSON.stringify(input)), state: "completed", result_json: JSON.stringify(result) }]);
    throw new Error("Unexpected persistence during replay");
  });
  const service = createCommercialService(f.db, { now: () => now });
  assert.deepEqual(await service.createProduct(session, input), result);
  await assert.rejects(service.createProduct(session, { ...input, description: "Changed" }),
    (error: unknown) => error instanceof CommercialPersistenceError && error.status === 409);
  assert.equal(f.calls.some(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
});

test("offline converted commercial and lead mutations remain unavailable without approved transport", async () => {
  const f = fixture(["items.write", "leads.manage.agents"], ({ sql }) => {
    if (sql.includes("FROM crm_commercial_operations") || sql.includes("FROM crm_lead_operations")) return records([]);
    if (sql.startsWith("SELECT assigned_to FROM tasks")) return records([{ assigned_to: "101" }]);
    if (sql.includes("FROM tasks WHERE id")) return records([{ id: "1", externalId: "201", assignedTo: "101", status: "Pending", quoteId: null, version: 1 }]);
    throw new Error("Unexpected write without transport");
  });
  await assert.rejects(createCommercialService(f.db, { now: () => now }).createProduct(session,
    { operationId: randomUUID(), name: "Synthetic product", description: "Synthetic description" }),
    (error: unknown) => error instanceof CommercialPersistenceError && error.status === 503);
  await assert.rejects(createLeadMutationsService(f.db, { now: () => now }).changeStage(session, "1",
    { operationId: randomUUID(), expectedVersion: 1, stage: "Site Visit" }),
    (error: unknown) => error instanceof LeadMutationError && error.status === 503);
  assert.equal(f.calls.some(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
});

test("offline converted quotation edits reject saved or submitted discounts before journal or transport", async () => {
  for (const savedDiscount of ["0", "10"]) {
    const saved = parseQuotationInput({ subject: "Synthetic quote", kindAttention: "Synthetic contact", discount: "0", adjustment: "0",
      items: [{ productId: "301", productName: "Synthetic product", description: "Synthetic description", uom: "PCS", quantity: "1", unitPrice: "100", itemDiscount: savedDiscount }] });
    const { items, ...header } = saved;
    let remoteCalls = 0;
    const f = fixture(["leads.manage.agents"], ({ sql }) => {
      if (sql.includes("FROM tasks WHERE id")) return records([{ id: "1", externalId: "201", assignedTo: "101", version: 1, quoteNumber: "TEST-Q", quoteExternalId: "401" }]);
      if (sql.includes("FROM crm_zoho_quotations WHERE task_id")) return records([]);
      if (sql.includes("FROM crm_quotations WHERE task_id")) return records([{ id: "1", external_id: "401", quote_number: "TEST-Q",
        header_json: JSON.stringify(header), totals_json: JSON.stringify(calculateQuotation(saved, "percentage")), calculation_policy: "percentage-create-v1", version: 1 }]);
      if (sql.includes("FROM proposal_items")) return records(items);
      if (sql.includes("FROM crm_commercial_operations WHERE operation_id")) return records([]);
      throw new Error("Unexpected write for blocked discount edit");
    });
    const service = createCommercialService(f.db, { now: () => now, transport: { async request() { remoteCalls++; throw new Error("Mock should not be called"); } } });
    await assert.rejects(service.updateQuotation(session, "1", { operationId: randomUUID(), expectedVersion: 1, expectedQuoteVersion: 1,
      quotation: { ...saved, items: [{ ...items[0]!, itemDiscount: savedDiscount === "0" ? "10" : "0" }] } }),
      (error: unknown) => error instanceof CommercialPersistenceError && error.status === 409);
    assert.equal(remoteCalls, 0); assert.equal(f.calls.some(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
  }
});

test("offline commercial ordering keeps the current agent scope and rejects unapproved SQL fields before business reads", async () => {
  const f = fixture(["items.view", "leads.manage.agents"], ({ sql }) => {
    if (sql.startsWith("SELECT COUNT(*)")) return records([{ n: 0 }]);
    if (sql.startsWith("SELECT") && (sql.includes("FROM products") || sql.includes("FROM crm_quotations UNION ALL"))) return records([]);
    throw new Error("Unexpected commercial ordering query");
  });
  const service = createCommercialService(f.db, { now: () => now });
  await service.listProducts(session, { sort: "updatedAt", direction: "desc", pageSize: 50 });
  await service.listQuotations(session, { sort: "subtotal", direction: "asc", pageSize: 100 });
  assert.ok(f.calls.some(({ sql }) => sql.includes("ORDER BY updated_at DESC,product_id ASC LIMIT ? OFFSET ?")));
  assert.ok(f.calls.some(({ sql, values }) => sql.includes("FROM crm_quotations UNION ALL") && sql.includes("FROM crm_zoho_quotations") && sql.includes("t.assigned_to=?") && values[0] === "101" && sql.includes("SUBSTRING_INDEX")));
  const countBefore = f.calls.filter(({ sql }) => /FROM products|FROM crm_quotations UNION ALL/.test(sql)).length;
  await assert.rejects(service.listQuotations(session, { sort: "constructor" }), (error: unknown) => error instanceof CommercialPersistenceError && error.status === 400);
  await assert.rejects(service.listProducts(session, { direction: "descending; DELETE FROM users" }), (error: unknown) => error instanceof CommercialPersistenceError && error.status === 400);
  assert.equal(f.calls.filter(({ sql }) => /FROM products|FROM crm_quotations UNION ALL/.test(sql)).length, countBefore);
  assert.equal(f.calls.some(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
});
