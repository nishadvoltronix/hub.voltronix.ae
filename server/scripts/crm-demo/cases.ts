import { randomUUID } from "node:crypto";
import type { AuthService } from "../../src/auth/service.js";
import { createCrmServices } from "../../src/crm/router.js";
import type { MysqlDatabase } from "../../src/crm/db/mysql/database.js";
import type { MysqlWireConnection } from "../../src/crm/db/mysql/driver.js";
import { CrmDemoCaseError, consumeCrmDemo, demoRows, ensureCrmDemo, verifyCrmDemoFixture, type CrmDemoFixture } from "./fixture.js";
import { nativeWriteChecks, runCrmDemoNativeWrites, syntheticCrmIssuer } from "./native-writes.js";

export const expectedCrmDemoChecks = 8 + nativeWriteChecks;

export interface CrmDemoRuntime { database: MysqlDatabase; auth: AuthService; close: () => Promise<void> }
export interface CrmDemoCaseOptions {
  fixture: CrmDemoFixture; fixtureConnection: MysqlWireConnection;
  createRuntime: () => CrmDemoRuntime; record: (name: string, kind: "mysql" | "http" | "chromium") => void;
}
async function rejectStatus(work: () => Promise<unknown>, expected: number) {
  try { await work(); } catch (error) {
    ensureCrmDemo(error instanceof Error && "status" in error && error.status === expected); return;
  }
  throw new CrmDemoCaseError();
}
/** PREPARED, NOT RUN. The guarded outer owner supplies the real verified runtime;
 * there is no default connector, fake transport, private profile or retry here. */
