import { Router, type Request, type Response } from "express";
import { CENTRAL_JOB_COHORTS, logAttachmentLimit, type CentralJobPage, type CreatedDealsPage, type CrmWriteCapabilities } from "@voltronix/crm-contracts";
import { authCookiePolicy } from "../auth/http.js";
import { validToken } from "../auth/tokens.js";
import type { MysqlDatabase } from "./db/mysql/database.js";
import { AuthError, createAuthService, type AuthUser } from "./auth/service.js";
import { createDashboardService, DashboardError } from "./dashboard/service.js";
import { createLeadsService, LeadsError } from "./leads/service.js";
import { createLeadMutationsService, LeadMutationError } from "./lead-mutations/service.js";
import type { ZohoTransport } from "./lead-mutations/contracts.js";
import type { AccountPayloadProfile, DealPayloadProfile } from "./commercial/deals.js";
import type { StagePayloadProfile } from "./lead-mutations/stage-profile.js";
import type { NativeZohoContext } from "../integrations/zoho/native-numbering.js";
import { assertZohoActorBinding } from "../integrations/zoho/user-binding.js";
import { createCommercialService, CommercialPersistenceError } from "./commercial/service.js";
import type { CommercialTransport } from "./commercial/transport.js";
import { createJobsService, JobsError } from "./jobs/service.js";
import { createDepartmentsService, DepartmentsError } from "./departments/service.js";
import { createAttachmentsService, AttachmentError, MAX_ATTACHMENT_BYTES } from "./attachments/service.js";
import { createReportsService, ReportError } from "./reports/service.js";
import { createExportsService, ExportsError, type JobExport } from "./exports/service.js";
import { createSettingsService, SettingsError } from "./settings/service.js";
import { createQuotationPdfService } from "./quotation-pdf/service.js";
import { createSourceReads, SourceReadError } from "./source-reads/service.js";
import { QuotationPdfError, type LocalQuotationIssuer } from "./quotation-pdf/render.js";
import { createLocalWorkflowService, LocalWorkflowError } from "./local-workflow/service.js";
import { createLocalMysqlWrites } from "./local-workflow/writes.js";
import { createLocalWorkflowReads } from "./local-workflow/reads.js";
import { taskSyncSource, withTaskSyncSource, withTaskSyncPage } from "./zoho-sync/provenance.js";
import { createZohoSyncReads, ZohoSyncReadError } from "./zoho-sync/service.js";
import { closeUnreadRequest, CrmHttpError, crmQuery, csrfChallenge, hasUnexpectedFields, originCheck, readJson, readMultipart, selectedCookies, sendPrivateFile, sendPrivatePreview } from "./http.js";

export type CrmIntegration = { leads: ZohoTransport; commercial: CommercialTransport; accountOwnerId: string;
  accountPayloadProfile?: AccountPayloadProfile; dealPayloadProfile?: DealPayloadProfile; dealPipeline?: string; stagePayloadProfile?: StagePayloadProfile;
  production?: NativeZohoContext };

/** Pure construction. Integration is an explicit dependency, never an environment
 * selector or an automatic conversion of existing local records. */
