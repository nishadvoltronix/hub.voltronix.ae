import type { Database } from "better-sqlite3";
import { z } from "zod";
import { createAuthService } from "../auth/service";
import type { EmployeePerformance, PerformanceReport, ReportJobCounts, ReportStages } from "./contracts";

export class ReportError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 503) {
    super(({ 400: "Invalid report filters.", 401: "Sign in required.", 403: "Access denied.", 503: "Report data is temporarily unavailable. Some records may require review." })[status]);
  }
}
const date = z.string().regex(/^(?:19|20|21)[0-9]{2}-[0-9]{2}-[0-9]{2}$/).refine((value) => {
  const time = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
});
const filters = z.object({ dateFrom: date.optional(), dateTo: date.optional(),
  query: z.string().trim().max(120).refine((value) => !value.includes("\0")).default(""),
  page: z.number().int().min(1).max(1_000_000).default(1), pageSize: z.number().int().min(1).max(100).default(25),
}).strict();
const scale = 10n ** 18n;
function decimal(value: string) {
  if (!/^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,18})?$/.test(value)) throw new ReportError(503);
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * scale + BigInt(fraction.padEnd(18, "0"));
}
function format(value: bigint) { return `${value / scale}.${(value % scale).toString().padStart(18, "0").replace(/0+$/, "").padEnd(2, "0")}`; }
const stages = (): ReportStages => ({ qualification: 0, siteVisit: 0, proposal: 0, won: 0, lost: 0, omitted: 0, proposalOmitted: 0 });
const jobs = (): ReportJobCounts => ({ active: 0, hold: 0, closed: 0 });
function countStage(target: ReportStages, status: string) {
  if (["Pending", "Qualification"].includes(status)) target.qualification++;
  else if (status === "Site Visit") target.siteVisit++;
  else if (["Proposal", "Proposal/Price Quote"].includes(status)) target.proposal++;
  else if (["Close to Won", "Closed Won"].includes(status)) target.won++;
  else if (["Close to Lost", "Closed Lost"].includes(status)) target.lost++;
  else if (status === "Omitted") target.omitted++;
  else if (["Proposal-Omitted", "Proposal Omitted"].includes(status)) target.proposalOmitted++;
}
function countJob(target: ReportJobCounts, status: string | null) {
  if (status === null || status === "" || status === "Active") target.active++;
  else if (status === "Hold") target.hold++;
  else if (status === "Closed") target.closed++;
}
type Task = { id: string; owner: string | null; status: string; jobStatus: string | null; charge: string | null };
type Money = { amount: bigint; unknown: number };
function addMoney(total: Money, charge: string | null) { if (charge === null) total.unknown++; else total.amount += decimal(charge); }
const money = (): Money => ({ amount: 0n, unknown: 0 });
const won = (status: string) => status === "Close to Won" || status === "Closed Won";
export function createReportsService(db: Database, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const auth = createAuthService(db, { now });
  function employeePerformance(token: string | null | undefined, input: unknown = {}): PerformanceReport {
    try { return db.transaction(() => {
      const actor = auth.authenticate(token);
      if (!actor) throw new ReportError(401);
      // The source Reports navigation is guarded by dashboard.view (layout.php:362).
      if (!actor.permissions.includes("dashboard.view")) throw new ReportError(403);
      const parsed = filters.safeParse(input); if (!parsed.success) throw new ReportError(400);
      const value = parsed.data;
      const today = new Date(now() + 14_400_000).toISOString().slice(0, 10);
      const dateFrom = value.dateFrom ?? today.slice(0, 8) + "01", dateTo = value.dateTo ?? today;
      if (dateFrom > dateTo) throw new ReportError(400);
      const start = new Date(Date.parse(dateFrom + "T00:00:00Z") - 14_400_000).toISOString();
      const end = new Date(Date.parse(dateTo + "T00:00:00Z") + 86_400_000 - 14_400_000).toISOString();
      const where = "julianday(t.created_at)>=julianday(?) AND julianday(t.created_at)<julianday(?)";
      const search = `%${value.query.replace(/[\\%_]/g, "\\$&")}%`;
      const totalEmployees = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE status='active'").get() as { n: number }).n;
      const total = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE status='active' AND username LIKE ? ESCAPE '\\'").get(search) as { n: number }).n;
      const users = db.prepare(`SELECT CAST(id AS TEXT) AS id,user_id AS externalId,username AS name,department_role AS departmentRole
        FROM users WHERE status='active' AND username LIKE ? ESCAPE '\\' ORDER BY username COLLATE NOCASE,id LIMIT ? OFFSET ?`)
        .all(search, value.pageSize, (value.page - 1) * value.pageSize) as { id: string; externalId: string | null; name: string; departmentRole: string | null }[];
      const selected = new Map(users.map((user) => [user.id, {
        data: { id: user.id, name: user.name, departmentRole: user.departmentRole, totalDeals: 0, wonAmount: "0.00", unknownAmounts: 0,
          ...stages(), ...jobs(), electrical: 0, civil: 0, pm: 0, accounts: 0, assigned: 0, process: 0, completed: 0 } as EmployeePerformance,
        money: money(), sets: new Map<string, Set<string>>(),
      }]));
      const owners = new Map(users.filter((user) => user.externalId !== null).map((user) => [user.externalId!, selected.get(user.id)!]));
      const stageCounts = stages(), wonJobStatuses = jobs();
      const summary: PerformanceReport["summary"] = { activeEmployees: totalEmployees, totalDeals: 0, wonJobs: 0, wonAmount: "0.00", unknownAmounts: 0, ...jobs() };
      const sum = money();
      for (const task of db.prepare(`SELECT CAST(t.id AS TEXT) AS id,t.assigned_to AS owner,t.status,t.Job_Status AS jobStatus,t.service_charge AS charge FROM tasks t WHERE ${where}`).iterate(start, end) as Iterable<Task>) {
        summary.totalDeals++; countStage(stageCounts, task.status); countJob(summary, task.jobStatus);
        if (won(task.status)) { summary.wonJobs++; addMoney(sum, task.charge); countJob(wonJobStatuses, task.jobStatus); }
        const employee = task.owner === null ? undefined : owners.get(task.owner);
        if (employee) { employee.data.totalDeals++; countStage(employee.data, task.status); if (won(task.status)) addMoney(employee.money, task.charge); }
      }
      const latest = `SELECT a.* FROM departments_assign a WHERE a.id=(SELECT MAX(b.id) FROM departments_assign b WHERE b.task_id=a.task_id AND b.department=a.department)`;
      for (const row of db.prepare(`SELECT CAST(a.user_id AS TEXT) AS userId,CAST(a.task_id AS TEXT) AS taskId,a.department,a.status,t.Job_Status AS jobStatus
        FROM (${latest}) a JOIN tasks t ON t.id=a.task_id WHERE a.user_id IS NOT NULL AND ${where}`).iterate(start, end) as Iterable<{ userId: string; taskId: string; department: string; status: string; jobStatus: string | null }>) {
        const employee = selected.get(row.userId); if (!employee) continue;
        const add = (key: string) => { let set = employee.sets.get(key); if (!set) employee.sets.set(key, set = new Set()); set.add(row.taskId); };
        const department = ({ Electrical: "electrical", Civil: "civil", PM: "pm", Accounts: "accounts" } as Record<string, string>)[row.department];
        if (department) add(department);
        const state = ({ Assigned: "assigned", Process: "process", Completed: "completed" } as Record<string, string>)[row.status];
        if (state) add(state);
        const jobStatus = row.jobStatus === null || row.jobStatus === "" || row.jobStatus === "Active" ? "active" : row.jobStatus === "Hold" ? "hold" : row.jobStatus === "Closed" ? "closed" : undefined;
        if (jobStatus) add(jobStatus);
      }
      for (const employee of selected.values()) {
        for (const key of ["electrical", "civil", "pm", "accounts", "assigned", "process", "completed", "active", "hold", "closed"] as const) employee.data[key] = employee.sets.get(key)?.size ?? 0;
        employee.data.unknownAmounts = employee.money.unknown;
        employee.data.wonAmount = employee.money.unknown ? null : format(employee.money.amount);
      }
      summary.unknownAmounts = sum.unknown; summary.wonAmount = sum.unknown ? null : format(sum.amount);
      const monthDate = new Date(today + "T00:00:00Z");
      const monthlySince = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() - 5, 1)).toISOString().slice(0, 10);
      const monthlyStart = new Date(Date.parse(monthlySince + "T00:00:00Z") - 14_400_000).toISOString();
      const months = new Map<string, Money>();
      for (const row of db.prepare(`SELECT strftime('%Y-%m',created_at,'+4 hours') AS month,service_charge AS charge FROM tasks
        WHERE status IN ('Close to Won','Closed Won') AND julianday(created_at)>=julianday(?) ORDER BY created_at`).iterate(monthlyStart) as Iterable<{ month: string; charge: string | null }>) {
        let entry = months.get(row.month); if (!entry) months.set(row.month, entry = money()); addMoney(entry, row.charge);
      }
      return { dateFrom, dateTo, timeZone: "Asia/Dubai" as const, summary, stages: stageCounts, wonJobStatuses,
        employees: { items: [...selected.values()].map((employee) => employee.data), total, page: value.page, pageSize: value.pageSize },
        monthlySince, monthly: [...months].sort(([a], [b]) => a.localeCompare(b)).map(([month, amount]) => ({ month, wonAmount: amount.unknown ? null : format(amount.amount), unknownAmounts: amount.unknown })) };
    })(); } catch (error) { if (error instanceof ReportError) throw error; throw new ReportError(503); }
  }
  return { employeePerformance };
}