export async function runCrmDemoCases(options: CrmDemoCaseOptions): Promise<number> {
  const { fixture, fixtureConnection: connection } = options;
  await verifyCrmDemoFixture(connection, fixture); consumeCrmDemo(fixture, "cases");
  const runtime = options.createRuntime(), services = createCrmServices(runtime.database, { issuer: syntheticCrmIssuer }), sessions: string[] = [];
  let passed = 0, failed = false;
  const check = async (name: string, work: () => Promise<void>) => { await work(); options.record(name, "mysql"); passed++; };
  try {
    const login = async (name: keyof CrmDemoFixture["identities"]) => {
      const result = await runtime.auth.login(fixture.identities[name].email, fixture.password);
      ensureCrmDemo(result.user.localUserId === fixture.identities[name].id); sessions.push(result.sessionToken); return result.sessionToken;
    };
    const operator = await login("operator"), denied = await login("denied"), worker = await login("worker"), contracting = await login("contracting"), switchgear = await login("switchgear");
    await check("synthetic login and source-scoped dashboard/pipeline reads", async () => {
      const dashboard = await services.dashboard.getDashboard(operator);
      ensureCrmDemo(dashboard.global !== undefined);
      const own = await services.leads.listPipeline(contracting);
      ensureCrmDemo(own.scope === "own" && own.items.length === 1 && own.items[0]?.id === fixture.contractingTaskId);
      await rejectStatus(() => services.jobs.getJob(denied, fixture.jobId), 403);
      await rejectStatus(() => services.leads.getLead(contracting, fixture.switchgearTaskId), 404);
    });
    await check("synthetic settings create read update and fresh permission revocation", async () => {
      const email = `created.${fixture.fixtureId.replaceAll("-", "")}@example.invalid`;
      const created = await services.settings.createUser(operator, { name: `${fixture.marker}:created`, email, password: fixture.password, status: "active" });
      ensureCrmDemo((await services.settings.getUser(operator, created.id)).email === email);
      const updated = await services.settings.updateUser(operator, created.id, { name: `${fixture.marker}:updated`, email, status: "active", version: created.version });
      ensureCrmDemo(updated.version === created.version + 1);
      await rejectStatus(() => services.settings.updateUser(operator, created.id, { name: "", email, status: "active", version: updated.version }), 400);
      const permission = (await services.settings.listPermissions(operator, { pageSize: 100 })).items.find(value => value.key === "permissions.manage");
      ensureCrmDemo(permission);
      const before = await services.settings.getGrants(operator, fixture.identities.denied.id);
      const granted = await services.settings.replaceGrants(operator, fixture.identities.denied.id, { version: before.version, permissionIds: [permission.id] });
      await services.settings.listGroups(denied);
      await services.settings.replaceGrants(operator, fixture.identities.denied.id, { version: granted.version, permissionIds: [] });
      await rejectStatus(() => services.settings.listGroups(denied), 403);
      await services.settings.setUserStatus(operator, created.id, { version: updated.version, status: "inactive" });
    });
    await check("synthetic jobs reject stale versions and serialize competing updates", async () => {
      const before = await services.jobs.getJob(operator, fixture.jobId);
      await rejectStatus(() => services.jobs.updateStatus(operator, fixture.jobId, { expectedVersion: 0, jobStatus: "Hold" }), 400);
      const changed = await services.jobs.updateRemarks(operator, fixture.jobId, { expectedVersion: before.version, remarks: fixture.marker });
      await rejectStatus(() => services.jobs.updateRemarks(operator, fixture.jobId, { expectedVersion: before.version, remarks: "stale synthetic" }), 409);
      const concurrent = await Promise.allSettled([
        services.jobs.updateRemarks(operator, fixture.jobId, { expectedVersion: changed.version, remarks: `${fixture.marker}:one` }),
        services.jobs.updateRemarks(operator, fixture.jobId, { expectedVersion: changed.version, remarks: `${fixture.marker}:two` }),
      ]);
      ensureCrmDemo(concurrent.filter(value => value.status === "fulfilled").length === 1);
      const rejected = concurrent.find(value => value.status === "rejected");
      ensureCrmDemo(rejected?.status === "rejected" && rejected.reason instanceof Error && "status" in rejected.reason && rejected.reason.status === 409);
      ensureCrmDemo((await services.jobs.getJob(operator, fixture.jobId)).version === changed.version + 1);
    });
    await check("synthetic assignment work log private attachment and denied worker access", async () => {
      const before = await services.jobs.getJob(operator, fixture.jobId);
      await services.departments.assign(operator, fixture.jobId, { expectedVersion: before.version, assignments: [{ department: "Electrical", userId: fixture.identities.worker.id }] });
      const assigned = await services.departments.getJob(worker, "Electrical", fixture.jobId);
      await rejectStatus(() => services.departments.getJob(denied, "Electrical", fixture.jobId), 403);
      const bytes = Buffer.from("47494638376101000100800000000000ffffff2c00000000010001000002024401003b", "hex");
      await services.departments.addLog(worker, "Electrical", fixture.jobId,
        { expectedVersion: assigned.version, authority: "DESIGN", status: "DRAWING PREPARATION", notes: fixture.marker },
        { name: "synthetic-log.gif", mediaType: "image/gif", content: bytes });
      const logs = await services.departments.listLogs(worker, "Electrical", fixture.jobId);
      ensureCrmDemo(logs.items.length === 1 && logs.items[0]?.attachment);
      const file = await services.departments.downloadLogAttachment(worker, logs.items[0].attachment.id);
      ensureCrmDemo(file.content.equals(bytes));
      await rejectStatus(() => services.departments.downloadLogAttachment(denied, file.id), 404);
    });
    await check("synthetic task upload download validation and audit persistence", async () => {
      const before = await services.jobs.getJob(operator, fixture.jobId), bytes = Buffer.from(fixture.marker);
      await rejectStatus(() => services.attachments.upload(operator, fixture.jobId,
        { expectedVersion: before.version, name: "blocked.php", mediaType: "text/plain" }, bytes), 415);
      const upload = await services.attachments.upload(operator, fixture.jobId,
        { expectedVersion: before.version, name: "synthetic-owned.txt", mediaType: "text/plain" }, bytes);
      const downloaded = await services.attachments.download(operator, upload.id);
      ensureCrmDemo(downloaded.content.equals(bytes));
      await rejectStatus(() => services.attachments.download(denied, upload.id), 404);
      const audit = await demoRows(connection, "SELECT attachment_id FROM crm_attachment_audit_events WHERE task_id=? AND attachment_id=?", [fixture.jobId, upload.id]);
      ensureCrmDemo(audit.length === 1);
    });
    await check("synthetic quotations render both templates and discounted edits stay blocked", async () => {
      for (const [token, taskId] of [[contracting, fixture.contractingTaskId], [switchgear, fixture.switchgearTaskId]] as const) {
        const quote = await services.commercial.getQuotation(token, taskId), pdf = await services.pdf.download(token, taskId);
        ensureCrmDemo(pdf.bytes.subarray(0, 8).toString() === "%PDF-1.7" && pdf.pages > 0);
        await rejectStatus(() => services.commercial.updateQuotation(token, taskId, { operationId: randomUUID(), expectedVersion: quote.taskVersion,
          expectedQuoteVersion: quote.version, quotation: { ...quote.quotation, items: quote.quotation.items.map(item => ({ ...item, itemDiscount: "10" })) } }), 409);
      }
      const operations = await demoRows(connection, "SELECT COUNT(*) AS total FROM crm_commercial_operations");
      ensureCrmDemo(String(operations[0]?.total) === "0");
    });
    await check("synthetic reports exports and unavailable live integration", async () => {
      const report = await services.reports.employeePerformance(operator); ensureCrmDemo(report.timeZone === "Asia/Dubai");
      const exported = await services.exports.exportJobs(operator); ensureCrmDemo(exported.bytes.length > 0 && exported.rowCount === 1);
      const capability = await services.mutations.capabilities(contracting, fixture.contractingTaskId); ensureCrmDemo(capability.integrationAvailable === false);
      await rejectStatus(() => services.mutations.changeStage(contracting, fixture.contractingTaskId,
        { operationId: randomUUID(), expectedVersion: capability.version, stage: "Closed Won" }), 503);
      const operations = await demoRows(connection, "SELECT COUNT(*) AS total FROM crm_lead_operations"); ensureCrmDemo(String(operations[0]?.total) === "0");
    });
    await check("synthetic failed DML transaction rolls back its own row", async () => {
      const email = `rollback.${fixture.fixtureId.replaceAll("-", "")}@example.invalid`;
      let failedTransaction = false;
      try {
        await runtime.database.transaction(async () => {
          await runtime.database.prepare("INSERT INTO users(username,email,password,status,role) SELECT ?,?,password,'inactive','fixture-nonadmin' FROM users WHERE id=? AND role='fixture-nonadmin'")
            .run(`${fixture.marker}:rollback`, email, fixture.identities.operator.id);
          // Deliberate invalid enum: strict mode must fail and roll back the owned row.
          await runtime.database.prepare("UPDATE users SET status=? WHERE email=?").run("invalid", email);
        })();
      } catch { failedTransaction = true; }
      ensureCrmDemo(failedTransaction);
      const found = await demoRows(connection, "SELECT id FROM users WHERE email=?", [email]); ensureCrmDemo(found.length === 0);
    });
    const historicalBefore = JSON.stringify(await Promise.all([fixture.contractingTaskId, fixture.switchgearTaskId]
      .map(id => services.commercial.getQuotation(operator, id))));
    await runCrmDemoNativeWrites({ services, servicesForIssuer: issuer => createCrmServices(runtime.database, { issuer }),
      operator, denied, marker: fixture.marker, check });
    const historicalAfter = JSON.stringify(await Promise.all([fixture.contractingTaskId, fixture.switchgearTaskId]
      .map(id => services.commercial.getQuotation(operator, id))));
    ensureCrmDemo(historicalAfter === historicalBefore);
    await verifyCrmDemoFixture(connection, fixture);
  } catch { failed = true; }
  // Only service logout of tokens created above; no fixture row cleanup or reset.
  for (const token of sessions) { try { await runtime.auth.logout(token); } catch { failed = true; } }
  try { await runtime.close(); } catch { failed = true; }
  if (failed) throw new CrmDemoCaseError();
  return passed;
}