export function createCrmServices<Integration extends CrmIntegration | undefined = undefined>(database: MysqlDatabase,
  options: { issuer?: LocalQuotationIssuer; integration?: Integration } = {}) {
  const integration = options.integration;
  const commercial = createCommercialService(database, integration ? { transport: integration.commercial,
    ...(integration.production ? { production: integration.production } : {}),
    ...(integration.dealPipeline === undefined ? {} : { dealPipeline: integration.dealPipeline }),
    ...(options.issuer ? { issuer: options.issuer } : {}) } : {});
  const mutations = createLeadMutationsService(database, integration ? { transport: integration.leads, accountOwnerId: integration.accountOwnerId,
    ...(integration.accountPayloadProfile === undefined ? {} : { accountPayloadProfile: integration.accountPayloadProfile }),
    ...(integration.dealPipeline === undefined ? {} : { dealPipeline: integration.dealPipeline }),
    ...(integration.dealPayloadProfile === undefined ? {} : { dealPayloadProfile: integration.dealPayloadProfile }),
    ...(integration.stagePayloadProfile === undefined ? {} : { stagePayloadProfile: integration.stagePayloadProfile }),
    ...(integration.production ? { production: integration.production } : {}) } : {});
  const auth = createAuthService(database), leads = createLeadsService(database);
  const workflow = createLocalWorkflowService(database, options), writes = createLocalMysqlWrites(database);
  const reads = createLocalWorkflowReads(database, workflow, leads, commercial);
  const jobs = createJobsService(database), departments = createDepartmentsService(database);
  const sourceReads = createSourceReads(database, { localOwnership: true });
  async function dispatchTask<T>(id: unknown, remote: () => Promise<T>, local: () => Promise<T>): Promise<T> {
    // Local selection, provenance validation and mutation remain atomic. A failed
    // local operation never falls back to remote. The remote service revalidates
    // authorization, identity and versions in its own committed reservation.
    const selected = await database.transaction(async () => await workflow.isLocal(id)
      ? { local: true as const, result: await local() } : { local: false as const })();
    // Do not wrap remote I/O in the selection transaction: its reservation and
    // reconciliation journal must survive a later remote or local-commit failure.
    return selected.local ? selected.result : remote();
  }
  // Preserve the default factory's local result types. Explicit remote creation
  // returns provider-backed receipts and never claims local-only persistence.
  const createProduct = (integration ? commercial.createProduct : writes.createProduct) as
    Integration extends undefined ? typeof writes.createProduct : typeof commercial.createProduct;
  const createDeal = (integration ? mutations.createDeal : workflow.createDeal) as
    Integration extends undefined ? typeof workflow.createDeal : typeof mutations.createDeal;
  const localCommercial = { ...commercial, getQuotation: reads.getQuotation, listQuotations: reads.listQuotations,
    listQuotationCandidates: reads.listQuotationCandidates, createProduct,
    quotationCapabilities: (...args: Parameters<typeof commercial.quotationCapabilities>) => database.transaction(async () => {
      const capabilities = await workflow.isLocal(args[1]) ? await workflow.quoteCapabilities(...args) : await commercial.quotationCapabilities(...args);
      const sourceImport = await taskSyncSource(database, String(args[1]));
      return sourceImport ? { ...capabilities, sourceImport, canCreate: false, canEdit: false } : capabilities;
    })(),
    createQuotation: (...args: Parameters<typeof commercial.createQuotation>) => dispatchTask(args[1],
      () => commercial.createQuotation(...args), () => workflow.createQuotation(...args)),
    updateQuotation: (...args: Parameters<typeof commercial.updateQuotation>) => dispatchTask(args[1],
      () => commercial.updateQuotation(...args), () => workflow.updateQuotation(...args)),
  };
  return { auth: { ...auth, getAuthorizedTask: (...args: Parameters<typeof auth.getAuthorizedTask>) => database.transaction(async () => {
      if (!await workflow.isLocal(args[1])) return auth.getAuthorizedTask(...args);
      const row = await reads.getLead(...args); return { id: row.id, dealName: row.dealName, status: row.status };
    })() }, dashboard: createDashboardService(database, { localOwnership: true }), leads: { ...leads,
      getLead: (...args: Parameters<typeof reads.getLead>) => database.transaction(async () => withTaskSyncSource(database, await reads.getLead(...args), String(args[1])))(),
      listPipeline: (...args: Parameters<typeof reads.listPipeline>) => database.transaction(async () => withTaskSyncPage(database, await reads.listPipeline(...args)))(),
      listNotes: reads.listNotes, listStatusHistory: reads.listStatusHistory },
    mutations: { ...mutations, createDeal,
      changeStage: (...args: Parameters<typeof mutations.changeStage>) => dispatchTask(args[1],
        () => mutations.changeStage(...args), () => workflow.changeStage(...args)),
      addNote: (...args: Parameters<typeof mutations.addNote>) => dispatchTask(args[1],
        () => mutations.addNote(...args), () => workflow.addNote(...args)),
      editNote: (...args: Parameters<typeof mutations.editNote>) => dispatchTask(args[1],
        () => mutations.editNote(...args), () => workflow.editNote(...args)),
      capabilities: (...args: Parameters<typeof mutations.capabilities>) => database.transaction(async () => {
        if (await workflow.isLocal(args[1])) return workflow.capabilities(...args);
        const capabilities = await mutations.capabilities(...args);
        const sourceImport = await taskSyncSource(database, String(args[1]));
        if (sourceImport) return { ...capabilities, sourceImport, canWriteNotes: false, canChangeStage: false, stages: [] };
        return integration ? capabilities : { ...capabilities, canWriteNotes: false }; // No local-only edits to remote notes.
      })(),
    }, commercial: localCommercial, jobs: { ...jobs,
      getJob: (...args: Parameters<typeof jobs.getJob>) => database.transaction(async () => withTaskSyncSource(database, await jobs.getJob(...args), String(args[1])))(),
      listJobs: (...args: Parameters<typeof jobs.listJobs>) => database.transaction(async () => withTaskSyncPage(database, await jobs.listJobs(...args)))(),
    }, departments: { ...departments,
      getAssignments: (...args: Parameters<typeof departments.getAssignments>) => database.transaction(async () => withTaskSyncSource(database, await departments.getAssignments(...args), String(args[1])))(),
      getJob: (...args: Parameters<typeof departments.getJob>) => database.transaction(async () => withTaskSyncSource(database, await departments.getJob(...args), String(args[2])))(),
      listQueue: (...args: Parameters<typeof departments.listQueue>) => database.transaction(async () => withTaskSyncPage(database, await departments.listQueue(...args)))(),
    }, attachments: createAttachmentsService(database, {
      authorizeLocalTask: async (user, id) => {
        try { return await workflow.isLocal(id) && (await workflow.task(user, id)).ownerId === user.localUserId; }
        catch (error) { if (error instanceof LocalWorkflowError && error.status === 404) return false; throw error; }
      },
    }), reports: createReportsService(database, { localOwnership: true }), exports: createExportsService(database), settings: createSettingsService(database),
    pdf: createQuotationPdfService(localCommercial), sync: createZohoSyncReads(database), localReads: { ...sourceReads,
      listJobs: (...args: Parameters<typeof sourceReads.listJobs>) => database.transaction(async () => withTaskSyncPage(database, await sourceReads.listJobs(...args)))(),
    }, localWrites: {
      capabilities: async (...args: Parameters<typeof writes.capabilities>): Promise<CrmWriteCapabilities> => {
        const capabilities = await writes.capabilities(...args);
        if (integration?.production) {
          const user = await auth.authenticate(args[0]);
          let bound = false;
          if (user) { try { await assertZohoActorBinding(database, user, integration.production.organizationId); bound = true; } catch { /* unavailable actor mapping */ } }
          return { persistence: "zoho", integrationAvailable: true, remoteWorkflow: true, localWorkflow: true,
            productCreate: bound && capabilities.productCreate, dealCreate: bound && !!user?.permissions.includes("deals.manage"),
            leadNotes: bound && capabilities.leadNotes };
        }
        // This injection seam is not UI activation. The current global DTO and
        // forms describe local-only persistence; never label remote creates as local.
        return integration ? { persistence: "unavailable", productCreate: false, dealCreate: false,
          leadNotes: false, localWorkflow: false, integrationAvailable: false } : capabilities;
      },
    } };
}
export type CrmServices = {
  auth: ReturnType<typeof createAuthService>;
  dashboard: ReturnType<typeof createDashboardService>;
  leads: ReturnType<typeof createLeadsService>;
  mutations: ReturnType<typeof createLeadMutationsService>;
  commercial: ReturnType<typeof createCommercialService>;
  jobs: ReturnType<typeof createJobsService>;
  departments: ReturnType<typeof createDepartmentsService>;
  attachments: ReturnType<typeof createAttachmentsService>;
  reports: ReturnType<typeof createReportsService>;
  exports: ReturnType<typeof createExportsService>;
  settings: ReturnType<typeof createSettingsService>;
  pdf: ReturnType<typeof createQuotationPdfService>;
  sync?: ReturnType<typeof createZohoSyncReads>;
  /** Explicit local persistence; never a remote synchronization acknowledgement. */
  localWrites?: { capabilities(token: string): Promise<CrmWriteCapabilities> };
  /** Source-backed lists supplied by MySQL or the explicit SQLite demo composition. */
  localReads?: {
    listCreatedDeals(token: string, input: unknown): Promise<CreatedDealsPage>;
    listJobs(token: string, input: unknown): Promise<CentralJobPage>;
    exportJobs(token: string, input: unknown): Promise<JobExport>;
  };
};
type Method = "GET" | "POST" | "PATCH" | "PUT";
type Context = { services: CrmServices; request: Request; response: Response; token: string; body: unknown; user: AuthUser };
type Route = { method: Method; path: string; action: (context: Context) => unknown | Promise<unknown>;
  permissions?: readonly string[]; anyPermissions?: readonly string[]; readOrigin?: false;
  body?: "json" | "product" | "quotation" | "attachment" | "log"; status?: number; noQuery?: boolean };
