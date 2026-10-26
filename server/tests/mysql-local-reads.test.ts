import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { MysqlDatabase } from "../src/crm/db/mysql/database.js";
import type { MysqlWireConnection } from "../src/crm/db/mysql/driver.js";
import { createLocalWorkflowService, LocalWorkflowError } from "../src/crm/local-workflow/service.js";
import { createLocalWorkflowReads } from "../src/crm/local-workflow/reads.js";
import { createLeadsService, LeadsError } from "../src/crm/leads/service.js";
import { createCommercialService } from "../src/crm/commercial/service.js";
import { createAttachmentsService, AttachmentError } from "../src/crm/attachments/service.js";
import { createDashboardService, DashboardError } from "../src/crm/dashboard/service.js";
import { createReportsService, ReportError } from "../src/crm/reports/service.js";

// Offline asynchronous wire replies, not a SQL evaluator or MySQL acceptance run.
// No server, socket, file, environment, account or business state is touched.
const config = { provider: "mysql", environment: "test", host: "127.0.0.1", port: 3308,
  database: "crm_test_local_reads", user: "synthetic", password: randomUUID() } as const;
const token = "a".repeat(43), now = Date.parse("2026-10-14T12:00:00Z"), id = "9007199254740993";
type Call = { sql: string; values: readonly unknown[] };
type Reply = [unknown, unknown];
const rows = (values: unknown[]): Reply => [values, []];
const changed = (count = 1): Reply => [{ affectedRows: count, insertId: "1" }, []];
const local = { id, ownerId: "1", status: "Pending", version: 5, quoteNumber: null, createdAt: "2026-10-14T00:00:00Z" };
function fixture(permissions: string[], handle: (call: Call) => Reply) {
  const calls: Call[] = [], lifecycle: string[] = [], actor = { id: "1", externalId: null as string | null };
  const wire: MysqlWireConnection = {
    async execute(sql, values = []) {
      const call = { sql: sql.replace(/\s+/g, " ").trim(), values }; calls.push(call);
      if (call.sql === "SELECT id FROM crm_app_lock WHERE id=1 FOR UPDATE") return rows([{ id: 1 }]);
      if (call.sql.startsWith("SELECT origin,state,last_synced_at,source_modified_at,external_id FROM (")) return rows([]);
      if (call.sql.includes("FROM crm_sessions s JOIN users")) return rows([{ local_id: actor.id, user_id: actor.externalId,
        username: "Synthetic", email: "fixture@example.invalid", password: token, status: "active",
        password_fingerprint: createHash("sha256").update(token).digest("hex"), expires_at: Number.MAX_SAFE_INTEGER }]);
      if (call.sql.startsWith("SELECT 1 FROM crm_zoho_user_bindings binding")) return rows([]);
      if (call.sql.includes("FROM permissions p")) return rows(permissions.map(key => ({ key })));
      if (call.sql.startsWith("SELECT assigned_to FROM tasks")) return rows([{ assigned_to: null }]);
      if (call.sql.startsWith("SELECT a.department FROM departments_assign")) return rows([]);
      return handle(call);
    },
    async query(sql) { lifecycle.push(sql); return rows([]); },
    async beginTransaction() { lifecycle.push("BEGIN"); }, async commit() { lifecycle.push("COMMIT"); },
    async rollback() { lifecycle.push("ROLLBACK"); }, async end() {}, destroy() { lifecycle.push("DESTROY"); },
  };
  const db = new MysqlDatabase(config, { connect: async () => wire, verify: async () => {} });
  const workflow = createLocalWorkflowService(db, { now: () => now });
  return { db, workflow, reads: createLocalWorkflowReads(db, workflow, createLeadsService(db), createCommercialService(db)), calls, lifecycle, actor, permissions };
}
const workflowStatus = (code: number) => (error: unknown) => error instanceof LocalWorkflowError && error.status === code;
const attachmentStatus = (code: number) => (error: unknown) => error instanceof AttachmentError && error.status === code;

