import { z } from "zod";
import { CENTRAL_JOB_COHORTS, DEPARTMENTS, JOB_STATUSES,
  type CentralJobPage, type CentralJobRecord, type CreatedDealRecord, type CreatedDealsPage } from "@voltronix/crm-contracts";
import type { SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { createAuthService } from "../../tests/sqlite-reference/auth/service.js";
import { decimal, money } from "../src/crm/commercial/decimal.js";
import type { JobExport } from "../src/crm/exports/service.js";
import { buildJobsWorkbook, ExportLimitError, MAX_EXPORT_ROWS } from "../src/crm/exports/xlsx.js";
import { inspectLocalWorkflowExtension } from "./workflow-schema.js";
import { inspectZohoImportExtension } from "./zoho-import-store.js";

type Token = string | null | undefined;
export class LocalReadError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 413 | 503) {
    super(({ 400: "Invalid list request.", 401: "Sign in required.", 403: "Access denied.",
      413: "The export exceeds the safe limit. Narrow the search and try again.",
      503: "Local lists are temporarily unavailable." })[status]);
    this.name = "LocalReadError";
  }
}
const pageFields = {
  query: z.string().trim().max(120).refine(value => !value.includes("\0")).default(""),
  page: z.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
};
const dealsInput = z.object(pageFields).strict();
const exportInput = z.object({ query: pageFields.query, cohort: z.enum(CENTRAL_JOB_COHORTS).default("all"),
  jobStatus: z.enum(["all", ...JOB_STATUSES]).default("all") }).strict();
const jobsInput = exportInput.extend({ page: pageFields.page, pageSize: pageFields.pageSize });
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input); if (!result.success) throw new LocalReadError(400); return result.data;
}
function escapedSearch(value: string) { return `%${value.replace(/[!%_]/g, "!$&")}%`; }
const latest = "da.id=(SELECT MAX(newer.id) FROM departments_assign newer WHERE newer.task_id=da.task_id AND newer.department=da.department)";
// Only fixed source department names become SQL. All request values use bindings.
const departments = DEPARTMENTS.map(value => `'${value}'`).join(",");
function jobFilters(value: z.infer<typeof exportInput>, assignedName: string, importedTask: string) {
  const filters = ["t.status IN ('Close to Won','Closed Won')"], parameters: (string | number)[] = [];
  if (value.cohort === "pending") filters.push(`NOT (${importedTask})`, "NOT EXISTS (SELECT 1 FROM departments_assign da WHERE da.task_id=t.id)", "(t.Job_Status IS NULL OR t.Job_Status!='Closed')");
  else if (value.cohort === "process" || value.cohort === "completed") {
    filters.push(`EXISTS (SELECT 1 FROM departments_assign da WHERE da.task_id=t.id AND da.department IN (${departments}) AND ${latest} AND da.status IN (${value.cohort === "process" ? "'Assigned','Process'" : "'Completed'"}))`);
  } else if (value.cohort === "hold" || value.cohort === "closed") {
    filters.push("t.Job_Status=?"); parameters.push(value.cohort === "hold" ? "Hold" : "Closed");
  }
  if (value.jobStatus === "Active") filters.push(`(t.Job_Status='Active' OR ((t.Job_Status IS NULL OR t.Job_Status='') AND NOT (${importedTask})))`);
  else if (value.jobStatus !== "all") { filters.push("t.Job_Status=?"); parameters.push(value.jobStatus); }
  if (value.query) {
    filters.push(`(t.deal_name || ' ' || COALESCE(t.account_name,'') || ' ' || COALESCE(t.job_deal_number,'') || ' ' || COALESCE(${assignedName},'')) LIKE ? ESCAPE '!'`);
    parameters.push(escapedSearch(value.query));
  }
  return { filter: filters.join(" AND "), parameters };
}
interface ExportRow {
  createdAt: string; jobNumber: string | null; jobDate: string | null; accountName: string | null; status: string;
  electrical: string | null; civil: string | null; pm: string | null; accounts: string | null; serviceCharge: string | null; imported: number;
}