const page = ["page", "pageSize"];
const search = (request: Request) => crmQuery(request, ["query"], page);
const commercialSearch = (request: Request) => crmQuery(request, ["query", "sort", "direction"], page);
function settingsSearch(request: Request) {
  try { return search(request); } catch (error) {
    if (error instanceof CrmHttpError && error.status === 400) throw new CrmHttpError(400, "Invalid search parameters.");
    throw error;
  }
}
const empty = (request: Request) => crmQuery(request, [], []);
function id(request: Request, name = "id"): string {
  const value = request.params[name]; if (typeof value !== "string") throw new CrmHttpError(404, "Record not found."); return value;
}
const userAdmin = ["users.write", "permissions.manage"], catalogAdmin = ["permissions.manage"], manager = ["dashboard.view"];
const leadWriters = ["leads.manage", "leads.manage.agents"];
const routes: Route[] = [];
function route(method: Method, path: string, action: Route["action"], options: Omit<Route, "method" | "path" | "action"> = {}) {
  routes.push({ method, path: `/api/v1${path}`, action, ...options });
}

route("GET", "/tasks/:id", async ({ services: s, token, request: r }) => ({ task: await s.auth.getAuthorizedTask(token, id(r)) }), { readOrigin: false });
route("GET", "/capabilities", async ({ services: s, token }) => {
  const writes = await s.localWrites?.capabilities(token) ?? {
    persistence: "unavailable", productCreate: false, leadNotes: false, integrationAvailable: false,
  } satisfies CrmWriteCapabilities;
  return { ...writes, ...(s.localReads ? { jobCohorts: true } : {}), ...(s.sync ? { zohoInbound: true } : {}) };
}, { noQuery: true });
route("GET", "/dashboard", ({ services: s, token, request: r }) => s.dashboard.getDashboard(token, crmQuery(r, ["employeeSearch"], ["employeePage", "employeePageSize"])));
route("GET", "/pipeline", ({ services: s, token, request: r }) => s.leads.listPipeline(token, crmQuery(r, ["query", "stage", "agentId", "scope"], page)));
route("GET", "/pipeline/agents", ({ services: s, token, request: r }) => s.leads.listAgents(token, crmQuery(r, ["query", "scope"], page)));
route("GET", "/zoho-sync/quotations", ({ services: s, token, request: r }) => {
  if (!s.sync) throw new CrmHttpError(503, "Synchronized records are unavailable.");
  return s.sync.listQuotations(token, crmQuery(r, ["query", "taskId"], page));
});
route("GET", "/zoho-sync/status", ({ services: s, token }) => {
  if (!s.sync) throw new CrmHttpError(503, "Synchronized records are unavailable.");
  return s.sync.status(token);
}, { noQuery: true });
route("GET", "/leads/:id", async ({ services: s, token, request: r }) => { const result = await s.leads.getLead(token, id(r)); empty(r); return result; });
route("GET", "/leads/:id/notes", ({ services: s, token, request: r }) => s.leads.listNotes(token, id(r), crmQuery(r, [], page)));
route("GET", "/leads/:id/history", ({ services: s, token, request: r }) => s.leads.listStatusHistory(token, id(r), crmQuery(r, [], page)));
route("GET", "/leads/:id/capabilities", ({ services: s, token, request: r }) => s.mutations.capabilities(token, id(r)), { noQuery: true });
route("POST", "/leads/:id/notes", ({ services: s, token, request: r, body }) => s.mutations.addNote(token, id(r), body), { body: "json", anyPermissions: leadWriters, noQuery: true });
route("PATCH", "/leads/:id/notes/:noteId", ({ services: s, token, request: r, body }) => s.mutations.editNote(token, id(r), id(r, "noteId"), body), { body: "json", anyPermissions: leadWriters, noQuery: true });
route("PATCH", "/leads/:id/stage", ({ services: s, token, request: r, body }) => s.mutations.changeStage(token, id(r), body), { body: "json", anyPermissions: leadWriters, noQuery: true });
route("POST", "/deals", ({ services: s, token, body }) => s.mutations.createDeal(token, body), { body: "json", permissions: ["deals.manage"], noQuery: true });
route("GET", "/deals", ({ services: s, token, request: r }) => {
  const query = search(r);
  if (!s.localReads) throw new CrmHttpError(503, "CRM-created deals are unavailable in this runtime.");
  return s.localReads.listCreatedDeals(token, query);
}, { permissions: ["deals.view"] });

