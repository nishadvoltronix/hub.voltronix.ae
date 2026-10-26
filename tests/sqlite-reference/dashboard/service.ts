import type { Database } from "better-sqlite3";
import { z } from "zod";
import { createAuthService } from "../auth/service";
import type { PermissionKey } from "../auth/permissions";
import { DASHBOARD_DEPARTMENTS, type DashboardDepartment, type DashboardResult, type DepartmentProgress,
  type EmployeeWorkload, type PersonalDepartment, type PipelineMetric } from "./types";

const departmentGrants = {
  Electrical: "electric_dashboard.view", Civil: "civil_dashboard.view", PM: "pm_dashboard.view",
  Switchgear: "switchgear_dashboard.view", Maintenance: "maintenance_dashboard.view",
} as const satisfies Record<DashboardDepartment, PermissionKey>;
export const DASHBOARD_PERMISSIONS: readonly PermissionKey[] = ["dashboard.view", "sales_dashboard.view", ...Object.values(departmentGrants)];
export function hasDashboardAccess(permissions: readonly string[]): boolean {
  return DASHBOARD_PERMISSIONS.some((permission) => permissions.includes(permission));
}
export class DashboardError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 503) {
    super(({ 400: "Invalid dashboard input.", 401: "Sign in required.", 403: "Access denied.",
      503: "Dashboard data is temporarily unavailable. Some records may require review." })[status]);
    this.name = "DashboardError";
  }
}
const querySchema = z.object({
  employeePage: z.number().int().min(1).max(1_000_000).default(1),
  employeePageSize: z.number().int().min(1).max(100).default(25),
  employeeSearch: z.string().trim().max(120).refine((value) => !value.includes("\0")).default(""),
}).strict();
const stages = [
  { key: "qualification", label: "Qualification", values: ["Pending", "Qualification"] },
  { key: "site_visit", label: "Site Visit", values: ["Site Visit"] },
  { key: "proposal", label: "Proposal", values: ["Proposal", "Proposal/Price Quote"] },
  { key: "won", label: "Won", values: ["Close to Won", "Closed Won"] },
  { key: "lost", label: "Lost / omitted", values: ["Close to Lost", "Closed Lost", "Omitted", "Proposal-Omitted"] },
  { key: "big_project", label: "Big project / empty stage", values: ["Big Project", ""] },
] as const;
const latestAssignments = `WITH latest AS (
  SELECT a.* FROM departments_assign a WHERE a.id=(SELECT MAX(b.id) FROM departments_assign b
    WHERE b.task_id=a.task_id AND b.department=a.department)
)`;
const won = "t.status IN ('Close to Won','Closed Won')";
const activeJob = "(t.Job_Status IS NULL OR t.Job_Status='Active')";
const scale = 10n ** 18n;
function amount(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,18})?$/.test(value)) throw new DashboardError(503);
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * scale + BigInt(fraction.padEnd(18, "0"));
}
function formattedAmount(value: bigint): string {
  const fraction = (value % scale).toString().padStart(18, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${value / scale}.${fraction}`;
}
function percent(count: number, total: number): string {
  if (!total) return "0.00";
  const basisPoints = (BigInt(count) * 10_000n * 2n + BigInt(total)) / (BigInt(total) * 2n);
  return `${basisPoints / 100n}.${(basisPoints % 100n).toString().padStart(2, "0")}`;
}
// New SQLite datetime strings are UTC (including CURRENT_TIMESTAMP). Dubai has no DST.
// Legacy PHP Dubai wall-clock timestamps require explicit conversion before any import.
function ranges(now: number) {
  const dubai = new Date(now + 4 * 60 * 60 * 1_000);
  const year = dubai.getUTCFullYear(), month = dubai.getUTCMonth(), day = dubai.getUTCDate();
  const boundary = (monthValue: number, dayValue: number) => new Date(Date.UTC(year, monthValue, dayValue) - 4 * 60 * 60 * 1_000).toISOString();
  return { today: boundary(month, day), tomorrow: boundary(month, day + 1), month: boundary(month, 1), nextMonth: boundary(month + 1, 1) };
}
function escapedSearch(value: string) { return `%${value.replace(/[\\%_]/g, "\\$&")}%`; }

/** A single SQLite snapshot authorizes and computes only the sections granted to this session. */
export function createDashboardService(db: Database, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const auth = createAuthService(db, { now });
  const count = (sql: string, ...bindings: (string | number | null)[]) =>
    (db.prepare(sql).get(...bindings) as { n: number }).n;
  function pipeline(owner?: string | null): PipelineMetric[] {
    const where = owner === undefined ? "" : "WHERE assigned_to=?";
    const bindings = owner === undefined ? [] : [owner];
    const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM tasks ${where} GROUP BY status`)
      .all(...bindings) as { status: string | null; n: number }[];
    const total = rows.reduce((sum, row) => sum + row.n, 0);
    return stages.map((stage) => {
      const matches = rows.filter((row) => (stage.values as readonly (string | null)[]).includes(row.status) ||
        (stage.key === "big_project" && row.status === null));
      const n = matches.reduce((sum, row) => sum + row.n, 0);
      return { key: stage.key, label: stage.label, count: n, percentage: percent(n, total) };
    });
  }
  function accountSummary(): NonNullable<DashboardResult["global"]>["accounts"] {
    // Preserve the specific source filter (Close to Won only), not an inferred payment rule.
    const charges = db.prepare("SELECT CAST(id AS TEXT) AS id,service_charge FROM tasks WHERE status='Close to Won'")
      .all() as { id: string; service_charge: string | null }[];
    const received = new Map<string, bigint>();
    for (const row of db.prepare(`SELECT CAST(a.task_id AS TEXT) AS taskId,a.received_amount FROM accounts a
      JOIN tasks t ON t.id=a.task_id WHERE t.status='Close to Won'`).iterate() as Iterable<{ taskId: string; received_amount: string | null }>) {
      if (row.received_amount !== null) received.set(row.taskId, (received.get(row.taskId) ?? 0n) + amount(row.received_amount));
    }
    let pendingJobs = 0, unknownServiceChargeJobs = 0, total = 0n;
    for (const charge of charges) {
      if (charge.service_charge === null) { unknownServiceChargeJobs++; continue; }
      const pending = amount(charge.service_charge) - (received.get(charge.id) ?? 0n);
      if (pending > 0n) { pendingJobs++; total += pending; }
    }
    return { pendingJobs, totalPending: unknownServiceChargeJobs ? null : formattedAmount(total), unknownServiceChargeJobs };
  }
  function departmentProgress(department: DashboardDepartment): DepartmentProgress {
    const rows = db.prepare(`${latestAssignments} SELECT a.status,t.Job_Status AS jobStatus,COUNT(*) AS n
      FROM latest a JOIN tasks t ON t.id=a.task_id WHERE a.department=? AND a.user_id IS NOT NULL AND a.status<>'Unassigned' GROUP BY a.status,t.Job_Status`)
      .all(department) as { status: string; jobStatus: string | null; n: number }[];
    const sum = (predicate: (row: (typeof rows)[number]) => boolean) => rows.filter(predicate).reduce((n, row) => n + row.n, 0);
    return { department, total: sum(() => true), pending: sum((row) => row.status === "Assigned" &&
      (department !== "PM" || row.jobStatus === null || row.jobStatus === "Active")),
      process: sum((row) => row.status === "Process"), completed: sum((row) => row.status === "Completed"),
      hold: sum((row) => row.status === "Hold") };
  }
  function personalDepartment(department: DashboardDepartment, userId: string, date: ReturnType<typeof ranges>): PersonalDepartment {
    const row = db.prepare(`${latestAssignments} SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN a.status='Assigned' AND ${activeJob} THEN 1 ELSE 0 END),0) AS pending,
      COALESCE(SUM(CASE WHEN a.status='Process' AND ${activeJob} THEN 1 ELSE 0 END),0) AS process,
      COALESCE(SUM(CASE WHEN a.status='Completed' THEN 1 ELSE 0 END),0) AS completed,
      COALESCE(SUM(CASE WHEN t.Job_Status='Hold' THEN 1 ELSE 0 END),0) AS hold,
      COALESCE(SUM(CASE WHEN julianday(a.assigned_date)>=julianday(?) AND julianday(a.assigned_date)<julianday(?) THEN 1 ELSE 0 END),0) AS assignedToday,
      COALESCE(SUM(CASE WHEN a.status='Completed' AND julianday(a.assigned_date)>=julianday(?) AND julianday(a.assigned_date)<julianday(?) THEN 1 ELSE 0 END),0) AS completedAssignedThisMonth
      FROM latest a JOIN tasks t ON t.id=a.task_id WHERE a.department=? AND a.user_id=?`)
      .get(date.today, date.tomorrow, date.month, date.nextMonth, department, userId) as Omit<PersonalDepartment, "department">;
    return { department, ...row };
  }
  function employeeWorkload(query: z.infer<typeof querySchema>): NonNullable<DashboardResult["global"]>["employees"] {
    const search = escapedSearch(query.employeeSearch);
    const total = count("SELECT COUNT(*) AS n FROM users WHERE username LIKE ? ESCAPE '\\'", search);
    const items = db.prepare(`${latestAssignments} SELECT CAST(u.id AS TEXT) AS id,u.username AS name,
      (SELECT COUNT(*) FROM latest a JOIN tasks t ON t.id=a.task_id WHERE a.user_id=u.id AND a.department='Electrical' AND ${won}) AS electrical,
      (SELECT COUNT(*) FROM latest a JOIN tasks t ON t.id=a.task_id WHERE a.user_id=u.id AND a.department='Civil' AND ${won}) AS civil,
      (SELECT COUNT(*) FROM latest a JOIN tasks t ON t.id=a.task_id WHERE a.user_id=u.id AND a.department='PM' AND ${won}) AS pm
      FROM users u WHERE username LIKE ? ESCAPE '\\' ORDER BY u.username COLLATE NOCASE,u.id LIMIT ? OFFSET ?`)
      .all(search, query.employeePageSize, (query.employeePage - 1) * query.employeePageSize) as EmployeeWorkload[];
    return { items, total, page: query.employeePage, pageSize: query.employeePageSize };
  }
  function getDashboard(token: string | undefined | null, input: unknown = {}): DashboardResult {
    try {
      return db.transaction(() => {
        const actor = auth.authenticate(token);
        if (!actor) throw new DashboardError(401);
        if (!hasDashboardAccess(actor.permissions)) throw new DashboardError(403);
        const parsed = querySchema.safeParse(input);
        if (!parsed.success) throw new DashboardError(400);
        if (!actor.permissions.includes("dashboard.view") && (parsed.data.employeeSearch || parsed.data.employeePage !== 1 || parsed.data.employeePageSize !== 25)) {
          throw new DashboardError(403);
        }
        const timestamp = now(), date = ranges(timestamp);
        const result: DashboardResult = { asOf: new Date(timestamp).toISOString(), timeZone: "Asia/Dubai", departments: [] };
        if (actor.permissions.includes("dashboard.view")) {
          result.global = {
            wonJobs: count(`SELECT COUNT(*) AS n FROM tasks t WHERE ${won}`),
            pendingAssignmentJobs: count(`${latestAssignments} SELECT COUNT(*) AS n FROM tasks t WHERE ${won}
              AND NOT EXISTS(SELECT 1 FROM latest a WHERE a.task_id=t.id AND a.user_id IS NOT NULL AND a.status<>'Unassigned')`),
            completedJobs: count(`SELECT COUNT(*) AS n FROM tasks t WHERE EXISTS(SELECT 1 FROM departments_assign a WHERE a.task_id=t.id)
              AND NOT EXISTS(SELECT 1 FROM departments_assign a WHERE a.task_id=t.id AND a.status<>'Completed')`),
            accounts: accountSummary(),
            leadsToday: count("SELECT COUNT(*) AS n FROM tasks WHERE julianday(created_at)>=julianday(?) AND julianday(created_at)<julianday(?)", date.today, date.tomorrow),
            leadsThisMonth: count("SELECT COUNT(*) AS n FROM tasks WHERE julianday(created_at)>=julianday(?) AND julianday(created_at)<julianday(?)", date.month, date.nextMonth),
            pipeline: pipeline(), departmentProgress: (["Electrical", "Civil", "PM"] as const).map(departmentProgress),
            employees: employeeWorkload(parsed.data),
          };
        }
        for (const department of DASHBOARD_DEPARTMENTS) {
          if (actor.permissions.includes(departmentGrants[department])) result.departments.push(personalDepartment(department, actor.localUserId, date));
        }
        if (actor.permissions.includes("sales_dashboard.view")) {
          result.sales = {
            total: count("SELECT COUNT(*) AS n FROM tasks WHERE assigned_to=?", actor.externalUserId),
            today: count("SELECT COUNT(*) AS n FROM tasks WHERE assigned_to=? AND julianday(created_at)>=julianday(?) AND julianday(created_at)<julianday(?)", actor.externalUserId, date.today, date.tomorrow),
            thisMonth: count("SELECT COUNT(*) AS n FROM tasks WHERE assigned_to=? AND julianday(created_at)>=julianday(?) AND julianday(created_at)<julianday(?)", actor.externalUserId, date.month, date.nextMonth),
            stages: pipeline(actor.externalUserId).filter((stage) => stage.key !== "big_project").map(({ key, label, count: n }) => ({ key, label, count: n })),
          };
        }
        return result;
      })();
    } catch (error) {
      if (error instanceof DashboardError) throw error;
      throw new DashboardError(503);
    }
  }
  return { getDashboard };
}
