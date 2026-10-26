import type { SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { createAuthService } from "../../tests/sqlite-reference/auth/service.js";
import { createDashboardService, DashboardError } from "../../tests/sqlite-reference/dashboard/service.js";
import { createReportsService, ReportError } from "../../tests/sqlite-reference/reports/service.js";
import type { ReportStages } from "../../tests/sqlite-reference/reports/contracts.js";
import { inspectLocalWorkflowExtension } from "./workflow-schema.js";
import { applyDashboardCoverage } from "./dashboard-coverage.js";
import { applyReportCoverage } from "./report-coverage.js";

type Token = string | null | undefined;
type OwnerTask = { externalOwner: string | null; localOwner: string | null; validLocal: number; status: string; charge: string | null };
// Match the positive local provenance required by workflow.task. A damaged local
// relation must never fall through to external ownership or a guessed creator.
const source = `FROM tasks t LEFT JOIN crm_demo_local_tasks l ON l.task_id=t.id
  LEFT JOIN crm_demo_local_operations o ON o.operation_id=l.creation_operation_id AND o.task_id=t.id`;
const ownerProjection = `t.assigned_to externalOwner,CAST(l.owner_user_id AS TEXT) localOwner,
  CASE WHEN t.zoho_crm_id IS NULL AND t.assigned_to IS NULL AND t.owner_id IS NULL AND t.quote_id IS NULL
    AND t.deal_crm_created_by=l.owner_user_id AND o.actor_user_id=l.owner_user_id AND o.kind='deal.create'
    AND o.remote_effect_possible=0 AND o.remote_references='{}' AND o.state='completed' THEN 1 ELSE 0 END validLocal`;
const reportStages: Record<keyof ReportStages, readonly string[]> = {
  qualification: ["Pending", "Qualification"], siteVisit: ["Site Visit"], proposal: ["Proposal", "Proposal/Price Quote"],
  won: ["Close to Won", "Closed Won"], lost: ["Close to Lost", "Closed Lost"], omitted: ["Omitted"],
  proposalOmitted: ["Proposal-Omitted", "Proposal Omitted"],
};
const salesStages: Record<string, readonly string[]> = {
  qualification: reportStages.qualification, site_visit: reportStages.siteVisit, proposal: reportStages.proposal,
  won: reportStages.won, lost: [...reportStages.lost, "Omitted", "Proposal-Omitted"],
};
const scale = 10n ** 18n;
function decimal(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,18})?$/.test(value)) throw new ReportError(503);
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * scale + BigInt(fraction.padEnd(18, "0"));
}
function format(value: bigint): string {
  return `${value / scale}.${(value % scale).toString().padStart(18, "0").replace(/0+$/, "").padEnd(2, "0")}`;
}
const boundary = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - 14_400_000).toISOString();

/** Demo-only attribution. Reuse the authorized reference response and its
 * filters, pagination, global totals and department counts in one snapshot.
 * Only sales ownership is extended, only for immutable local provenance.
 * Neither the frozen reference nor the MySQL implementation is modified. */