route("GET", "/items", async ({ services: s, token, request: r }) => {
  const result = await s.commercial.listProducts(token, commercialSearch(r)); return { ...result, items: result.items.map(item => ({ ...item, id: item.externalId })) };
});
route("POST", "/items", ({ services: s, token, body, request: r }) => { empty(r); return s.commercial.createProduct(token, body); }, { body: "product", permissions: ["items.write"] });
route("GET", "/items/:id", ({ services: s, token, request: r }) => { empty(r); return s.commercial.getProduct(token, id(r)); });
route("GET", "/quotations", ({ services: s, token, request: r }) => s.commercial.listQuotations(token, commercialSearch(r)));
route("GET", "/quotations/candidates", async ({ services: s, token, request: r }) => {
  const result = await s.commercial.listQuotationCandidates(token, search(r)); return { ...result, items: result.items.map(item => ({ ...item, id: item.taskId })) };
});
route("POST", "/quotations", ({ services: s, token, request: r, body }) => {
  empty(r);
  if (typeof body !== "object" || body === null || Array.isArray(body) || !("taskId" in body) || typeof body.taskId !== "string") throw new CrmHttpError(400, "Invalid quotation request.");
  const { taskId, ...input } = body; return s.commercial.createQuotation(token, taskId, input);
}, { body: "quotation", anyPermissions: leadWriters });
route("GET", "/quotations/:taskId", ({ services: s, token, request: r }) => { empty(r); return s.commercial.getQuotation(token, id(r, "taskId")); });
route("PATCH", "/quotations/:taskId", ({ services: s, token, request: r, body }) => { empty(r); return s.commercial.updateQuotation(token, id(r, "taskId"), body); }, { body: "quotation", anyPermissions: leadWriters });
route("GET", "/quotations/:taskId/capabilities", ({ services: s, token, request: r }) => { empty(r); return s.commercial.quotationCapabilities(token, id(r, "taskId")); });
route("GET", "/quotations/:taskId/pdf", async ({ services: s, token, request: r, response }) => {
  empty(r); const file = await s.pdf.download(token, id(r, "taskId")); sendPrivateFile(response, file.bytes, "application/pdf", file.filename, true);
});

