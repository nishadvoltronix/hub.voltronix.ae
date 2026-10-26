import { z } from "zod";
import { CENTRAL_JOB_COHORTS, DEPARTMENTS, JOB_STATUSES,
  type CentralJobPage, type CentralJobRecord, type CreatedDealRecord, type CreatedDealsPage } from "@voltronix/crm-contracts";
import type { MysqlDatabase } from "../db/mysql/database.js";
import { createAuthService } from "../auth/service.js";
import { decimal, money } from "../commercial/decimal.js";
import type { JobExport } from "../exports/service.js";
import { buildJobsWorkbook, ExportLimitError, MAX_EXPORT_ROWS } from "../exports/xlsx.js";
import { localOwnershipJoin, validLocalOwnership } from "../local-workflow/ownership.js";
import { importedTaskSql, recordedSyncAssigneeSql, visibleSyncTaskSql } from "../zoho-sync/provenance.js";

type Token = string | null | undefined;
export class SourceReadError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 413 | 503) {
    super(({ 400: "Invalid list request.", 401: "Sign in required.", 403: "Access denied.",
      413: "The export exceeds the safe limit. Narrow the search and try again.",
      503: "CRM lists are temporarily unavailable." })[status]);
    this.name = "SourceReadError";
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
  const result = schema.safeParse(input); if (!result.success) throw new SourceReadError(400); return result.data;
}
const escapedSearch = (value: string) => `%${value.replace(/[!%_]/g, "!$&")}%`;
const latest = "da.id=(SELECT MAX(newer.id) FROM departments_assign newer WHERE newer.task_id=da.task_id AND newer.department=da.department)";
// Fixed source department identifiers only; request values are bound parameters.
const departments = DEPARTMENTS.map(value => `'${value}'`).join(",");
function jobFilters(value: z.infer<typeof exportInput>, assignedName: string) {
  const filters = ["t.status IN ('Close to Won','Closed Won')", visibleSyncTaskSql()], parameters: (string | number)[] = [];
  // Source pending means no assignment history, including retained unassignment tombstones.
  if (value.cohort === "pending") filters.push(`NOT ${importedTaskSql()}`, "NOT EXISTS (SELECT 1 FROM departments_assign da WHERE da.task_id=t.id)", "(t.Job_Status IS NULL OR t.Job_Status!='Closed')");
  else if (value.cohort === "process" || value.cohort === "completed") {
    filters.push(`EXISTS (SELECT 1 FROM departments_assign da WHERE da.task_id=t.id AND da.department IN (${departments}) AND ${latest} AND da.status IN (${value.cohort === "process" ? "'Assigned','Process'" : "'Completed'"}))`);
  } else if (value.cohort === "hold" || value.cohort === "closed") {
    filters.push("t.Job_Status=?"); parameters.push(value.cohort === "hold" ? "Hold" : "Closed");
  }
  if (value.jobStatus === "Active") filters.push(`(t.Job_Status='Active' OR ((t.Job_Status IS NULL OR t.Job_Status='') AND NOT ${importedTaskSql()}))`);
  else if (value.jobStatus !== "all") { filters.push("t.Job_Status=?"); parameters.push(value.jobStatus); }
  if (value.query) {
    filters.push(`CONCAT(t.deal_name,' ',COALESCE(t.account_name,''),' ',COALESCE(t.job_deal_number,''),' ',COALESCE(${assignedName},'')) COLLATE utf8mb4_0900_as_ci LIKE ? ESCAPE '!'`);
    parameters.push(escapedSearch(value.query));
  }
  return { filter: filters.join(" AND "), parameters };
}
interface ExportRow {
  imported: number;
  createdAt: string; jobNumber: string | null; jobDate: string | null; accountName: string | null; status: string;
  electrical: string | null; civil: string | null; pm: string | null; accounts: string | null; serviceCharge: string | null;
}

/** Source-backed MySQL reads use the existing schema and one authorized snapshot.
 * No local-demo tables, migrations, remote transport or business writes. */
