import type { SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { createAuthService, AuthError } from "../../tests/sqlite-reference/auth/service.js";
import { DashboardError } from "../../tests/sqlite-reference/dashboard/service.js";
import { createLeadsService, LeadsError } from "../../tests/sqlite-reference/leads/service.js";
import { createLeadMutationsService, LeadMutationError } from "../../tests/sqlite-reference/lead-mutations/service.js";
import { createJobsService, JobsError } from "../../tests/sqlite-reference/jobs/service.js";
import { createDepartmentsService, DepartmentsError } from "../../tests/sqlite-reference/departments/service.js";
import { AttachmentError } from "../../tests/sqlite-reference/attachments/service.js";
import { ReportError } from "../../tests/sqlite-reference/reports/service.js";
import { createExportsService, ExportsError } from "../../tests/sqlite-reference/exports/service.js";
import { createSettingsService, SettingsError } from "../../tests/sqlite-reference/settings/service.js";
import { createCommercialService, CommercialPersistenceError } from "../../tests/sqlite-reference/commercial/service.js";
import { createQuotationPdfService } from "../src/crm/quotation-pdf/service.js";
import { QuotationPdfError } from "../src/crm/quotation-pdf/render.js";
import { CrmHttpError } from "../src/crm/http.js";
import type { CrmServices } from "../src/crm/router.js";
import type { SqliteExecutor } from "./auth-store.js";
import { createLocalDemoWrites, LocalWriteError } from "./local-writes.js";
import { createLocalDemoReads, LocalReadError } from "./local-reads.js";
import { createLocalWorkflowService, LocalWorkflowError } from "./workflow-service.js";
import { createLocalWorkflowReads } from "./workflow-reads.js";
import { createLocalAttachmentsService } from "./local-attachments.js";
import { createLocalOwnerReports } from "./local-owner-reports.js";
import { createZohoImportGuard, ZohoImportReadOnlyError } from "./zoho-import-guard.js";

const knownErrors = [AuthError, DashboardError, LeadsError, LeadMutationError, JobsError, DepartmentsError,
  AttachmentError, ReportError, ExportsError, SettingsError, CommercialPersistenceError, QuotationPdfError, LocalWriteError, LocalReadError, LocalWorkflowError, ZohoImportReadOnlyError];
type AsyncMethods<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never };

/** Only errors created by these reviewed domain classes cross the HTTP boundary.
 * An arbitrary SQLite/driver error or object with a status field stays opaque. */
export function sqliteDomainError(error: unknown): CrmHttpError {
  if (knownErrors.some(type => error instanceof type)) {
    const safe = error as InstanceType<(typeof knownErrors)[number]>;
    return new CrmHttpError(safe.status, safe.message);
  }
  return new CrmHttpError(503, "The service is temporarily unavailable.");
}
function queued<T extends object>(service: T, executor: SqliteExecutor): AsyncMethods<T> {
  const methods = Object.fromEntries(Object.entries(service).map(([name, method]) => {
    if (typeof method !== "function") throw new Error("Invalid SQLite service composition.");
    return [name, async (...args: unknown[]) => {
      try { return await executor.run(() => Reflect.apply(method, service, args)); }
      catch (error) { throw sqliteDomainError(error); }
    }];
  }));
  return methods as AsyncMethods<T>;
}

/** Reuse the complete SQLite services without copying or translating MySQL SQL.
 * This file belongs only to the explicit local demo entrypoint, never dist or
 * production provider selection. No remote integration transport is injected. */