export function createLocalOwnerReports(db: SqliteDatabase, options: { now?: () => number } = {}) {
  const enabled = inspectLocalWorkflowExtension(db), now = options.now ?? Date.now;
  const auth = createAuthService(db, { now }), reports = createReportsService(db, { now }), dashboard = createDashboardService(db, { now });
  function employeePerformance(token: Token, input: unknown = {}) {
    try { return db.transaction(() => {
      const report = applyReportCoverage(db, reports.employeePerformance(token, input));
      if (!enabled) return report;
      const selected = new Map(report.employees.items.map(employee => [employee.id, { employee, amount: 0n }]));
      const users = selected.size ? db.prepare(`SELECT CAST(id AS TEXT) id,user_id externalId FROM users
        WHERE id IN (${[...selected].map(() => "?").join(",")})`).all(...selected.keys()) as { id: string; externalId: string | null }[] : [];
      const external = new Map(users.filter(user => user.externalId !== null).map(user => [user.externalId!, user.id]));
      for (const { employee } of selected.values()) {
        employee.totalDeals = 0; employee.unknownAmounts = 0;
        for (const key of Object.keys(reportStages) as (keyof ReportStages)[]) employee[key] = 0;
      }
      const end = new Date(Date.parse(boundary(report.dateTo)) + 86_400_000).toISOString();
      for (const task of db.prepare(`SELECT ${ownerProjection},t.status,t.service_charge charge ${source}
        WHERE julianday(t.created_at)>=julianday(?) AND julianday(t.created_at)<julianday(?)`)
        .iterate(boundary(report.dateFrom), end) as Iterable<OwnerTask>) {
        if (task.localOwner !== null && task.validLocal !== 1) throw new ReportError(503);
        const owner = task.localOwner ?? (task.externalOwner === null ? undefined : external.get(task.externalOwner));
        const selectedOwner = owner === undefined ? undefined : selected.get(owner);
        if (!selectedOwner) continue;
        const { employee } = selectedOwner; employee.totalDeals++;
        for (const [key, statuses] of Object.entries(reportStages)) {
          if (statuses.includes(task.status)) employee[key as keyof ReportStages]++;
        }
        if (reportStages.won.includes(task.status)) {
          if (task.charge === null) employee.unknownAmounts++;
          else selectedOwner.amount += decimal(task.charge);
        }
      }
      for (const { employee, amount } of selected.values()) employee.wonAmount = employee.unknownAmounts ? null : format(amount);
      return report;
    })(); } catch (error) { if (error instanceof ReportError) throw error; throw new ReportError(503); }
  }
  function getDashboard(token: Token, input: unknown = {}) {
    try { return db.transaction(() => {
      const result = applyDashboardCoverage(db, dashboard.getDashboard(token, input));
      // The reference service owns the section gate. Local ownership is never
      // permission to reveal global data or add an ungranted sales section.
      if (!enabled || !result.sales) return result;
      const actor = auth.authenticate(token); if (!actor) throw new DashboardError(401);
      const dubai = new Date(Date.parse(result.asOf) + 14_400_000);
      const day = dubai.toISOString().slice(0, 10), month = day.slice(0, 8) + "01";
      const today = boundary(day), tomorrow = new Date(Date.parse(today) + 86_400_000).toISOString();
      const nextMonth = new Date(Date.UTC(dubai.getUTCFullYear(), dubai.getUTCMonth() + 1, 1) - 14_400_000).toISOString();
      const rows = db.prepare(`SELECT ${ownerProjection},t.status,
        CASE WHEN julianday(t.created_at)>=julianday(?) AND julianday(t.created_at)<julianday(?) THEN 1 ELSE 0 END today,
        CASE WHEN julianday(t.created_at)>=julianday(?) AND julianday(t.created_at)<julianday(?) THEN 1 ELSE 0 END thisMonth
        ${source} WHERE (l.task_id IS NULL AND t.assigned_to=?) OR l.owner_user_id=?`)
        .all(today, tomorrow, boundary(month), nextMonth, actor.externalUserId, actor.localUserId) as (OwnerTask & { today: number; thisMonth: number })[];
      if (rows.some(row => row.localOwner !== null && row.validLocal !== 1)) throw new DashboardError(503);
      result.sales = { total: rows.length, today: rows.reduce((sum, row) => sum + row.today, 0),
        thisMonth: rows.reduce((sum, row) => sum + row.thisMonth, 0),
        stages: result.sales.stages.map(stage => ({ ...stage, count: rows.filter(row => salesStages[stage.key]?.includes(row.status)).length })) };
      return result;
    })(); } catch (error) { if (error instanceof DashboardError) throw error; throw new DashboardError(503); }
  }
  return { reports: { employeePerformance }, dashboard: { getDashboard } };
}