export function createSourceReads(db: MysqlDatabase, options: { now?: () => number; localOwnership?: boolean } = {}) {
  const auth = createAuthService(db, options);
  const from = `FROM tasks t LEFT JOIN users u ON u.user_id=t.assigned_to${options.localOwnership ? ` ${localOwnershipJoin} LEFT JOIN users local_owner ON local_owner.id=l.owner_user_id` : ""}`;
  // Keep source all-created/won scopes, including damaged rows needing review.
  // Display an additional local owner only with verified creation provenance.
  const remoteName = `COALESCE(u.username,${recordedSyncAssigneeSql()})`;
  const assignedName = options.localOwnership ? `CASE WHEN l.task_id IS NULL THEN ${remoteName} WHEN ${validLocalOwnership} THEN local_owner.username ELSE NULL END` : remoteName;
  async function read<T>(token: Token, permission: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await db.transaction(async () => {
        const actor = await auth.authenticate(token); if (!actor) throw new SourceReadError(401);
        if (!actor.permissions.includes(permission)) throw new SourceReadError(403);
        return operation();
      })();
    } catch (error) {
      if (error instanceof SourceReadError) throw error;
      if (error instanceof ExportLimitError) throw new SourceReadError(413);
      throw new SourceReadError(503);
    }
  }
  async function total(filter: string, parameters: (string | number)[]) {
    const value = (await db.prepare(`SELECT COUNT(*) AS n ${from} WHERE ${filter}`).get(...parameters) as { n: number }).n;
    if (!Number.isSafeInteger(value) || value < 0) throw new SourceReadError(503); return value;
  }
  async function listCreatedDeals(token: Token, input: unknown = {}): Promise<CreatedDealsPage> {
    return read(token, "deals.view", async () => {
      const value = parse(dealsInput, input), filters = ["t.deal_crm_created_by IS NOT NULL"], parameters: (string | number)[] = [];
      if (value.query) {
        filters.push(`CONCAT(COALESCE(t.qual_deal_number,''),' ',COALESCE(t.job_deal_number,''),' ',COALESCE(t.account_name,''),' ',t.status,' ',COALESCE(${assignedName},'')) COLLATE utf8mb4_0900_as_ci LIKE ? ESCAPE '!'`);
        parameters.push(escapedSearch(value.query));
      }
      const filter = filters.join(" AND "), count = await total(filter, parameters);
      const items = await db.prepare(`SELECT CAST(t.id AS CHAR) AS id,t.created_at AS createdAt,
        t.qual_deal_number AS qualificationNumber,t.job_deal_number AS jobNumber,t.account_name AS accountName,
        t.status,${assignedName} AS assignedName,t.service_charge AS serviceCharge
        ${from} WHERE ${filter} ORDER BY t.created_at DESC,t.id DESC LIMIT ? OFFSET ?`)
        .all(...parameters, value.pageSize, (value.page - 1) * value.pageSize) as CreatedDealRecord[];
      return { items, total: count, page: value.page, pageSize: value.pageSize };
    });
  }
  async function listJobs(token: Token, input: unknown = {}): Promise<CentralJobPage> {
    return read(token, "dashboard.view", async () => {
      const value = parse(jobsInput, input), { filter, parameters } = jobFilters(value, assignedName), count = await total(filter, parameters);
      const rows = await db.prepare(`SELECT CAST(t.id AS CHAR) AS id,t.deal_name AS dealName,t.account_name AS accountName,
        t.job_deal_number AS jobNumber,t.status AS salesStatus,t.Job_Status AS jobStatus,t.Admin_Remarks AS remarks,
        t.hold_by AS holdByExternalId,t.version,t.updated_at AS updatedAt,t.job_deal_date AS jobDate,
        ${assignedName} AS assignedName,t.service_charge AS serviceCharge
        ${from} WHERE ${filter} ORDER BY t.job_deal_number DESC,t.id DESC LIMIT ? OFFSET ?`)
        .all(...parameters, value.pageSize, (value.page - 1) * value.pageSize) as Omit<CentralJobRecord, "departments">[];
      const summaries = rows.length ? await db.prepare(`SELECT CAST(da.task_id AS CHAR) AS taskId,da.department,da.status,u.username AS userName
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
  async function exportJobs(token: Token, input: unknown = {}): Promise<JobExport> {
    return read(token, "dashboard.view", async () => {
      const value = parse(exportInput, input), { filter, parameters } = jobFilters(value, assignedName);
      const status = (department: "Electrical" | "Civil" | "PM") => `(SELECT a.status FROM departments_assign a WHERE a.task_id=t.id AND a.department='${department}' ORDER BY a.id DESC LIMIT 1)`;
      const rows = await db.prepare(`SELECT ${importedTaskSql()} imported,t.created_at AS createdAt,t.job_deal_number AS jobNumber,t.job_deal_date AS jobDate,
        t.account_name AS accountName,t.status,${status("Electrical")} AS electrical,${status("Civil")} AS civil,
        ${status("PM")} AS pm,(SELECT payment_status FROM accounts WHERE task_id=t.id ORDER BY id DESC LIMIT 1) AS accounts,
        t.service_charge AS serviceCharge ${from} WHERE ${filter}
        ORDER BY t.job_deal_number DESC,t.id DESC LIMIT ?`).all(...parameters, MAX_EXPORT_ROWS + 1) as ExportRow[];
      if (rows.length > MAX_EXPORT_ROWS) throw new SourceReadError(413);
      const cells = rows.map(row => [row.createdAt, row.jobNumber, row.jobDate, row.accountName, row.status,
        row.electrical ?? (row.imported ? "Not imported" : "Not Assigned"), row.civil ?? (row.imported ? "Not imported" : "Not Assigned"), row.pm ?? (row.imported ? "Not imported" : "Not Assigned"), row.accounts,
        row.serviceCharge === null || row.serviceCharge === "" ? null : money(decimal(row.serviceCharge))]);
      const date = new Date((options.now ?? Date.now)() + 4 * 60 * 60 * 1_000).toISOString().slice(0, 10);
      return { bytes: buildJobsWorkbook(cells), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename: `All_Jobs_${date}.xlsx`, rowCount: rows.length };
    });
  }
  return { listCreatedDeals, listJobs, exportJobs };
}