export function createSqliteCrmServices(db: SqliteDatabase, executor: SqliteExecutor): CrmServices {
  const commercial = createCommercialService(db), mutations = createLeadMutationsService(db), local = createLocalDemoWrites(db);
  const departments = createDepartmentsService(db), jobs = createJobsService(db);
  const auth = createAuthService(db), leads = createLeadsService(db), workflow = createLocalWorkflowService(db);
  const reads = createLocalWorkflowReads(db, workflow, leads, commercial);
  const ownerReports = createLocalOwnerReports(db);
  const imported = createZohoImportGuard(db), attachments = createLocalAttachmentsService(db, workflow), localReads = createLocalDemoReads(db);
  // UUIDs cannot be reused across old local writes and the new workflow journal.
  function existingWrite<T>(input: unknown, work: () => T): T {
    if (workflow.enabled && input && typeof input === "object" && "operationId" in input && typeof input.operationId === "string"
      && db.prepare("SELECT 1 FROM crm_demo_local_operations WHERE operation_id=?").get(input.operationId)) throw new LocalWorkflowError(409);
    return work();
  }
  const localCommercial = { ...commercial, getQuotation: reads.getQuotation, listQuotations: reads.listQuotations,
    listQuotationCandidates: reads.listQuotationCandidates,
    createProduct: (...args: Parameters<typeof local.createProduct>) => existingWrite(args[1], () => local.createProduct(...args)),
    quotationCapabilities: (...args: Parameters<typeof commercial.quotationCapabilities>) => {
      const caps = workflow.isLocal(args[1]) ? workflow.quoteCapabilities(...args) : commercial.quotationCapabilities(...args);
      return imported.isImported(args[1]) ? imported.annotate(args[1], { ...caps, canCreate: false, canEdit: false, integrationAvailable: false }) : caps;
    },
    createQuotation: (...args: Parameters<typeof commercial.createQuotation>) => {
      imported.assertWritable(args[1], () => commercial.quotationCapabilities(args[0], args[1]));
      return workflow.isLocal(args[1]) ? workflow.createQuotation(...args) : commercial.createQuotation(...args);
    },
    updateQuotation: (...args: Parameters<typeof commercial.updateQuotation>) => {
      imported.assertWritable(args[1], () => commercial.quotationCapabilities(args[0], args[1]));
      return workflow.isLocal(args[1]) ? workflow.updateQuotation(...args) : commercial.updateQuotation(...args);
    },
  };
  const pdf = createQuotationPdfService(localCommercial);
  return {
    auth: queued({ ...auth, getAuthorizedTask: (...args: Parameters<typeof auth.getAuthorizedTask>) => {
      if (!workflow.isLocal(args[1])) return auth.getAuthorizedTask(...args);
      const row = reads.getLead(...args); return { id: row.id, dealName: row.dealName, status: row.status };
    } }, executor),
    dashboard: queued(ownerReports.dashboard, executor),
    leads: queued({ ...leads,
      getLead: (...args: Parameters<typeof reads.getLead>) => imported.annotate(args[1], reads.getLead(...args)),
      listPipeline: (...args: Parameters<typeof reads.listPipeline>) => {
        const page = reads.listPipeline(...args); return { ...page, items: page.items.map(row => imported.annotate(row.id, row)) };
      }, listNotes: reads.listNotes, listStatusHistory: reads.listStatusHistory }, executor),
    mutations: queued({ ...mutations,
      createDeal: (...args: Parameters<typeof mutations.createDeal>) => workflow.enabled ? workflow.createDeal(...args) : mutations.createDeal(...args),
      changeStage: (...args: Parameters<typeof mutations.changeStage>) => {
        imported.assertWritable(args[1], () => mutations.capabilities(args[0], args[1]));
        return workflow.isLocal(args[1]) ? workflow.changeStage(...args) : mutations.changeStage(...args);
      },
      addNote: (...args: Parameters<typeof local.addNote>) => {
        imported.assertWritable(args[1], () => mutations.capabilities(args[0], args[1]));
        return workflow.isLocal(args[1]) ? workflow.addNote(...args) : existingWrite(args[2], () => local.addNote(...args));
      },
      editNote: (...args: Parameters<typeof local.editNote>) => {
        imported.assertWritable(args[1], () => mutations.capabilities(args[0], args[1]));
        return workflow.isLocal(args[1]) ? workflow.editNote(...args) : existingWrite(args[3], () => local.editNote(...args));
      },
      capabilities: (token: string | null | undefined, id: unknown) => {
        const caps = workflow.isLocal(id) ? workflow.capabilities(token, id) : local.leadCapabilities(token, id, mutations.capabilities(token, id));
        return imported.isImported(id) ? imported.annotate(id, { ...caps, canWriteNotes: false, canChangeStage: false, stages: [], integrationAvailable: false }) : caps;
      } }, executor),
    commercial: queued(localCommercial, executor),
    localWrites: queued({ capabilities: (token: string | null | undefined) => {
      const caps = local.capabilities(token);
      return workflow.enabled ? { ...caps, localWorkflow: true, dealCreate: workflow.current(token).permissions.includes("deals.manage") } : caps;
    } }, executor),
    localReads: queued({ ...localReads,
      listJobs: (...args: Parameters<typeof localReads.listJobs>) => {
        const page = localReads.listJobs(...args); return { ...page, items: page.items.map(row => imported.annotate(row.id, row)) };
      },
    }, executor),
    jobs: queued({ ...jobs,
      listJobs: (...args: Parameters<typeof jobs.listJobs>) => {
        const page = jobs.listJobs(...args); return { ...page, items: page.items.map(row => imported.annotate(row.id, row)) };
      },
      updateStatus: (...args: Parameters<typeof jobs.updateStatus>) => {
        imported.assertWritable(args[1], () => jobs.getJob(args[0], args[1])); return jobs.updateStatus(...args);
      },
      updateRemarks: (...args: Parameters<typeof jobs.updateRemarks>) => {
        imported.assertWritable(args[1], () => jobs.getJob(args[0], args[1])); return jobs.updateRemarks(...args);
      },
      getJob: (...args: Parameters<typeof jobs.getJob>) => db.transaction(() => {
        // Enrich only the existing authorized won-job detail in the same snapshot.
        const job = jobs.getJob(...args);
        const source = db.prepare("SELECT complaint_info AS complaintDescription FROM tasks WHERE id=?")
          .get(job.id) as { complaintDescription: string | null } | undefined;
        return imported.annotate(job.id, { ...job, complaintDescription: source?.complaintDescription ?? null });
      })(),
    }, executor),
    departments: queued({ ...departments,
      getJob: (...args: Parameters<typeof departments.getJob>) => imported.annotate(args[2], departments.getJob(...args)),
      getAssignments: (...args: Parameters<typeof departments.getAssignments>) => imported.annotate(args[1], departments.getAssignments(...args)),
      assign: (...args: Parameters<typeof departments.assign>) => {
        imported.assertWritable(args[1], () => departments.getAssignments(args[0], args[1])); return departments.assign(...args);
      },
      unassign: (...args: Parameters<typeof departments.unassign>) => {
        imported.assertWritable(args[1], () => departments.getAssignments(args[0], args[1])); return departments.unassign(...args);
      },
      assignAccounts: (...args: Parameters<typeof departments.assignAccounts>) => {
        imported.assertWritable(args[1], () => departments.getAssignments(args[0], args[1])); return departments.assignAccounts(...args);
      },
      updateStatus: (...args: Parameters<typeof departments.updateStatus>) => {
        imported.assertWritable(args[2], () => departments.getJob(args[0], args[1], args[2])); return departments.updateStatus(...args);
      },
      authorizeLog: (...args: Parameters<typeof departments.authorizeLog>) => {
        imported.assertWritable(args[2], () => departments.authorizeLog(...args)); return departments.authorizeLog(...args);
      },
      addLog: (...args: Parameters<typeof departments.addLog>) => {
        imported.assertWritable(args[2], () => departments.getJob(args[0], args[1], args[2])); return departments.addLog(...args);
      },
      listQueue: (...args: Parameters<typeof departments.listQueue>) => db.transaction(() => {
        // Preserve the reference worker authorization, latest assignment and
        // filters; only project dates for rows it returned in this same snapshot.
        const page = departments.listQueue(...args);
        const dates = page.items.length ? db.prepare(`SELECT CAST(id AS TEXT) AS id,job_deal_date AS jobDate
          FROM tasks WHERE id IN (${page.items.map(() => "?").join(",")})`).all(...page.items.map(item => item.id)) as { id: string; jobDate: string | null }[] : [];
        return { ...page, items: page.items.map(item => imported.annotate(item.id, { ...item, jobDate: dates.find(row => row.id === item.id)?.jobDate ?? null })) };
      })(),
    }, executor),
    attachments: queued({ ...attachments,
      authorizeUpload: (...args: Parameters<typeof attachments.authorizeUpload>) => {
        imported.assertWritable(args[1], () => attachments.authorizeUpload(...args)); return attachments.authorizeUpload(...args);
      },
      upload: (...args: Parameters<typeof attachments.upload>) => {
        imported.assertWritable(args[1], () => attachments.authorizeUpload(args[0], args[1])); return attachments.upload(...args);
      },
      list: (...args: Parameters<typeof attachments.list>) => {
        const page = attachments.list(...args); return imported.isImported(args[1]) ? imported.annotate(args[1], { ...page, canUpload: false }) : page;
      },
    }, executor),
    reports: queued(ownerReports.reports, executor),
    // Direct central-export consumers must use the same import-aware cohort
    // and unknown-history labels as GET /jobs/export. Worker exports retain
    // their independent current-assignee authorization and scope.
    exports: queued({ ...createExportsService(db), exportJobs: localReads.exportJobs }, executor),
    settings: queued(createSettingsService(db), executor),
    // The raw reader executes inside this one queued PDF operation. Passing a
    // queued reader would recursively acquire the executor and must be refused.
    pdf: queued(pdf, executor),
  };
}
