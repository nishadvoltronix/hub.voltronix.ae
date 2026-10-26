import Link from "next/link";
import type { DashboardResult } from "@/server/dashboard/types";

const stages = [
  { key: "qualification", label: "Qualification", icon: "ph-clock-clockwise" },
  { key: "site_visit", label: "Site Visit", icon: "ph-map-pin" },
  { key: "proposal", label: "Proposal", icon: "ph-note-pencil" },
  { key: "won", label: "Won", icon: "ph-trophy" },
  { key: "lost", label: "Lost", icon: "ph-x-circle" },
] as const;

export function EmployeeSalesDashboard({ sales }: { sales: NonNullable<DashboardResult["sales"]> }) {
  const totals = [
    { key: "today", label: "Total Assigned Today", count: sales.today, icon: "ph-calendar-check" },
    { key: "month", label: "Total Assigned This Month", count: sales.thisMonth, icon: "ph-chart-line-up" },
    { key: "total", label: "Total Leads Assigned", count: sales.total, icon: "ph-stack" },
  ];

  return <section className="crm-employee-sales" aria-label="Your sales leads">
    <div className="crm-employee-sales-header">
      <h2>Sales</h2>
      <Link className="crm-employee-sales-link" href="/pipeline?scope=own">View my assigned leads <i className="ph ph-arrow-right" aria-hidden="true" /></Link>
    </div>
    <div className="crm-employee-sales-stages">
      {stages.map(stage => <div className="card crm-employee-sales-stage" key={stage.key}
        title={stage.key === "lost" ? "Includes lost and omitted leads" : undefined}>
        <div className="crm-employee-sales-stage-copy">
          <p className="crm-employee-sales-value">{sales.stages.find(metric => metric.key === stage.key)?.count ?? "—"}</p>
          <h3>{stage.label}</h3>
        </div>
        <span className={`crm-employee-sales-icon crm-employee-sales-icon-${stage.key}`}><i className={`ph ${stage.icon}`} aria-hidden="true" /></span>
      </div>)}
    </div>
    <div className="crm-employee-sales-totals">
      {totals.map(total => <div className={`card crm-employee-sales-total crm-employee-sales-total-${total.key}`} key={total.key}
        aria-describedby={total.key !== "total" ? "employee-sales-date-basis" : undefined}
        title={total.key === "total" ? "All your assigned leads, including other stages" : undefined}>
        <i className={`ph ${total.icon}`} aria-hidden="true" />
        <h3>{total.label}</h3>
        <p className="crm-employee-sales-total-value">{total.count}</p>
      </div>)}
    </div>
    <p className="field-hint crm-employee-sales-date-basis" id="employee-sales-date-basis">Today and this month use the creation dates of your currently assigned leads (Asia/Dubai).</p>
  </section>;
}
