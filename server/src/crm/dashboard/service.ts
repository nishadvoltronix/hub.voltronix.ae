import type { MysqlDatabase as Database } from "../db/mysql/database.js";
import { z } from "zod";
import { createAuthService } from "../auth/service.js";
import type { PermissionKey } from "../auth/permissions.js";
import { DASHBOARD_DEPARTMENTS, type DashboardDepartment, type DashboardResult, type DashboardSourceCoverage, type DepartmentProgress,
  type EmployeeWorkload, type PersonalDepartment, type PipelineMetric } from "./types.js";
import { localOwnershipJoin, localSalesScope } from "../local-workflow/ownership.js";
import { importedTaskSql, visibleSyncTaskSql } from "../zoho-sync/provenance.js";

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
const won = `t.status IN ('Close to Won','Closed Won') AND ${visibleSyncTaskSql()}`;
const activeJob = `(t.Job_Status='Active' OR (t.Job_Status IS NULL AND NOT ${importedTaskSql()}))`;
type LocalOperations = NonNullable<DashboardSourceCoverage["localOperations"]>;
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
// Application timestamp strings are UTC. MySQL defaults and ISO writes are parsed explicitly; Dubai has no DST.
// Legacy PHP Dubai wall-clock timestamps require explicit conversion before any import.
function ranges(now: number) {
  const dubai = new Date(now + 4 * 60 * 60 * 1_000);
  const year = dubai.getUTCFullYear(), month = dubai.getUTCMonth(), day = dubai.getUTCDate();
  const boundary = (monthValue: number, dayValue: number) => new Date(Date.UTC(year, monthValue, dayValue) - 4 * 60 * 60 * 1_000).toISOString();
  return { today: boundary(month, day), tomorrow: boundary(month, day + 1), month: boundary(month, 1), nextMonth: boundary(month + 1, 1) };
}
function escapedSearch(value: string) { return `%${value.replace(/[!%_]/g, "!$&")}%`; }

