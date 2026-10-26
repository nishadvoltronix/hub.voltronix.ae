"use client";
import { useState } from "react";
import type { EmployeePerformance, PerformanceReport } from "@/server/reports/contracts";
import { Pagination, SearchBox } from "@/components/settings/client";
import { useRead } from "./read-client";
const employeeColumns: [keyof EmployeePerformance, string][] = [
  ["totalDeals", "Deals"], ["qualification", "Qualification"], ["siteVisit", "Site visit"], ["proposal", "Proposal"], ["won", "Won"],
  ["lost", "Lost"], ["omitted", "Omitted"], ["proposalOmitted", "Proposal omitted"], ["wonAmount", "Won amount (AED)"],
  ["electrical", "Electrical"], ["civil", "Civil"], ["pm", "PM"], ["accounts", "Accounts department jobs"],
  ["assigned", "Assigned"], ["process", "Process"], ["completed", "Completed"], ["active", "Active jobs"], ["hold", "Hold jobs"], ["closed", "Closed jobs"],
];
function Donut({ values, colors, label }: { values: [string, number][]; colors: string[]; label: string }) {
  const total = values.reduce((sum, [, value]) => sum + value, 0);
  return <><svg viewBox="0 0 220 220" className="crm-report-chart" role="img" aria-label={label}>
    <circle cx="110" cy="110" r="78" fill="none" stroke="#eef0f4" strokeWidth="55" />
    {values.map(([name, value], index) => { const length = total ? value / total * 100 : 0;
      const start = total ? values.slice(0, index).reduce((sum, [, count]) => sum + count, 0) / total * 100 : 0;
      return <circle key={name} cx="110" cy="110" r="78" fill="none" stroke={colors[index]} strokeWidth="55" pathLength="100" strokeDasharray={`${length} ${100 - length}`} strokeDashoffset={-start} transform="rotate(-90 110 110)"><title>{name}: {value}</title></circle>;
    })}</svg><ul className="crm-chart-legend">{values.map(([name, value], index) => <li key={name}><span style={{ background: colors[index] }} />{name}: {value}</li>)}</ul></>;
}
function SummaryCard({ label, value, detail, icon, tone = "primary" }: { label: string; value: number | string; detail?: string; icon?: string; tone?: string }) {
  return <div className={`report-card${icon ? "" : " text-center"}`}><div className={icon ? "d-flex align-items-center gap-3" : undefined}>{icon && <div className={`report-icon ${tone === "purple" ? "bg-purple text-white" : `bg-${tone}-subtle text-${tone}`}`}><i className={`ti ${icon} fs-3`} aria-hidden="true" /></div>}
    <div><div className="report-label">{label}</div><p className={`report-value${icon ? "" : ` text-${tone}`}`}>{value}</p>{detail && <small className="text-muted">{detail}</small>}</div></div></div>;
}
export function EmployeeReport() {
  const [dateFrom, setFrom] = useState(""); const [dateTo, setTo] = useState("");
  const [query, setQuery] = useState(""); const [page, setPage] = useState(1);
  const params = new URLSearchParams({ query, page: String(page), pageSize: "25" });
  if (dateFrom) params.set("dateFrom", dateFrom); if (dateTo) params.set("dateTo", dateTo);
  const report = useRead<PerformanceReport>("/api/reports/employee-performance?" + params);
  const data = report.data;
  const coverage = data?.sourceCoverage;
  const snapshot = coverage?.mode === "local-zoho-snapshot";
  const synced = coverage?.mode === "zoho-sync";
  const limitedHistory = coverage?.operationalHistory === "not-imported";
  const lastSyncedAt = coverage?.lastSyncedAt && Number.isFinite(Date.parse(coverage.lastSyncedAt)) ? coverage.lastSyncedAt : null;
  return <div className="crm-report">
    <div className="row align-items-end mb-3"><div className="col-xl-6"><h4 className="fw-bold mb-1">Employee Performance Report</h4><p className="text-muted mb-0">Reports <i className="ti ti-chevron-right mx-1" aria-hidden="true" />Employees <i className="ti ti-chevron-right mx-1" aria-hidden="true" />Employee Performance</p></div>
      <div className="col-xl-6"><form key={`${data?.dateFrom ?? ""}:${data?.dateTo ?? ""}`} className="search-form" onSubmit={(event) => { event.preventDefault(); const values = new FormData(event.currentTarget); setFrom(String(values.get("from") ?? "")); setTo(String(values.get("to") ?? "")); setPage(1); }}>
        <label>From date<input className="form-control form-control-sm" type="date" name="from" defaultValue={data?.dateFrom ?? ""} /></label><label>To date<input className="form-control form-control-sm" type="date" name="to" defaultValue={data?.dateTo ?? ""} /></label><button className="btn btn-sm btn-primary" aria-label="Apply dates">Filter</button>
      </form></div></div>
    {report.loading && <p role="status">Loading report...</p>}{report.error && <p className="error" role="alert">{report.error}</p>}
    {data && <>
      {limitedHistory && <section className="notice" aria-label="Report data coverage">
        <h2>{snapshot ? "Mixed local records and Zoho snapshot" : "Saved Hub and Zoho records"}</h2>
        <p>Deal counts, stages and won amounts combine {snapshot ? "local records with the saved Zoho snapshot" : "Hub records with saved Zoho deals"}. The selected date range includes {coverage.importedDeals.toLocaleString("en-US")} imported deals ({coverage.importedWonJobs.toLocaleString("en-US")} won). {snapshot ? "This is not a live Zoho report." : "This report does not start a Zoho synchronization."}</p>
        {snapshot ? <p>Employees, department workload and Active / Hold / Closed job states use local records only. Imported deals are excluded from those operational counts because their assignment and job-status history has not been imported. Local users may include demo accounts; they are not the live CRM employee list.</p>
          : <p>Legacy CRM operational history has not been imported. Job status totals use recorded states; missing imported states are excluded, not counted as zero or active work. Department figures use recorded Hub assignments. Employees are active Hub accounts, including linked Zoho users.</p>}
        {lastSyncedAt && <p>Imported Zoho deals last saved: <time dateTime={lastSyncedAt}>{new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Dubai" }).format(new Date(lastSyncedAt))}</time> (Asia/Dubai).</p>}
      </section>}
      <section className="crm-report-summary" aria-label="Report summary">
        <SummaryCard label={snapshot ? "Local Employees" : synced ? "Hub Employees" : "Total Employees"} value={data.summary.activeEmployees} detail={snapshot ? "Active local accounts only" : synced ? "Active Hub accounts" : "Active Employees"} icon="ti-users" />
        <SummaryCard label="Total Deals" value={data.summary.totalDeals} detail={limitedHistory ? `${snapshot ? "Local" : "Hub"} + imported deals · all stages` : "All Stages"} icon="ti-briefcase" tone="success" />
        <SummaryCard label="Won Jobs" value={data.summary.wonJobs} detail={`${(data.summary.totalDeals ? data.summary.wonJobs / data.summary.totalDeals * 100 : 0).toFixed(2)}% Win Rate${limitedHistory ? " · " + (snapshot ? "local" : "Hub") + " + imported" : ""}`} icon="ti-trophy" tone="warning" />
        <SummaryCard label="Total Won Amount" value={data.summary.wonAmount === null ? "Unavailable" : `AED ${data.summary.wonAmount}`} detail={limitedHistory ? `${snapshot ? "Local" : "Hub"} + imported won deals; not payments` : "Closed Won Deals"} icon="ti-cash" tone="purple" />
        <SummaryCard label={snapshot ? "Local Active Jobs" : synced ? "Recorded Active Jobs" : "Active"} value={data.summary.active} detail={synced ? "Known job states only" : undefined} tone="success" /><SummaryCard label={snapshot ? "Local Hold Jobs" : synced ? "Recorded Hold Jobs" : "Hold Jobs"} value={data.summary.hold} detail={snapshot ? "Local records only" : synced ? "Known job states only" : "On Hold"} tone="danger" />
      </section>
      {data.summary.unknownAmounts > 0 && <p className="notice">{data.summary.unknownAmounts} won deals have no recorded service charge.</p>}
      <div className="row g-3 mb-3">
        <div className="col-lg-4"><section className="chart-box" aria-label="Sales stages"><h6 className="fw-bold mb-3">Deals by Stage</h6>{limitedHistory && <p className="field-hint mb-3">{snapshot ? "Local" : "Hub"} + imported deals. Only the listed stages are represented in this chart.</p>}<Donut label="Deals by stage" colors={["#3b82f6", "#22c55e", "#facc15", "#a855f7", "#ef4444", "#9ca3af"]} values={[
          ["Qualification", data.stages.qualification], ["Site Visit", data.stages.siteVisit], ["Proposal / Price Quote", data.stages.proposal], ["Closed Won", data.stages.won], ["Closed Lost", data.stages.lost], ["Omitted", data.stages.omitted + data.stages.proposalOmitted],
        ]} /></section></div>
        <div className="col-lg-4"><section className="chart-box" aria-label="Won job states"><h6 className="fw-bold mb-3">{snapshot ? "Local Job Status Overview" : synced ? "Recorded Job Status Overview" : "Job Status Overview"}</h6>{limitedHistory && <p className="field-hint mb-3">{snapshot ? "Local won jobs only. Imported job statuses are not available." : "Known won-job states only. Missing imported job statuses are excluded."}</p>}<Donut label="Won job states" colors={["#14b8a6", "#fbbf24", "#9ca3af"]} values={[["Active Jobs", data.wonJobStatuses.active], ["Hold Jobs", data.wonJobStatuses.hold], ["Closed Jobs", data.wonJobStatuses.closed]]} /></section></div>
        <div className="col-lg-4"><section className="chart-box" aria-label="Monthly won amounts"><h6 className="fw-bold mb-3">Total Won Amount by Month</h6>
          {limitedHistory && <p className="field-hint mb-3">{snapshot ? "Local" : "Hub"} + imported won deals; not payment receipts. This chart uses its own date range below.</p>}
          <div className="crm-monthly-chart" role="img" aria-label="Won amount by month">{data.monthly.map((row) => {
            const largest = Math.max(1, ...data.monthly.map((item) => Number(item.wonAmount ?? "0")));
            return <div key={row.month}><span className="crm-monthly-value">{row.wonAmount ?? "Unavailable"}</span><span className="crm-monthly-bar" style={{ height: `${row.wonAmount === null ? 0 : Math.max(0, Number(row.wonAmount)) / largest * 180}px` }} /><small>{row.month}</small></div>;
          })}{data.monthly.length === 0 && <p>No won amounts are recorded.</p>}</div>
          <details><summary>Monthly values and missing charges</summary><p className="field-hint">From {data.monthlySince}, independently of the selected date range. Months without won deals are omitted.</p><div className="table-scroll"><table><thead><tr><th>Month</th><th>Amount (AED)</th><th>Missing charges</th></tr></thead><tbody>{data.monthly.map((row) => <tr key={row.month}><td>{row.month}</td><td>{row.wonAmount ?? "Unavailable"}</td><td>{row.unknownAmounts}</td></tr>)}</tbody></table></div></details>
        </section></div>
      </div>
      <section className="table-card" aria-label="Employee results"><div className="p-3 border-bottom"><h5 className="mb-0 fw-bold">{snapshot ? "Local Employee Performance Details" : "Employee Performance Details"}</h5></div><div className="p-3">{limitedHistory && <p className="notice">{snapshot ? "Local employee accounts" : "Hub employee accounts"} and exact user mappings only. Unmapped imported deal owners are not assigned to these employees. Department and job-status counts exclude missing imported operational history.</p>}<SearchBox label={snapshot ? "Search local report employees" : "Search report employees"} onSearch={(value) => { setQuery(value); setPage(1); }} />
        <p className="field-hint">Scroll the table horizontally to view all employee metrics.</p>
        <div className="table-scroll" role="region" aria-label="Employee metrics table" tabIndex={0}><table className="table employee-metrics"><thead><tr><th>Employee</th><th>Department role</th>{employeeColumns.map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead><tbody>
          {data.employees.items.map((row) => <tr key={row.id}><th>{row.name}</th><td>{row.departmentRole ?? "Not recorded"}</td>{employeeColumns.map(([key]) => <td key={key}>{row[key] ?? "Unavailable"}</td>)}</tr>)}
        </tbody></table></div><Pagination data={data.employees} page={page} onPage={setPage} />
      </div></section>
      <p className="field-hint mt-3">Task creation dates: {data.dateFrom} to {data.dateTo}, Asia/Dubai. {snapshot ? "Local closed jobs (all stages)" : synced ? "Recorded closed jobs (all stages)" : "Closed jobs (all stages)"}: {data.summary.closed}.</p>
    </>}
  </div>;
}
