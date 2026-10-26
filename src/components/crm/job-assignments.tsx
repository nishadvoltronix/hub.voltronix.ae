"use client";
import { useId, useState, type ReactNode } from "react";
import { DEPARTMENTS, type Department, type JobAssignments as Assignments } from "@/server/departments/contracts";
import { RecordPicker } from "@/components/settings/client";
import { assignmentStatusColor as statusColor, departmentIcons, departmentName, useJobAssignments } from "./job-assignment-state";
import { WorkLogs } from "./work-logs";
import { ZohoImportNotice } from "./zoho-import-notice";
export function JobAssignments({ taskId, sourceImport, children }: { taskId: string; sourceImport?: Assignments["sourceImport"]; children?: ReactNode }) {
  const { result, error, notice, busy, save, refresh } = useJobAssignments(taskId);
  const departmentId = useId(), logId = useId();
  const tabsId = useId();
  const [activeTab, setActiveTab] = useState<"details" | Department>("details");
  const [department, setDepartment] = useState<Department>("Electrical");
  const [logDepartment, setLogDepartment] = useState<Department>("Electrical");
  const [userId, setUserId] = useState("");
  const [accountsId, setAccountsId] = useState("");
  const tabs = ["details", ...DEPARTMENTS] as const;
  const readOnly = sourceImport?.readOnly === true || result.data?.sourceImport?.readOnly === true;
  return <>
    {children && <section className="card"><div className="card-body p-3"><div className="nav nav-pills nav-justified nav-status-tabs" role="tablist" aria-label="Job department details">
      {tabs.map((tab, index) => {
        const assignment = tab === "details" ? undefined : result.data?.assignments.find(value => value.department === tab);
        return <button key={tab} type="button" role="tab" id={`${tabsId}-tab-${tab}`} aria-controls={`${tabsId}-panel-${tab}`} aria-selected={activeTab === tab}
          aria-label={tab === "details" ? "Lead Details" : departmentName(tab)} tabIndex={activeTab === tab ? 0 : -1}
          className={"nav-link d-flex flex-column align-items-center justify-content-center " + (activeTab === tab ? "active" : "")}
          onClick={() => setActiveTab(tab)} onKeyDown={event => {
            const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
            if (next < 0) return;
            const target = tabs[next];
            if (target === undefined) return;
            event.preventDefault(); setActiveTab(target);
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
          }}>
          <span><i className={"ph " + (tab === "details" ? "ph-user-circle" : departmentIcons[tab]) + " me-1"} aria-hidden="true" />{tab === "details" ? "Details" : departmentName(tab)}</span>
          <small>{tab === "details" ? "Lead Details" : result.loading ? "Loading..." : assignment?.status ?? "Not Assigned"}</small>
        </button>;
      })}
    </div></div></section>}
    <div id={`${tabsId}-panel-details`} role={children ? "tabpanel" : undefined} aria-labelledby={children ? `${tabsId}-tab-details` : undefined} hidden={activeTab !== "details"}>
    {children}
    <section className="card mt-4" aria-label="Department assignments"><div className="card-header d-flex align-items-center justify-content-between flex-wrap gap-2"><h2 className="h5 mb-0">Department assignments</h2>
    <button type="button" className="btn btn-outline-secondary btn-sm" disabled={busy} onClick={refresh}>Refresh assignments</button></div><div className="card-body">
    {result.error && <p role="alert">{result.error}</p>}{error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {result.loading && <p role="status">Loading assignments...</p>}
    {result.data && <div className="legacy-assignment-grid mb-4">{DEPARTMENTS.map(value => {
      const assignment = result.data?.assignments.find(item => item.department === value);
      return <article className="card border shadow-sm mb-0" key={value}><div className="card-body text-center p-3">
        <i className={"ph " + departmentIcons[value] + " text-primary f-30"} aria-hidden="true" /><h3 className="h6 my-2">{departmentName(value)}</h3>
        <span className={"badge " + statusColor(assignment?.status)}>{assignment?.status ?? "Not Assigned"}</span>
        <p className="small mt-3 mb-2"><strong>Assigned To:</strong><br />{assignment?.userName ?? "Unassigned"}</p>
        {assignment?.userId && !readOnly && <button type="button" className="btn btn-outline-danger btn-sm" disabled={busy} onClick={() => void save("unassign", { department: value })}>Unassign {value}</button>}
      </div></article>;
    })}</div>}
    {readOnly ? <ZohoImportNotice source={sourceImport ?? result.data?.sourceImport} detail="Local department assignments are not imported from Zoho." /> : <div className="row g-4"><div className="col-lg-7"><h3 className="h6">Assign Department</h3>
    <form onSubmit={(event) => { event.preventDefault(); void save("assignments", { assignments: [{ department, userId }] }); }}><fieldset className="border-0 p-0" disabled={busy || !result.data}>
      <label className="form-label" htmlFor={departmentId}>Assignment department</label><select className="form-select" id={departmentId} value={department} onChange={(event) => { setDepartment(event.target.value as Department); setUserId(""); }}>{DEPARTMENTS.map((value) => <option key={value}>{value}</option>)}</select>
      <RecordPicker<{ id: string; name: string }> key={department} label="Assignment user" path={`/api/departments/${department}/assignees`} value={userId} onChange={setUserId} describe={(row) => row.name} />
      <button className="btn btn-primary btn-sm" type="submit">Assign department</button>
    </fieldset></form></div>
    <div className="col-lg-5"><h3 className="h6">Accounts assignment</h3><p>{result.data?.accounts ? `${result.data.accounts.userName ?? "Unassigned"} (${result.data.accounts.status ?? "Not recorded"})` : "No accounts assignment recorded."}</p>
    <form onSubmit={(event) => { event.preventDefault(); void save("accounts", { userId: accountsId }); }}><fieldset className="border-0 p-0" disabled={busy || !result.data}>
      <RecordPicker<{ id: string; name: string }> label="Accounts user" path="/api/departments/Accounts/assignees" value={accountsId} onChange={setAccountsId} describe={(row) => row.name} /><button className="btn btn-primary btn-sm" type="submit">Assign accounts</button>
    </fieldset></form></div></div>}
  </div></section><section className="card"><div className="card-body"><label className="form-label" htmlFor={logId}>Work log department</label><select className="form-select" id={logId} value={logDepartment} onChange={(event) => setLogDepartment(event.target.value as Department)}>{DEPARTMENTS.map((value) => <option key={value}>{value}</option>)}</select></div></section>
    {activeTab === "details" &&
    <WorkLogs key={logDepartment} path={`/api/jobs/${taskId}/logs?department=${logDepartment}`} />
    }</div>
    {children && DEPARTMENTS.map(value => <div key={value} role="tabpanel" id={`${tabsId}-panel-${value}`} aria-labelledby={`${tabsId}-tab-${value}`} hidden={activeTab !== value}>
      {activeTab === value && <><section className="card"><div className="card-header"><h2 className="h5 mb-0"><i className={"ph " + departmentIcons[value] + " me-2 text-danger"} aria-hidden="true" />{departmentName(value)} Details</h2></div>
        <div className="card-body">{result.data?.assignments.filter(assignment => assignment.department === value).map(assignment => <dl className="legacy-record-list mb-0" key={assignment.id}>
          <div><dt>Assigned To</dt><dd>{assignment.userName ?? "Unassigned"}</dd></div><div><dt>Status</dt><dd><span className={"badge " + statusColor(assignment.status)}>{assignment.status}</span></dd></div>
          <div><dt>Assigned Date</dt><dd>{assignment.assignedAt ?? "Not recorded"}</dd></div></dl>)}
          {result.loading && <p role="status">Loading assignments...</p>}{result.error && <p role="alert">{result.error}</p>}
          {result.data && !result.data.assignments.some(assignment => assignment.department === value) && <p>No department assignment recorded.</p>}</div>
      </section><WorkLogs path={`/api/jobs/${taskId}/logs?department=${value}`} /></>}
    </div>)}
  </>;
}
