import type { Database } from "better-sqlite3";
import { z } from "zod";
import { createAuthService, type AuthUser } from "../auth/service";
import { DEPARTMENT_PERMISSIONS } from "../auth/permissions";
import { type Department } from "../departments/contracts";
import { decimal, money } from "../commercial/decimal";
import { buildJobsWorkbook, ExportLimitError, MAX_EXPORT_ROWS } from "./xlsx";

type Token = string | null | undefined;
export class ExportsError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 413 | 503) {
    super(({ 400: "Invalid export input.", 401: "Sign in required.", 403: "Access denied.",
      413: "The export exceeds the safe limit. Narrow the search and try again.",
      503: "The export is temporarily unavailable." })[status]);
    this.name = "ExportsError";
  }
}
const inputSchema = z.object({ query: z.string().trim().max(120).refine((value) => !value.includes("\0")).default(""),
  jobStatus: z.enum(["all", "Active", "Hold", "Closed"]).default("all") }).strict();
const sheetType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
interface JobRow {
  createdAt: string; jobNumber: string | null; jobDate: string | null; accountName: string | null;
  status: string; electrical: string | null; civil: string | null; pm: string | null;
  accounts: string | null; serviceCharge: string | null;
}
export interface JobExport { bytes: Uint8Array; contentType: string; filename: string; rowCount: number }
export function createExportsService(db: Database, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const auth = createAuthService(db, { now });
  function current(token: Token): AuthUser {
    const actor = auth.authenticate(token);
    if (!actor) throw new ExportsError(401);
    return actor;
  }
  function rows(actor: AuthUser, department: Department | null, input: unknown): JobRow[] {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new ExportsError(400);
    const value = parsed.data;
    const filters = ["t.status IN ('Close to Won','Closed Won')"];
    const parameters: (string | number)[] = [];
    if (department) {
      filters.push(`EXISTS(SELECT 1 FROM departments_assign a WHERE a.task_id=t.id AND a.department=? AND a.user_id=?
        AND a.id=(SELECT MAX(x.id) FROM departments_assign x WHERE x.task_id=t.id AND x.department=a.department))`);
      parameters.push(department, actor.localUserId);
    }
    if (value.jobStatus === "Active") filters.push("(t.Job_Status IS NULL OR t.Job_Status='' OR t.Job_Status='Active')");
    else if (value.jobStatus !== "all") { filters.push("t.Job_Status=?"); parameters.push(value.jobStatus); }
    if (value.query) {
      filters.push("(t.deal_name || ' ' || COALESCE(t.account_name,'') || ' ' || COALESCE(t.job_deal_number,'')) LIKE ? ESCAPE '\\'");
      parameters.push(`%${value.query.replace(/[\\%_]/g, "\\$&")}%`);
    }
    const latestStatus = (departmentName: Department) => `(SELECT a.status FROM departments_assign a WHERE a.task_id=t.id AND a.department='${departmentName}' ORDER BY a.id DESC LIMIT 1)`;
    const result = db.prepare(`SELECT t.created_at AS createdAt,t.job_deal_number AS jobNumber,t.job_deal_date AS jobDate,
      t.account_name AS accountName,t.status,${latestStatus("Electrical")} AS electrical,${latestStatus("Civil")} AS civil,
      ${latestStatus("PM")} AS pm,(SELECT payment_status FROM accounts WHERE task_id=t.id ORDER BY id DESC LIMIT 1) AS accounts,
      t.service_charge AS serviceCharge FROM tasks t WHERE ${filters.join(" AND ")}
      ORDER BY t.job_deal_number DESC,t.id DESC LIMIT ?`).all(...parameters, MAX_EXPORT_ROWS + 1) as JobRow[];
    if (result.length > MAX_EXPORT_ROWS) throw new ExportsError(413);
    return result;
  }
  function execute(token: Token, department: unknown, input: unknown, central: boolean): JobExport {
    try {
      const result = db.transaction(() => {
        const actor = current(token);
        let selected: Department | null = null;
        if (central) {
          if (!actor.permissions.includes("dashboard.view")) throw new ExportsError(403);
        } else {
          if (typeof department !== "string" || !Object.hasOwn(DEPARTMENT_PERMISSIONS, department)) throw new ExportsError(400);
          selected = department as Department;
          if (!actor.permissions.includes(DEPARTMENT_PERMISSIONS[selected])) throw new ExportsError(403);
        }
        return { records: rows(actor, selected, input), department: selected };
      })();
      const cells = result.records.map((row) => [row.createdAt, row.jobNumber, row.jobDate, row.accountName, row.status,
        row.electrical ?? "Not Assigned", row.civil ?? "Not Assigned", row.pm ?? "Not Assigned", row.accounts,
        row.serviceCharge === null || row.serviceCharge === "" ? null : money(decimal(row.serviceCharge))]);
      const date = new Date(now() + 4 * 60 * 60 * 1_000).toISOString().slice(0, 10);
      return { bytes: buildJobsWorkbook(cells), contentType: sheetType,
        filename: `${result.department ?? "All"}_Jobs_${date}.xlsx`, rowCount: cells.length };
    } catch (error) {
      if (error instanceof ExportsError) throw error;
      if (error instanceof ExportLimitError) throw new ExportsError(413);
      throw new ExportsError(503);
    }
  }
  return { exportJobs: (token: Token, input: unknown = {}) => execute(token, null, input, true),
    exportDepartmentJobs: (token: Token, department: unknown, input: unknown = {}) => execute(token, department, input, false) };
}