/** A single MySQL transaction authorizes and computes only the sections granted to this session. */
export function createDashboardService(db: Database, options: { now?: () => number; localOwnership?: boolean } = {}) {
  const now = options.now ?? Date.now;
  const auth = createAuthService(db, { now });
  const count = async (sql: string, ...bindings: (string | number | null)[]) => {
    const n = ((await db.prepare(sql).get(...bindings)) as { n: number }).n;
    if (!Number.isSafeInteger(n) || n < 0) throw new DashboardError(503);
    return n;
  };
  async function pipeline(owner?: string | null, localOwner?: string): Promise<PipelineMetric[]> {
    const local = options.localOwnership && localOwner !== undefined;
    const where = `WHERE ${visibleSyncTaskSql()}${owner === undefined ? "" : local ? ` AND ${localSalesScope}` : " AND t.assigned_to=?"}`;
    const bindings = owner === undefined ? [] : local ? [owner, localOwner] : [owner];
    const rows = (await db.prepare(`SELECT t.status, COUNT(*) AS n FROM tasks t ${local ? localOwnershipJoin : ""} ${where} GROUP BY t.status`)
      .all(...bindings)) as { status: string | null; n: number }[];
    if (rows.some((row) => !Number.isSafeInteger(row.n) || row.n < 0)) throw new DashboardError(503);
    const total = rows.reduce((sum, row) => sum + row.n, 0);
    if (!Number.isSafeInteger(total)) throw new DashboardError(503);
    const metrics: PipelineMetric[] = stages.map((stage) => {
      const matches = rows.filter((row) => (stage.values as readonly (string | null)[]).includes(row.status) ||
        (stage.key === "big_project" && row.status === null));
      const n = matches.reduce((sum, row) => sum + row.n, 0);
      return { key: stage.key, label: stage.label, count: n, percentage: percent(n, total) };
    });
    const unmapped = total - metrics.reduce((sum, stage) => sum + stage.count, 0);
    if (unmapped > 0) metrics.push({ key: "unmapped", label: "Other / unmapped stages", count: unmapped,
      percentage: percent(unmapped, total) });
    return metrics;
  }
  async function accountSummary(): Promise<LocalOperations["accounts"]> {
    // Preserve the specific source filter (Close to Won only), not an inferred payment rule.
    const charges = (await db.prepare(`SELECT CAST(t.id AS CHAR) AS id,t.service_charge FROM tasks t WHERE t.status='Close to Won' AND ${visibleSyncTaskSql()} AND NOT ${importedTaskSql()}`)
      .all()) as { id: string; service_charge: string | null }[];
    const received = new Map<string, bigint>();
    for (const row of (await db.prepare(`SELECT CAST(a.task_id AS CHAR) AS taskId,a.received_amount FROM accounts a
      JOIN tasks t ON t.id=a.task_id WHERE t.status='Close to Won' AND ${visibleSyncTaskSql()} AND NOT ${importedTaskSql()}`).all()) as Iterable<{ taskId: string; received_amount: string | null }>) {
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
  async function departmentProgress(department: DashboardDepartment): Promise<DepartmentProgress> {
    const rows = (await db.prepare(`${latestAssignments} SELECT a.status,t.Job_Status AS jobStatus,COUNT(*) AS n
      FROM latest a JOIN tasks t ON t.id=a.task_id WHERE ${visibleSyncTaskSql()} AND a.department=? AND a.user_id IS NOT NULL AND a.status<>'Unassigned' GROUP BY a.status,t.Job_Status`)
      .all(department)) as { status: string; jobStatus: string | null; n: number }[];
    if (rows.some((row) => !Number.isSafeInteger(row.n) || row.n < 0)) throw new DashboardError(503);
    const sum = (predicate: (row: (typeof rows)[number]) => boolean) => rows.filter(predicate).reduce((n, row) => n + row.n, 0);
    return { department, total: sum(() => true), pending: sum((row) => row.status === "Assigned" &&
      (department !== "PM" || row.jobStatus === null || row.jobStatus === "Active")),
      process: sum((row) => row.status === "Process"), completed: sum((row) => row.status === "Completed"),
      hold: sum((row) => row.status === "Hold") };
  }
  async function personalDepartment(department: DashboardDepartment, userId: string, date: ReturnType<typeof ranges>): Promise<PersonalDepartment> {
    const row = (await db.prepare(`${latestAssignments} SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN a.status='Assigned' AND ${activeJob} THEN 1 ELSE 0 END),0) AS pending,
      COALESCE(SUM(CASE WHEN a.status='Process' AND ${activeJob} THEN 1 ELSE 0 END),0) AS process,
      COALESCE(SUM(CASE WHEN a.status='Completed' THEN 1 ELSE 0 END),0) AS completed,
      COALESCE(SUM(CASE WHEN t.Job_Status='Hold' THEN 1 ELSE 0 END),0) AS hold,
      COALESCE(SUM(CASE WHEN CAST(REPLACE(REPLACE(a.assigned_date,'T',' '),'Z','') AS DATETIME(3))>=CAST(REPLACE(REPLACE(?,'T',' '),'Z','') AS DATETIME(3)) AND CAST(REPLACE(REPLACE(a.assigned_date,'T',' '),'Z','') AS DATETIME(3))<CAST(REPLACE(REPLACE(?,'T',' '),'Z','') AS DATETIME(3)) THEN 1 ELSE 0 END),0) AS assignedToday,
      COALESCE(SUM(CASE WHEN a.status='Completed' AND CAST(REPLACE(REPLACE(a.assigned_date,'T',' '),'Z','') AS DATETIME(3))>=CAST(REPLACE(REPLACE(?,'T',' '),'Z','') AS DATETIME(3)) AND CAST(REPLACE(REPLACE(a.assigned_date,'T',' '),'Z','') AS DATETIME(3))<CAST(REPLACE(REPLACE(?,'T',' '),'Z','') AS DATETIME(3)) THEN 1 ELSE 0 END),0) AS completedAssignedThisMonth
      FROM latest a JOIN tasks t ON t.id=a.task_id WHERE ${visibleSyncTaskSql()} AND a.department=? AND a.user_id=?`)
      .get(date.today, date.tomorrow, date.month, date.nextMonth, department, userId)) as Omit<PersonalDepartment, "department">;
    // MySQL SUM over integral CASE expressions returns DECIMAL strings. Convert
    // only validated bounded counts; monetary readers remain exact strings/BigInt.
    const metrics = Object.fromEntries(Object.entries(row).map(([key, value]) => {
      if (typeof value !== "number" && (typeof value !== "string" || !/^[0-9]+$/.test(value))) throw new DashboardError(503);
      const integer = typeof value === "number" ? value : Number(value);
      if (!Number.isSafeInteger(integer) || integer < 0) throw new DashboardError(503);
      return [key, integer];
    })) as Omit<PersonalDepartment, "department">;
    return { department, ...metrics };
  }
  async function employeeWorkload(query: z.infer<typeof querySchema>): Promise<NonNullable<DashboardResult["global"]>["employees"]> {
    const search = escapedSearch(query.employeeSearch);
    const total = (await count("SELECT COUNT(*) AS n FROM users WHERE username COLLATE utf8mb4_0900_as_ci LIKE ? ESCAPE '!'", search));
    const items = (await db.prepare(`${latestAssignments} SELECT CAST(u.id AS CHAR) AS id,u.username AS name,
      (SELECT COUNT(*) FROM latest a JOIN tasks t ON t.id=a.task_id WHERE a.user_id=u.id AND a.department='Electrical' AND ${won}) AS electrical,
      (SELECT COUNT(*) FROM latest a JOIN tasks t ON t.id=a.task_id WHERE a.user_id=u.id AND a.department='Civil' AND ${won}) AS civil,
      (SELECT COUNT(*) FROM latest a JOIN tasks t ON t.id=a.task_id WHERE a.user_id=u.id AND a.department='PM' AND ${won}) AS pm
      FROM users u WHERE username COLLATE utf8mb4_0900_as_ci LIKE ? ESCAPE '!' ORDER BY u.username COLLATE utf8mb4_0900_as_ci,u.id LIMIT ? OFFSET ?`)
      .all(search, query.employeePageSize, (query.employeePage - 1) * query.employeePageSize)) as EmployeeWorkload[];
    return { items, total, page: query.employeePage, pageSize: query.employeePageSize };
  }
  async function getDashboard(token: string | undefined | null, input: unknown = {}): Promise<DashboardResult> {
    try {
      return (await db.transaction(async () => {
        const actor = (await auth.authenticate(token));
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
          const progress: DepartmentProgress[] = [];
          for (const department of ["Electrical", "Civil", "PM"] as const) progress.push(await departmentProgress(department));
          const localOperations: LocalOperations = {
            pendingAssignmentJobs: (await count(`${latestAssignments} SELECT COUNT(*) AS n FROM tasks t WHERE ${won}
              AND NOT ${importedTaskSql()}
              AND NOT EXISTS(SELECT 1 FROM latest a WHERE a.task_id=t.id AND a.user_id IS NOT NULL AND a.status<>'Unassigned')`)),
            completedJobs: (await count(`SELECT COUNT(*) AS n FROM tasks t WHERE ${visibleSyncTaskSql()} AND NOT ${importedTaskSql()} AND EXISTS(SELECT 1 FROM departments_assign a WHERE a.task_id=t.id)
              AND NOT EXISTS(SELECT 1 FROM departments_assign a WHERE a.task_id=t.id AND a.status<>'Completed')`)),
            accounts: (await accountSummary()),
          };
          result.global = {
            wonJobs: (await count(`SELECT COUNT(*) AS n FROM tasks t WHERE ${won}`)),
            ...localOperations,
            leadsToday: (await count(`SELECT COUNT(*) AS n FROM tasks WHERE ${visibleSyncTaskSql("id")} AND CAST(REPLACE(REPLACE(created_at,'T',' '),'Z','') AS DATETIME(3))>=CAST(REPLACE(REPLACE(?,'T',' '),'Z','') AS DATETIME(3)) AND CAST(REPLACE(REPLACE(created_at,'T',' '),'Z','') AS DATETIME(3))<CAST(REPLACE(REPLACE(?,'T',' '),'Z','') AS DATETIME(3))`, date.today, date.tomorrow)),
            leadsThisMonth: (await count(`SELECT COUNT(*) AS n FROM tasks WHERE ${visibleSyncTaskSql("id")} AND CAST(REPLACE(REPLACE(created_at,'T',' '),'Z','') AS DATETIME(3))>=CAST(REPLACE(REPLACE(?,'T',' '),'Z','') AS DATETIME(3)) AND CAST(REPLACE(REPLACE(created_at,'T',' '),'Z','') AS DATETIME(3))<CAST(REPLACE(REPLACE(?,'T',' '),'Z','') AS DATETIME(3))`, date.month, date.nextMonth)),
            pipeline: (await pipeline()), departmentProgress: progress,
            employees: (await employeeWorkload(parsed.data)),
          };
          const importedDeals = await count(`SELECT COUNT(*) AS n FROM tasks t WHERE ${visibleSyncTaskSql()} AND ${importedTaskSql()}`);
          if (importedDeals > 0) {
            const localDeals = await count(`SELECT COUNT(*) AS n FROM tasks t WHERE ${visibleSyncTaskSql()} AND NOT ${importedTaskSql()}`);
            const importedWonJobs = await count(`SELECT COUNT(*) AS n FROM tasks t WHERE ${won} AND ${importedTaskSql()}`);
            if (importedWonJobs > importedDeals || importedWonJobs > result.global.wonJobs
              || result.global.wonJobs - importedWonJobs > localDeals) throw new DashboardError(503);
            result.sourceCoverage = {
              mode: "zoho-sync", importedDeals, localDeals, importedWonJobs,
              localWonJobs: result.global.wonJobs - importedWonJobs, importedAt: null,
              operationalHistory: "not-imported", users: "local-only", localOperations,
            };
            // Absence of imported PHP operations must not appear as a settled
            // balance, no pending work, or no completed work across both sources.
            result.global.pendingAssignmentJobs = null;
            result.global.completedJobs = null;
            result.global.accounts = { pendingJobs: null, totalPending: null,
              unknownServiceChargeJobs: localOperations.accounts.unknownServiceChargeJobs };
          }
        }
        for (const department of DASHBOARD_DEPARTMENTS) {
          if (actor.permissions.includes(departmentGrants[department])) result.departments.push((await personalDepartment(department, actor.localUserId, date)));
        }
        if (actor.permissions.includes("sales_dashboard.view")) {
          const salesFrom = options.localOwnership ? `FROM tasks t ${localOwnershipJoin} WHERE ${visibleSyncTaskSql()} AND ${localSalesScope}` : `FROM tasks WHERE ${visibleSyncTaskSql("id")} AND assigned_to=?`;
          const ownerValues = options.localOwnership ? [actor.externalUserId, actor.localUserId] : [actor.externalUserId];
          const created = options.localOwnership ? "t.created_at" : "created_at";
          result.sales = {
            total: (await count(`SELECT COUNT(*) AS n ${salesFrom}`, ...ownerValues)),
            today: (await count(`SELECT COUNT(*) AS n ${salesFrom} AND CAST(REPLACE(REPLACE(${created},'T',' '),'Z','') AS DATETIME(3))>=CAST(REPLACE(REPLACE(?,'T',' '),'Z','') AS DATETIME(3)) AND CAST(REPLACE(REPLACE(${created},'T',' '),'Z','') AS DATETIME(3))<CAST(REPLACE(REPLACE(?,'T',' '),'Z','') AS DATETIME(3))`, ...ownerValues, date.today, date.tomorrow)),
            thisMonth: (await count(`SELECT COUNT(*) AS n ${salesFrom} AND CAST(REPLACE(REPLACE(${created},'T',' '),'Z','') AS DATETIME(3))>=CAST(REPLACE(REPLACE(?,'T',' '),'Z','') AS DATETIME(3)) AND CAST(REPLACE(REPLACE(${created},'T',' '),'Z','') AS DATETIME(3))<CAST(REPLACE(REPLACE(?,'T',' '),'Z','') AS DATETIME(3))`, ...ownerValues, date.month, date.nextMonth)),
            stages: (await pipeline(actor.externalUserId, actor.localUserId)).filter((stage) => stage.key !== "big_project" && stage.key !== "unmapped").map(({ key, label, count: n }) => ({ key, label, count: n })),
          };
        }
        return result;
      })());
    } catch (error) {
      if (error instanceof DashboardError) throw error;
      throw new DashboardError(503);
    }
  }
  return { getDashboard };
}