test("OFFLINE MySQL local reads retain null-external-ID ownership, current grants and historical denial without backfill", async () => {
  let proof = true;
  const f = fixture(["leads.manage.agents"], ({ sql, values }) => {
    if (sql === "SELECT 1 FROM crm_local_tasks WHERE task_id=?") return rows(values[0] === id ? [{ 1: 1 }] : []);
    if (sql.includes("FROM crm_local_tasks l JOIN tasks t")) {
      assert.match(sql, /o.actor_user_id=l.owner_user_id/); assert.match(sql, /o.state='completed'/);
      assert.match(sql, /t.zoho_crm_id IS NULL/); assert.match(sql, /o.remote_effect_possible=0/);
      return rows(proof ? [local] : []);
    }
    if (sql.startsWith("SELECT COUNT(*) n")) return rows([{ n: 1 }]);
    if (sql.includes("FROM crm_local_notes")) return rows([{ id: "8", title: "Recorded", content: "Unchanged", externalNoteId: null }]);
    if (sql.includes("FROM tasks_status_log s")) return rows([{ id: "9", status: "Site Visit", actorId: "1" }]);
    if (sql.includes("FROM tasks t LEFT JOIN users")) return rows([{ id, dealName: "Recorded deal", assignedExternalId: null, assignedName: "Synthetic" }]);
    throw new Error("Unexpected local read");
  });
  assert.equal((await f.reads.getLead(token, id)).persistence, "local-mysql");
  assert.equal((await f.reads.getLead(token, id)).localOwnerId, "1");
  assert.equal((await f.reads.listNotes(token, id)).items[0]?.content, "Unchanged");
  assert.equal((await f.reads.listStatusHistory(token, id)).items[0]?.actorId, "1");
  f.actor.id = "2"; await assert.rejects(f.reads.getLead(token, id), workflowStatus(404)); f.actor.id = "1";
  proof = false; await assert.rejects(f.reads.getLead(token, id), workflowStatus(404)); proof = true;
  f.permissions.splice(0); await assert.rejects(f.reads.listNotes(token, id), workflowStatus(404));
  f.permissions.push("leads.manage.agents");
  await assert.rejects(f.reads.getLead(token, "3"), (error: unknown) => error instanceof LeadsError && error.status === 404);
  await assert.rejects(f.reads.listNotes(null, id), workflowStatus(401));
  assert.equal(f.calls.some(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
});

test("OFFLINE MySQL local pipeline and quotation candidates bind owner/provenance, escaped filters and pagination", async () => {
  const f = fixture(["leads.manage.agents", "leads.view"], ({ sql }) => {
    if (sql.includes("GROUP BY stage")) return rows([{ stage: "qualification", count: 1 }]);
    if (sql.startsWith("SELECT COUNT(*) n")) return rows([{ n: sql.includes("UNION ALL") ? 0 : 1 }]);
    if (sql.includes("UNION ALL")) return rows([]);
    if (sql.includes(" taskId,")) return rows([{ taskId: id, localOwnerId: "1", version: 5 }]);
    return rows([{ id, localOwnerId: "1", assignedExternalId: null }]);
  });
  const pipeline = await f.reads.listPipeline(token, { query: "100%_!", page: 2, pageSize: 1 });
  assert.equal(pipeline.scope, "own"); assert.equal(pipeline.total, 1); assert.equal(pipeline.items[0]?.persistence, "local-mysql");
  const candidate = await f.reads.listQuotationCandidates(token, { query: "100%_!", page: 2, pageSize: 1 });
  assert.equal(candidate.items[0]?.persistence, "local-mysql");
  await f.reads.listQuotations(token, { sort: "subtotal", direction: "desc" });
  for (const call of f.calls.filter(call => call.sql.includes("FROM tasks t LEFT JOIN users"))) {
    assert.match(call.sql, /l.task_id IS NULL AND t.assigned_to=\?/); assert.match(call.sql, /l.owner_user_id=\?/);
    assert.match(call.sql, /o.operation_id=l.creation_operation_id/); assert.match(call.sql, /o.remote_references='\{\}'/);
    assert.deepEqual(call.values.slice(0, 3), [null, "1", "%100!%!_!!%"]);
    assert.equal(call.sql.includes("100%_!"), false);
  }
  const quotes = f.calls.find(call => call.sql.includes("ORDER BY LENGTH(SUBSTRING_INDEX"));
  assert.ok(quotes); assert.match(quotes.sql, /FROM crm_quotations UNION ALL SELECT.*FROM crm_percentage_quotations/);
  assert.match(quotes.sql, /JSON_UNQUOTE\(JSON_EXTRACT\(q.totals_json/);
  assert.equal(f.calls.some(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
});

test("OFFLINE MySQL local attachment guard reuses protected upload/download, version conflicts and active-content rejection", async () => {
  const file = randomUUID(), content = Buffer.from("Recorded immutable attachment");
  const f = fixture(["leads.manage.agents"], ({ sql }) => {
    if (sql === "SELECT 1 FROM crm_local_tasks WHERE task_id=?") return rows([{ 1: 1 }]);
    if (sql.includes("FROM crm_local_tasks l JOIN tasks t")) return rows([local]);
    if (sql.startsWith("SELECT status,version FROM tasks")) return rows([{ status: "Pending", version: 5 }]);
    if (sql.startsWith("SELECT COUNT(*) AS n")) return rows([{ n: 1 }]);
    if (sql.startsWith("SELECT CAST(task_id AS CHAR)")) return rows([{ taskId: id }]);
    if (sql.includes("FROM task_attachment")) return rows([{ id: file, name: "safe.txt", mediaType: "text/plain", size: content.length,
      createdAt: "2026-10-14", content, digest: createHash("sha256").update(content).digest("hex") }]);
    if (/^(INSERT|UPDATE)\b/.test(sql)) return changed();
    throw new Error("Unexpected attachment query");
  });
  const service = createAttachmentsService(f.db, { now: () => now, authorizeLocalTask: async (user, taskId) => {
    if (!await f.workflow.isLocal(taskId)) return false;
    try { return (await f.workflow.task(user, taskId)).ownerId === user.localUserId; }
    catch (error) { if (error instanceof LocalWorkflowError && error.status === 404) return false; throw error; }
  } });
  assert.equal((await service.list(token, id)).canUpload, true);
  assert.deepEqual((await service.download(token, file)).content, content);
  await service.authorizeUpload(token, id);
  assert.equal((await service.upload(token, id, { name: "safe.txt", mediaType: "text/plain", expectedVersion: 5 }, content)).version, 6);
  const mutations = () => f.calls.filter(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)).length;
  const before = mutations();
  await assert.rejects(service.upload(token, id, { name: "safe.txt", mediaType: "text/plain", expectedVersion: 4 }, content), attachmentStatus(409));
  await assert.rejects(service.upload(token, id, { name: "active.pdf", mediaType: "application/pdf", expectedVersion: 5 },
    Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog /OpenAction /JavaScript >> endobj\n%%EOF")), attachmentStatus(415));
  f.actor.id = "2"; await assert.rejects(service.download(token, file), attachmentStatus(404));
  f.actor.id = "1"; f.permissions.splice(0); await assert.rejects(service.authorizeUpload(token, id), attachmentStatus(404));
  assert.equal(mutations(), before); assert.ok(f.lifecycle.includes("ROLLBACK"));
  assert.ok(f.calls.some(({ sql }) => /UPDATE tasks SET version=version\+1,updated_at=\? WHERE id=\? AND version=\?/.test(sql)));
});

test("OFFLINE MySQL sales dashboard includes proven local owner with no external ID but retains section gates and Dubai ranges", async () => {
  const f = fixture(["sales_dashboard.view"], ({ sql }) => sql.includes("GROUP BY") ? rows([{ status: "Pending", n: 1 }]) : rows([{ n: 1 }]));
  const service = createDashboardService(f.db, { now: () => now, localOwnership: true });
  const result = await service.getDashboard(token);
  assert.equal(result.sales?.total, 1); assert.equal(result.sales?.stages[0]?.count, 1); assert.equal(result.global, undefined);
  const scoped = f.calls.filter(({ sql }) => sql.includes("FROM tasks t LEFT JOIN crm_local_tasks"));
  assert.equal(scoped.length, 4);
  for (const call of scoped) { assert.match(call.sql, /o.state='completed'/); assert.deepEqual(call.values.slice(0, 2), [null, "1"]); }
  assert.deepEqual(scoped[1]?.values.slice(2), ["2026-10-13T20:00:00.000Z", "2026-10-14T20:00:00.000Z"]);
  f.permissions.splice(0); await assert.rejects(service.getDashboard(token), (error: unknown) => error instanceof DashboardError && error.status === 403);
  assert.equal(f.calls.some(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
});

type DashboardFixture = {
  importedDeals: number; localDeals: number; importedWonJobs: number; localWonJobs: number;
  pending: number; completed: number; charge?: string | null; received?: string;
  pipelineRows?: { status: string | null; n: number }[];
};
function dashboardFixture(data: DashboardFixture, permissions = ["dashboard.view"]) {
  return fixture(permissions, ({ sql }) => {
    // Scripted replies exercise the real service and query boundaries, not a
    // replacement SQL evaluator. All task reads must honor explicit tombstones.
    if (sql.includes("FROM tasks") || sql.includes("JOIN tasks")) {
      assert.match(sql, /sync_record\.state='deleted'/);
    }
    const imports = /AND EXISTS\(SELECT 1 FROM crm_zoho_sync_records sync_record WHERE sync_record\.task_id=t\.id AND sync_record\.module_api_name='Deals' AND sync_record\.origin='imported'\)/.test(sql);
    const localOnly = /AND NOT EXISTS\(SELECT 1 FROM crm_zoho_sync_records sync_record WHERE sync_record\.task_id=t\.id AND sync_record\.module_api_name='Deals' AND sync_record\.origin='imported'\)/.test(sql);
    if (sql.includes("service_charge FROM tasks")) {
      assert.ok(localOnly);
      return rows(data.charge === undefined ? [] : [{ id: "1", service_charge: data.charge }]);
    }
    if (sql.includes("a.received_amount")) {
      assert.ok(localOnly);
      return rows(data.received === undefined ? [] : [{ taskId: "1", received_amount: data.received }]);
    }
    if (sql.includes(" AS assignedToday")) return rows([{ total: 0, pending: 0, process: 0, completed: 0, hold: 0, assignedToday: 0, completedAssignedThisMonth: 0 }]);
    if (sql.includes("GROUP BY a.status") || sql.includes("SELECT CAST(u.id AS CHAR)")) return rows([]);
    if (sql.includes("GROUP BY t.status")) return rows(data.pipelineRows ?? [{ status: "Closed Won", n: data.importedWonJobs + data.localWonJobs }]);
    if (sql.startsWith("SELECT COUNT(*) AS n FROM users")) return rows([{ n: 1 }]);
    if (sql.includes("SELECT COUNT(*) AS n FROM tasks")) {
      if (sql.includes("FROM latest a WHERE a.task_id=t.id")) { assert.ok(localOnly); return rows([{ n: data.pending }]); }
      if (sql.includes("FROM departments_assign a WHERE a.task_id=t.id")) { assert.ok(localOnly); return rows([{ n: data.completed }]); }
      if (sql.includes("created_at")) return rows([{ n: 0 }]);
      if (sql.includes("t.status IN ('Close to Won','Closed Won')")) return rows([{ n: imports ? data.importedWonJobs : data.importedWonJobs + data.localWonJobs }]);
      if (imports) return rows([{ n: data.importedDeals }]);
      if (localOnly) return rows([{ n: data.localDeals }]);
      if (sql.includes("assigned_to=?")) return rows([{ n: 0 }]);
    }
    throw new Error("Unexpected dashboard query");
  });
}

test("OFFLINE MySQL mixed dashboard separates known local operations from unavailable imported history", async () => {
  const f = dashboardFixture({ importedDeals: 9, localDeals: 4, importedWonJobs: 5, localWonJobs: 3,
    pending: 2, completed: 1, charge: "9007199254740993.123456789012345678", received: "9007199254740993.000000000000000001" });
  const result = await createDashboardService(f.db, { now: () => now }).getDashboard(token);
  assert.equal(result.global?.wonJobs, 8);
  assert.deepEqual(result.sourceCoverage, {
    mode: "zoho-sync", importedDeals: 9, localDeals: 4, importedWonJobs: 5, localWonJobs: 3,
    importedAt: null, operationalHistory: "not-imported", users: "local-only",
    localOperations: { pendingAssignmentJobs: 2, completedJobs: 1,
      accounts: { pendingJobs: 1, totalPending: "0.123456789012345677", unknownServiceChargeJobs: 0 } },
  });
  assert.equal(result.global?.pendingAssignmentJobs, null);
  assert.equal(result.global?.completedJobs, null);
  assert.deepEqual(result.global?.accounts, { pendingJobs: null, totalPending: null, unknownServiceChargeJobs: 0 });
  assert.equal(f.calls.some(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
});

test("OFFLINE MySQL imported-only dashboard never presents absent operational history as zero", async () => {
  const f = dashboardFixture({ importedDeals: 5960, localDeals: 0, importedWonJobs: 847, localWonJobs: 0, pending: 0, completed: 0 });
  const result = await createDashboardService(f.db, { now: () => now }).getDashboard(token);
  assert.equal(result.sourceCoverage?.importedWonJobs, 847);
  assert.equal(result.sourceCoverage?.localDeals, 0);
  assert.deepEqual(result.sourceCoverage?.localOperations, { pendingAssignmentJobs: 0, completedJobs: 0,
    accounts: { pendingJobs: 0, totalPending: "0.00", unknownServiceChargeJobs: 0 } });
  assert.equal(result.global?.pendingAssignmentJobs, null);
  assert.equal(result.global?.completedJobs, null);
  assert.equal(result.global?.accounts.totalPending, null);
});

test("OFFLINE MySQL dashboard keeps unknown local service charges explicit even with imported history", async () => {
  const f = dashboardFixture({ importedDeals: 1, localDeals: 1, importedWonJobs: 0, localWonJobs: 1,
    pending: 1, completed: 0, charge: null });
  const result = await createDashboardService(f.db, { now: () => now }).getDashboard(token);
  assert.equal(result.sourceCoverage?.localOperations?.accounts.unknownServiceChargeJobs, 1);
  assert.equal(result.sourceCoverage?.localOperations?.accounts.totalPending, null);
  assert.equal(result.global?.accounts.unknownServiceChargeJobs, 1);
});

test("OFFLINE MySQL dashboard includes unmapped stages in the same population as the displayed percentages", async () => {
  const f = dashboardFixture({ importedDeals: 5969, localDeals: 0, importedWonJobs: 847, localWonJobs: 0,
    pending: 0, completed: 0, pipelineRows: [
      { status: "Closed Won", n: 847 }, { status: "Qualification", n: 4862 }, { status: "Historical custom stage", n: 260 },
    ] });
  const result = await createDashboardService(f.db, { now: () => now }).getDashboard(token);
  assert.equal(result.global?.pipeline.reduce((total, stage) => total + stage.count, 0), 5969);
  assert.deepEqual(result.global?.pipeline.find(stage => stage.key === "unmapped"),
    { key: "unmapped", label: "Other / unmapped stages", count: 260, percentage: "4.36" });
  assert.equal(result.global?.pipeline.find(stage => stage.key === "won")?.percentage, "14.19");
});

test("OFFLINE MySQL dashboard without visible imports retains complete native totals and no coverage warning", async () => {
  // Includes the repository outcome when every previously imported Deal has an
  // explicit tombstone: invisible rows must not keep the coverage warning alive.
  const f = dashboardFixture({ importedDeals: 0, localDeals: 4, importedWonJobs: 0, localWonJobs: 3,
    pending: 1, completed: 2, charge: "100.00", received: "25.50" });
  const result = await createDashboardService(f.db, { now: () => now }).getDashboard(token);
  assert.equal(result.sourceCoverage, undefined);
  assert.equal(result.global?.wonJobs, 3);
  assert.equal(result.global?.pendingAssignmentJobs, 1);
  assert.equal(result.global?.completedJobs, 2);
  assert.deepEqual(result.global?.accounts, { pendingJobs: 1, totalPending: "74.50", unknownServiceChargeJobs: 0 });
});

test("OFFLINE MySQL restricted dashboard exposes neither global provenance counts nor local operations", async () => {
  const f = dashboardFixture({ importedDeals: 9, localDeals: 4, importedWonJobs: 5, localWonJobs: 3,
    pending: 2, completed: 1 }, ["electric_dashboard.view"]);
  const result = await createDashboardService(f.db, { now: () => now }).getDashboard(token);
  assert.equal(result.global, undefined);
  assert.equal(result.sourceCoverage, undefined);
  assert.equal(result.departments.length, 1);
  assert.equal(f.calls.some(({ sql }) => sql.startsWith("SELECT COUNT(*) AS n FROM tasks")), false);
  f.permissions.splice(0);
  await assert.rejects(createDashboardService(f.db, { now: () => now }).getDashboard(token),
    (error: unknown) => error instanceof DashboardError && error.status === 403);
});

test("OFFLINE MySQL employee report attributes only proven local ownership and preserves exact historical money", async () => {
  let valid = 1;
  const f = fixture(["dashboard.view"], ({ sql }) => {
    if (sql.startsWith("SELECT COUNT(*) AS n FROM tasks")) return rows([{ n: 0 }]);
    if (sql.startsWith("SELECT COUNT(*)")) return rows([{ n: 1 }]);
    if (sql.includes("FROM users WHERE status='active'")) return rows([{ id: "1", externalId: null, name: "Synthetic", departmentRole: null }]);
    if (sql.includes(" AS owner,")) return rows([
      { id, owner: null, localOwner: "1", validLocal: valid, status: "Closed Won", jobStatus: null, charge: "9007199254740993.123456789012345678" },
      { id: "2", owner: null, localOwner: null, validLocal: 0, status: "Closed Won", jobStatus: null, charge: "5.00" },
    ]);
    return rows([]);
  });
  const service = createReportsService(f.db, { now: () => now, localOwnership: true }), report = await service.employeePerformance(token);
  assert.equal(report.employees.items[0]?.totalDeals, 1); assert.equal(report.employees.items[0]?.wonAmount, "9007199254740993.123456789012345678");
  assert.equal(report.summary.totalDeals, 2); assert.equal(report.summary.wonAmount, "9007199254740998.123456789012345678");
  assert.equal(report.sourceCoverage, undefined);
  assert.match(f.calls.find(({ sql }) => sql.includes(" AS owner,"))!.sql, /o.actor_user_id=l.owner_user_id/);
  valid = 0; await assert.rejects(service.employeePerformance(token), (error: unknown) => error instanceof ReportError && error.status === 503);
  assert.equal(f.calls.some(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
});

test("OFFLINE MySQL report identifies synced coverage while retaining recorded imported states and exact visible monthly money", async () => {
  let unknownCharge = false;
  const f = fixture(["dashboard.view"], ({ sql, values }) => {
    if (sql.startsWith("SELECT COUNT(*) AS n FROM tasks")) {
      assert.match(sql, /sync_record\.state='deleted'/); assert.match(sql, /sync_record\.origin='imported'/);
      return rows([{ n: 3 }]);
    }
    if (sql.startsWith("SELECT COUNT(*)")) return rows([{ n: 1 }]);
    if (sql.includes("FROM users WHERE status='active'")) return rows([{ id: "1", externalId: "101", name: "Synthetic", departmentRole: "PM" }]);
    if (sql.includes(" AS owner,")) return rows([
      { id: "1", owner: "101", status: "Closed Won", jobStatus: null, charge: "9007199254740993.123456789012345678", imported: 0 },
      { id: "2", owner: "101", status: "Closed Won", jobStatus: null, charge: unknownCharge ? null : "0.02", imported: 1 },
      { id: "3", owner: "101", status: "Closed Won", jobStatus: "Hold", charge: "0.03", imported: 1 },
      { id: "4", owner: "101", status: "Qualification", jobStatus: "", charge: null, imported: 1 },
    ]);
    if (sql.includes("AS userId")) {
      assert.match(sql, /sync_record\.origin='imported'\) imported/);
      return rows([
        { userId: "1", taskId: "1", department: "Electrical", status: "Assigned", jobStatus: null, imported: 0 },
        { userId: "1", taskId: "2", department: "PM", status: "Assigned", jobStatus: null, imported: 1 },
        { userId: "1", taskId: "3", department: "PM", status: "Assigned", jobStatus: "Hold", imported: 1 },
        { userId: "1", taskId: "4", department: "PM", status: "Process", jobStatus: "", imported: 1 },
      ]);
    }
    if (sql.startsWith("SELECT MAX(source_record.last_synced_at)")) {
      assert.match(sql, /source_record\.origin='imported'/); assert.match(sql, /sync_record\.state='deleted'/);
      return rows([{ lastSyncedAt: "2026-10-14T08:30:00.000Z" }]);
    }
    if (sql.includes("DATE_ADD(")) {
      // Both imported and Hub-origin synced tombstones must be excluded. A
      // conflict is still visible, and an unsynced native row stays included.
      assert.match(sql, /sync_record\.task_id=tasks\.id.*sync_record\.state='deleted'/);
      assert.doesNotMatch(sql, /sync_record\.origin=|sync_record\.state='active'/);
      assert.deepEqual(values, ["2026-04-30T20:00:00.000Z"]);
      return rows([{ month: "2026-10", charge: "9007199254740993.123456789012345678" },
        { month: "2026-10", charge: unknownCharge ? null : "0.02" }, { month: "2026-10", charge: "0.03" }]);
    }
    throw new Error("Unexpected report read");
  });
  const service = createReportsService(f.db, { now: () => now });
  const report = await service.employeePerformance(token);
  assert.deepEqual(report.sourceCoverage, { mode: "zoho-sync", importedDeals: 3, importedWonJobs: 2,
    operationalHistory: "not-imported", users: "local-only", lastSyncedAt: "2026-10-14T08:30:00.000Z" });
  assert.equal(report.summary.totalDeals, 4); assert.equal(report.summary.wonAmount, "9007199254740993.173456789012345678");
  assert.deepEqual(report.wonJobStatuses, { active: 1, hold: 1, closed: 0 });
  assert.equal(report.employees.items[0]?.pm, 3); assert.equal(report.employees.items[0]?.hold, 1);
  assert.equal(report.employees.items[0]?.assigned, 3); assert.equal(report.employees.items[0]?.process, 1);
  assert.equal(report.employees.items[0]?.active, 1);
  assert.deepEqual(report.monthly, [{ month: "2026-10", wonAmount: "9007199254740993.173456789012345678", unknownAmounts: 0 }]);
  unknownCharge = true;
  const unknown = await service.employeePerformance(token);
  assert.equal(unknown.summary.wonAmount, null); assert.equal(unknown.summary.unknownAmounts, 1);
  assert.deepEqual(unknown.monthly, [{ month: "2026-10", wonAmount: null, unknownAmounts: 1 }]);
  assert.equal(f.calls.some(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
});

test("OFFLINE MySQL report coverage remains when selected dates contain no imports and never depends on employee paging", async () => {
  let visibleImports = 2;
  const f = fixture(["dashboard.view"], ({ sql, values }) => {
    if (sql.startsWith("SELECT COUNT(*) AS n FROM tasks")) {
      assert.deepEqual(values, []); assert.match(sql, /sync_record\.state='deleted'/);
      return rows([{ n: visibleImports }]);
    }
    if (sql.startsWith("SELECT COUNT(*)")) return rows([{ n: sql.includes("LIKE") ? 0 : 2 }]);
    if (sql.includes("FROM users WHERE status='active'")) {
      assert.deepEqual(values, ["%missing!%!_%", 1, 1]); return rows([]);
    }
    if (sql.includes(" AS owner,")) {
      assert.deepEqual(values, ["2026-09-30T20:00:00.000Z", "2026-10-01T20:00:00.000Z"]);
      return rows([{ id: "1", owner: "101", status: "Closed Won", jobStatus: null, charge: "10.00", imported: 0 }]);
    }
    if (sql.includes("AS userId")) return rows([]);
    if (sql.startsWith("SELECT MAX(source_record.last_synced_at)")) return rows([{ lastSyncedAt: null }]);
    if (sql.includes("DATE_ADD(")) {
      assert.match(sql, /sync_record\.state='deleted'/); assert.deepEqual(values, ["2026-04-30T20:00:00.000Z"]);
      return rows([{ month: "2026-09", charge: "20.00" }]);
    }
    throw new Error("Unexpected report read");
  });
  const service = createReportsService(f.db, { now: () => now });
  const filters = { dateFrom: "2026-10-01", dateTo: "2026-10-01", query: "missing%_", page: 2, pageSize: 1 };
  const report = await service.employeePerformance(token, filters);
  assert.deepEqual(report.sourceCoverage, { mode: "zoho-sync", importedDeals: 0, importedWonJobs: 0,
    operationalHistory: "not-imported", users: "local-only", lastSyncedAt: null });
  assert.equal(report.summary.totalDeals, 1); assert.equal(report.employees.total, 0); assert.equal(report.employees.page, 2);
  assert.deepEqual(report.monthly, [{ month: "2026-09", wonAmount: "20.00", unknownAmounts: 0 }]);
  visibleImports = 0;
  assert.equal((await service.employeePerformance(token, filters)).sourceCoverage, undefined);
  f.permissions.splice(0); const before = f.calls.length;
  await assert.rejects(service.employeePerformance(token, filters), (error: unknown) => error instanceof ReportError && error.status === 403);
  assert.equal(f.calls.slice(before).some(({ sql }) => /FROM tasks|FROM users WHERE|FROM crm_zoho_sync_records source_record/.test(sql)), false);
});