route("GET", "/jobs", ({ services: s, token, request: r }) => {
  const query = crmQuery(r, ["query", "jobStatus", "cohort"], page), { cohort, ...legacyQuery } = query;
  if (cohort !== undefined && !CENTRAL_JOB_COHORTS.some(value => value === cohort)) throw new CrmHttpError(400, "Invalid job input.");
  if (s.localReads) return s.localReads.listJobs(token, query);
  if (cohort !== undefined && cohort !== "all") throw new CrmHttpError(503, "Job cohorts are unavailable in this runtime.");
  return s.jobs.listJobs(token, legacyQuery);
}, { permissions: manager });
route("GET", "/jobs/export", async ({ services: s, token, request: r, response }) => {
  const query = crmQuery(r, ["query", "jobStatus", "cohort"], []), { cohort, ...legacyQuery } = query;
  if (cohort !== undefined && !CENTRAL_JOB_COHORTS.some(value => value === cohort)) throw new CrmHttpError(400, "Invalid export input.");
  if (!s.localReads && cohort !== undefined && cohort !== "all") throw new CrmHttpError(503, "Job cohort exports are unavailable in this runtime.");
  const file = await (s.localReads ? s.localReads.exportJobs(token, query) : s.exports.exportJobs(token, legacyQuery));
  sendPrivateFile(response, file.bytes, file.contentType, file.filename, true);
}, { permissions: manager });
route("GET", "/jobs/:id", async ({ services: s, token, request: r }) => { const result = await s.jobs.getJob(token, id(r)); empty(r); return result; }, { permissions: manager });
route("PATCH", "/jobs/:id/status", ({ services: s, token, request: r, body }) => { empty(r); return s.jobs.updateStatus(token, id(r), body); }, { body: "json", permissions: manager });
route("PATCH", "/jobs/:id/remarks", ({ services: s, token, request: r, body }) => { empty(r); return s.jobs.updateRemarks(token, id(r), body); }, { body: "json", permissions: manager });
route("GET", "/jobs/:id/assignments", ({ services: s, token, request: r }) => { empty(r); return s.departments.getAssignments(token, id(r)); });
route("POST", "/jobs/:id/assignments", ({ services: s, token, request: r, body }) => { empty(r); return s.departments.assign(token, id(r), body); }, { body: "json" });
route("POST", "/jobs/:id/accounts", ({ services: s, token, request: r, body }) => { empty(r); return s.departments.assignAccounts(token, id(r), body); }, { body: "json" });
route("POST", "/jobs/:id/unassign", ({ services: s, token, request: r, body }) => { empty(r); return s.departments.unassign(token, id(r), body); }, { body: "json" });
route("GET", "/jobs/:id/logs", ({ services: s, token, request: r }) => {
  const q = crmQuery(r, ["department"], page); return s.departments.listJobLogs(token, id(r), q.department, { page: q.page, pageSize: q.pageSize });
});
route("GET", "/departments/:department/assignees", ({ services: s, token, request: r }) => s.departments.listAssignees(token, id(r, "department"), search(r)));
route("GET", "/departments/:department/jobs", ({ services: s, token, request: r }) => s.departments.listQueue(token, id(r, "department"), crmQuery(r, ["query", "status"], page)));
route("GET", "/departments/:department/jobs/:id", ({ services: s, token, request: r }) => { empty(r); return s.departments.getJob(token, id(r, "department"), id(r)); });
route("GET", "/departments/:department/jobs/:id/logs", ({ services: s, token, request: r }) => s.departments.listLogs(token, id(r, "department"), id(r), crmQuery(r, [], page)));
route("POST", "/departments/:department/jobs/:id/logs", async ({ services: s, token, request: r, response, body }) => {
  empty(r);
  if ((r.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    await s.departments.authorizeLog(token, id(r, "department"), id(r));
    const form = await readMultipart(r, response, 32768, logAttachmentLimit(id(r, "department")));
    if (hasUnexpectedFields(form, ["payload", "file"]) || form.getAll("payload").length !== 1 || form.getAll("file").length > 1) throw new AttachmentError(400);
    const payload = form.get("payload"), file = form.get("file");
    if (typeof payload !== "string" || Buffer.byteLength(payload, "utf8") > 30000) throw new AttachmentError(400);
    let parsed: unknown; try { parsed = JSON.parse(payload) as unknown; } catch { throw new AttachmentError(400); }
    if (file === null) return s.departments.addLog(token, id(r, "department"), id(r), parsed);
    if (!(file instanceof File) || file.size === 0) throw new AttachmentError(400);
    if (file.size > logAttachmentLimit(id(r, "department"))) throw new AttachmentError(413);
    return s.departments.addLog(token, id(r, "department"), id(r), parsed, { name: file.name, mediaType: file.type, content: Buffer.from(await file.arrayBuffer()) });
  }
  return s.departments.addLog(token, id(r, "department"), id(r), body);
}, { body: "log" });
route("PATCH", "/departments/:department/jobs/:id/status", ({ services: s, token, request: r, body }) => { empty(r); return s.departments.updateStatus(token, id(r, "department"), id(r), body); }, { body: "json" });
route("GET", "/departments/:department/export", async ({ services: s, token, request: r, response }) => {
  const file = await s.exports.exportDepartmentJobs(token, id(r, "department"), crmQuery(r, ["query", "jobStatus"], [])); sendPrivateFile(response, file.bytes, file.contentType, file.filename, true);
});
route("GET", "/leads/:id/attachments", ({ services: s, token, request: r }) => s.attachments.list(token, id(r), crmQuery(r, [], page)));
route("POST", "/leads/:id/attachments", async ({ services: s, token, request: r, response }) => {
  empty(r); await s.attachments.authorizeUpload(token, id(r));
  const form = await readMultipart(r, response);
  if (hasUnexpectedFields(form, ["file", "expectedVersion"]) || form.getAll("file").length !== 1 || form.getAll("expectedVersion").length !== 1) throw new AttachmentError(400);
  const file = form.get("file"), version = form.get("expectedVersion");
  if (!(file instanceof File) || typeof version !== "string" || !/^[1-9][0-9]{0,15}$/.test(version)) throw new AttachmentError(400);
  if (file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentError(413);
  return s.attachments.upload(token, id(r), { expectedVersion: Number(version), name: file.name, mediaType: file.type }, Buffer.from(await file.arrayBuffer()));
}, { body: "attachment" });
route("GET", "/attachments/:id", async ({ services: s, token, request: r, response }) => { empty(r); const file = await s.attachments.download(token, id(r)); sendPrivateFile(response, file.content, file.mediaType, file.name); });
route("GET", "/attachments/:id/preview", async ({ services: s, token, request: r, response }) => { empty(r); const file = await s.attachments.download(token, id(r)); sendPrivatePreview(response, file); });
route("GET", "/log-attachments/:id", async ({ services: s, token, request: r, response }) => { empty(r); const file = await s.departments.downloadLogAttachment(token, id(r)); sendPrivateFile(response, file.content, file.mediaType, file.name); });
route("GET", "/log-attachments/:id/preview", async ({ services: s, token, request: r, response }) => { empty(r); const file = await s.departments.downloadLogAttachment(token, id(r)); sendPrivatePreview(response, file, "log"); });
route("GET", "/reports/employee-performance", ({ services: s, token, request: r }) => s.reports.employeePerformance(token, crmQuery(r, ["dateFrom", "dateTo", "query"], page)), { permissions: manager });

const settingsRead = { readOrigin: false as const, permissions: catalogAdmin };
route("GET", "/settings/grant-users", ({ services: s, token, request: r }) => s.settings.listGrantUsers(token, settingsSearch(r)), settingsRead);
route("GET", "/settings/permission-groups", ({ services: s, token, request: r }) => s.settings.listGroups(token, settingsSearch(r)), settingsRead);
route("POST", "/settings/permission-groups", ({ services: s, token, body }) => s.settings.createGroup(token, body), { body: "json", permissions: catalogAdmin, status: 201 });
route("GET", "/settings/permission-groups/:id", ({ services: s, token, request: r }) => s.settings.getGroup(token, id(r)), settingsRead);
route("PATCH", "/settings/permission-groups/:id", ({ services: s, token, request: r, body }) => s.settings.updateGroup(token, id(r), body), { body: "json", permissions: catalogAdmin });
route("GET", "/settings/permissions", ({ services: s, token, request: r }) => s.settings.listPermissions(token, settingsSearch(r)), settingsRead);
route("POST", "/settings/permissions", ({ services: s, token, body }) => s.settings.createPermission(token, body), { body: "json", permissions: catalogAdmin, status: 201 });
route("GET", "/settings/permissions/:id", ({ services: s, token, request: r }) => s.settings.getPermission(token, id(r)), settingsRead);
route("PATCH", "/settings/permissions/:id", ({ services: s, token, request: r, body }) => s.settings.updatePermission(token, id(r), body), { body: "json", permissions: catalogAdmin });
route("GET", "/settings/users", ({ services: s, token, request: r }) => s.settings.listUsers(token, settingsSearch(r)), { ...settingsRead, permissions: userAdmin });
route("GET", "/settings/zoho-users", ({ services: s, token, request: r }) => {
  if (!s.sync) throw new CrmHttpError(503, "Synchronized records are unavailable.");
  return s.sync.listDirectory(token, settingsSearch(r));
}, { ...settingsRead, permissions: userAdmin });
route("POST", "/settings/users", ({ services: s, token, body }) => s.settings.createUser(token, body), { body: "json", permissions: userAdmin, status: 201 });
route("GET", "/settings/users/:id", ({ services: s, token, request: r }) => s.settings.getUser(token, id(r)), { ...settingsRead, permissions: userAdmin });
route("PATCH", "/settings/users/:id", ({ services: s, token, request: r, body }) => s.settings.updateUser(token, id(r), body), { body: "json", permissions: userAdmin });
route("POST", "/settings/users/:id/status", ({ services: s, token, request: r, body }) => s.settings.setUserStatus(token, id(r), body), { body: "json", permissions: userAdmin });
route("PUT", "/settings/users/:id/department", ({ services: s, token, request: r, body }) => s.settings.assignDepartment(token, id(r), body), { body: "json", permissions: userAdmin });
route("GET", "/settings/users/:id/permissions", ({ services: s, token, request: r }) => s.settings.getGrants(token, id(r)), settingsRead);
route("PUT", "/settings/users/:id/permissions", ({ services: s, token, request: r, body }) => s.settings.replaceGrants(token, id(r), body), { body: "json", permissions: catalogAdmin });

export const CRM_ROUTES = Object.freeze(routes.map(({ method, path }) => Object.freeze({ method, path })));
const domainErrors = [CrmHttpError, AuthError, DashboardError, LeadsError, LeadMutationError, CommercialPersistenceError, JobsError, DepartmentsError, AttachmentError, ReportError, ExportsError, SettingsError, QuotationPdfError, SourceReadError, LocalWorkflowError, ZohoSyncReadError];

/** No injected integration transport exists here. Runtime writes that depend on
 * Zoho and discounted quote edits keep the source service's server-side blocks. */
export function createCrmRouter(origin: string, database?: MysqlDatabase) {
  return createCrmRouterWithServices(origin, database ? createCrmServices(database) : undefined);
}
/** Explicit injection for offline transport tests; never selected by environment. */
export function createCrmRouterWithServices(origin: string, services?: CrmServices) {
  const router = Router({ strict: true, caseSensitive: true }), policy = authCookiePolicy(origin);
  for (const path of new Set(routes.map(value => value.path))) {
    const matches = routes.filter(value => value.path === path);
    router.all(path, async (request, response) => {
      response.setHeader("Cache-Control", "no-store"); response.vary("Cookie");
      try {
        if (!services) throw new CrmHttpError(503, "The service is temporarily unavailable.");
        // Preserve explicit methods. HEAD is a protected, bodyless GET; OPTIONS
        // is never an automatic unauthenticated CORS or method-discovery bypass.
        const current = matches.find(value => value.method === (request.method === "HEAD" ? "GET" : request.method));
        if (!current) {
          response.setHeader("Allow", matches.flatMap(value => value.method === "GET" ? ["GET", "HEAD"] : [value.method]).join(", "));
          throw new CrmHttpError(405, "Method not allowed.");
        }
        const write = current.method !== "GET";
        if (write || current.readOrigin !== false) originCheck(request, origin, write);
        const cookies = selectedCookies(request, policy), token = cookies.token;
        if (!validToken(token)) throw new CrmHttpError(401, "Sign in required.");
        const user = await services.auth.authenticate(token);
        if (!user) throw new CrmHttpError(401, "Sign in required.");
        if (current.permissions?.some(permission => !user.permissions.includes(permission)) ||
          (current.anyPermissions && !current.anyPermissions.some(permission => user.permissions.includes(permission)))) throw new CrmHttpError(403, "Access denied.");
        if (write && !await services.auth.verifySessionCsrf(token, csrfChallenge(request, cookies.csrf))) throw new CrmHttpError(403, "Request not permitted.");
        if (current.noQuery) empty(request);
        let body: unknown;
        if (current.body && current.body !== "attachment" && !(current.body === "log" && (request.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data"))) {
          body = await readJson(request, response, current.body === "quotation" ? 262144 : current.body === "product" ? 65536 : 8192);
        }
        const result = await current.action({ services, request, response, token, body, user });
        if (!response.headersSent) response.status(current.status ?? 200).json(result);
      } catch (error) {
        if (response.headersSent || response.writableEnded || response.destroyed) return;
        closeUnreadRequest(request, response);
        const known = domainErrors.some(type => error instanceof type);
        const safe = known ? error as CrmHttpError : new CrmHttpError(503, "The service is temporarily unavailable.");
        response.status(safe.status).json({ error: safe.message });
      }
    });
  }
  return router;
}