/** Isolated demo read composition; no migrations, writes or remote transport.
 * Source: Admin::view_all_self_created_deals and view_all_won_jobs_*.
 * Page, count and summaries use one SQLite snapshot with current authorization. */
export function createLocalDemoReads(db: SqliteDatabase, options: { now?: () => number } = {}) {
  const auth = createAuthService(db);
  const localWorkflow = inspectLocalWorkflowExtension(db);
  const from = `FROM tasks t LEFT JOIN users u ON u.user_id=t.assigned_to${localWorkflow ? " LEFT JOIN crm_demo_local_tasks local_task ON local_task.task_id=t.id LEFT JOIN users local_owner ON local_owner.id=local_task.owner_user_id" : ""}`;
  const assignedName = localWorkflow ? "CASE WHEN local_task.task_id IS NOT NULL THEN local_owner.username ELSE u.username END" : "u.username";
  // Resolve inside the authorized read transaction, never cache a missing
  // extension: an import may be applied after this service was constructed.
  function importedTask(): string {
    return inspectZohoImportExtension(db)
      ? "EXISTS(SELECT 1 FROM crm_demo_zoho_import_records imported WHERE imported.module='Deals' AND imported.local_id=CAST(t.id AS TEXT))"
      : "0";
  }
  function read<T>(token: Token, permission: string, operation: () => T): T {
    try {
      return db.transaction(() => {
        const actor = auth.authenticate(token); if (!actor) throw new LocalReadError(401);
        if (!actor.permissions.includes(permission)) throw new LocalReadError(403);
        return operation();
      })();
    } catch (error) {
      if (error instanceof LocalReadError) throw error;
      if (error instanceof ExportLimitError) throw new LocalReadError(413);
      throw new LocalReadError(503);
    }
  }
  function total(filter: string, parameters: (string | number)[]) {
    const value = (db.prepare(`SELECT COUNT(*) AS n ${from} WHERE ${filter}`).get(...parameters) as { n: number }).n;
    if (!Number.isSafeInteger(value) || value < 0) throw new LocalReadError(503); return value;
  }
  function listCreatedDeals(token: Token, input: unknown = {}): CreatedDealsPage {
    // layout/layout.php identifies deals.view even though its legacy link is commented.
    return read(token, "deals.view", () => {
      const value = parse(dealsInput, input), filters = ["t.deal_crm_created_by IS NOT NULL"], parameters: (string | number)[] = [];
      if (value.query) {
        filters.push(`(COALESCE(t.qual_deal_number,'') || ' ' || COALESCE(t.job_deal_number,'') || ' ' || COALESCE(t.account_name,'') || ' ' || t.status || ' ' || COALESCE(${assignedName},'')) LIKE ? ESCAPE '!'`);
        parameters.push(escapedSearch(value.query));
      }
      const filter = filters.join(" AND "), count = total(filter, parameters);
      const items = db.prepare(`SELECT CAST(t.id AS TEXT) AS id,t.created_at AS createdAt,
        t.qual_deal_number AS qualificationNumber,t.job_deal_number AS jobNumber,t.account_name AS accountName,
        t.status,${assignedName} AS assignedName,t.service_charge AS serviceCharge
        ${from} WHERE ${filter} ORDER BY t.created_at DESC,t.id DESC LIMIT ? OFFSET ?`)
        .all(...parameters, value.pageSize, (value.page - 1) * value.pageSize) as CreatedDealRecord[];
      return { items, total: count, page: value.page, pageSize: value.pageSize };
    });
  }
  function listJobs(token: Token, input: unknown = {}): CentralJobPage {
    return read(token, "dashboard.view", () => {
      const value = parse(jobsInput, input), { filter, parameters } = jobFilters(value, assignedName, importedTask()), count = total(filter, parameters);
      const rows = db.prepare(`SELECT CAST(t.id AS TEXT) AS id,t.deal_name AS dealName,t.account_name AS accountName,
        t.job_deal_number AS jobNumber,t.status AS salesStatus,t.Job_Status AS jobStatus,t.Admin_Remarks AS remarks,
        t.hold_by AS holdByExternalId,t.version,t.updated_at AS updatedAt,t.job_deal_date AS jobDate,
        ${assignedName} AS assignedName,t.service_charge AS serviceCharge
        ${from} WHERE ${filter} ORDER BY t.job_deal_number DESC,t.id DESC LIMIT ? OFFSET ?`)
        .all(...parameters, value.pageSize, (value.page - 1) * value.pageSize) as Omit<CentralJobRecord, "departments">[];
      const summaries = rows.length ? db.prepare(`SELECT CAST(da.task_id AS TEXT) AS taskId,da.department,da.status,u.username AS userName
        FROM departments_assign da LEFT JOIN users u ON u.id=da.user_id
        WHERE da.task_id IN (${rows.map(() => "?").join(",")}) AND da.department IN (${departments}) AND ${latest}
        ORDER BY da.id`).all(...rows.map(row => row.id)) as (CentralJobRecord["departments"][number] & { taskId: string })[] : [];
      const items = rows.map(row => ({ ...row, departments: DEPARTMENTS.flatMap(department => {
        const entry = summaries.find(summary => summary.taskId === row.id && summary.department === department);
        return entry ? [{ department: entry.department, status: entry.status, userName: entry.userName }] : [];
      }) }));
      return { items, total: count, page: value.page, pageSize: value.pageSize };
    });
  }
  function exportJobs(token: Token, input: unknown = {}): JobExport {
    return read(token, "dashboard.view", () => {
      const value = parse(exportInput, input), imported = importedTask(), { filter, parameters } = jobFilters(value, assignedName, imported);
      const status = (department: "Electrical" | "Civil" | "PM") => `(SELECT a.status FROM departments_assign a WHERE a.task_id=t.id AND a.department='${department}' ORDER BY a.id DESC LIMIT 1)`;
      const rows = db.prepare(`SELECT t.created_at AS createdAt,t.job_deal_number AS jobNumber,t.job_deal_date AS jobDate,
        t.account_name AS accountName,t.status,${status("Electrical")} AS electrical,${status("Civil")} AS civil,
        ${status("PM")} AS pm,(SELECT payment_status FROM accounts WHERE task_id=t.id ORDER BY id DESC LIMIT 1) AS accounts,
        t.service_charge AS serviceCharge,CASE WHEN ${imported} THEN 1 ELSE 0 END AS imported ${from} WHERE ${filter}
        ORDER BY t.job_deal_number DESC,t.id DESC LIMIT ?`).all(...parameters, MAX_EXPORT_ROWS + 1) as ExportRow[];
      if (rows.length > MAX_EXPORT_ROWS) throw new LocalReadError(413);
      const cells = rows.map(row => [row.createdAt, row.jobNumber, row.jobDate, row.accountName, row.status,
        row.electrical ?? (row.imported ? "Not imported" : "Not Assigned"), row.civil ?? (row.imported ? "Not imported" : "Not Assigned"),
        row.pm ?? (row.imported ? "Not imported" : "Not Assigned"), row.accounts ?? (row.imported ? "Not imported" : null),
        row.serviceCharge === null || row.serviceCharge === "" ? null : money(decimal(row.serviceCharge))]);
      const date = new Date((options.now ?? Date.now)() + 4 * 60 * 60 * 1_000).toISOString().slice(0, 10);
      return { bytes: buildJobsWorkbook(cells), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename: `All_Jobs_${date}.xlsx`, rowCount: rows.length };
    });
  }
  return { listCreatedDeals, listJobs, exportJobs };
}
