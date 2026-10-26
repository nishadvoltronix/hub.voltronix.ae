"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import type { CentralJobPage, CrmWriteCapabilities, Department, JobRecord } from "@voltronix/crm-contracts";
import { Pagination, SearchBox } from "@/components/settings/client";
import { RecordedValue, useRead } from "./read-client";
import { JobAssignmentDialog } from "./job-assignment-dialog";
import { JobStatusDialog } from "./job-status-dialog";
const cohorts = [{ value: "all", label: "All Jobs" }, { value: "pending", label: "Pending Assigning" }, { value: "process", label: "Under Process" }, { value: "completed", label: "Completed" }, { value: "hold", label: "Hold" }, { value: "closed", label: "Closed" }];
const departments: { department: Department; label: string }[] = [{ department: "Electrical", label: "DEWA" }, { department: "Civil", label: "Civil" }, { department: "PM", label: "PM" }, { department: "Switchgear", label: "SWGR" }, { department: "Maintenance", label: "MTN" }];
const departmentColor = (status?: string) => status === "Completed" ? "bg-warning" : status === "Process" ? "bg-purple" : status === "Hold" ? "bg-dangers" : status === "Assigned" ? "bg-danger" : "bg-secondary";
export function Jobs({ initialCohort = "all", initialJobStatus = "all" }: { initialCohort?: string; initialJobStatus?: string }) {
  const statusId = useId(), cohortId = useId(), router = useRouter();
  const [pending, transition] = useTransition();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [assigning, setAssigning] = useState<JobRecord>();
  const [changingStatus, setChangingStatus] = useState<JobRecord>();
  const statusOpener = useRef<HTMLButtonElement>(null);
  const assignmentOpener = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const capabilities = useRead<CrmWriteCapabilities>("/api/capabilities");
  const jobCohorts = capabilities.data?.jobCohorts || capabilities.data?.persistence === "local-demo";
  const params = new URLSearchParams({ query, page: String(page), pageSize: "25", jobStatus: initialJobStatus });
  if (initialCohort !== "all") params.set("cohort", initialCohort);
  const exportParams = new URLSearchParams({ query, jobStatus: initialJobStatus });
  if (initialCohort !== "all") exportParams.set("cohort", initialCohort);
  const result = useRead<CentralJobPage>("/api/jobs?" + params);
  function filter(cohort: string, jobStatus: string) { transition(() => router.push("/jobs?" + new URLSearchParams({ cohort, jobStatus }))); }
  return <div className="crm-stack">
    <section className="card" aria-label="Job search">
      <div className="card-header d-flex align-items-center justify-content-between flex-wrap gap-2"><h2 ref={heading} tabIndex={-1} className="h5 mb-0">{cohorts.find((cohort) => cohort.value === initialCohort)?.label ?? "All Jobs"}</h2>
        {initialCohort === "all" || jobCohorts ? <a className="btn btn-outline-warning btn-sm" href={"/api/jobs/export?" + exportParams}><i className="ph ph-download-simple me-1" aria-hidden="true" />Export jobs (XLSX)</a> : <button className="btn btn-outline-warning btn-sm" type="button" disabled>Export jobs (XLSX)</button>}
      </div>
      <div className="card-body"><div className="row g-3 align-items-end">
        <div className="col-md-6"><SearchBox label="Search jobs" onSearch={(value) => { setQuery(value); setPage(1); }} /></div>
        <div className="col-md-3"><label className="form-label" htmlFor={cohortId}>Job group</label><select className="form-select" id={cohortId} disabled={pending || !jobCohorts} value={initialCohort} onChange={(event) => filter(event.target.value, initialJobStatus)}>{cohorts.map((cohort) => <option key={cohort.value} value={cohort.value}>{cohort.label}</option>)}</select></div>
        <div className="col-md-3"><label className="form-label" htmlFor={statusId}>Job status filter</label><select className="form-select" id={statusId} disabled={pending} value={initialJobStatus} onChange={(event) => filter(initialCohort, event.target.value)}>
          <option value="all">All job statuses</option><option>Active</option><option>Hold</option><option>Closed</option>
        </select></div>
      </div><p className="field-hint mt-2">Active includes local jobs without a recorded job status. Imported Zoho jobs with missing operational history are not counted as Active or Pending Assigning; use All Jobs and All job statuses to view them, if present. Under Process and Completed can overlap when different departments have different statuses.</p><p className="field-hint mt-2">The export includes all pages matching the current search, job group and job status.</p></div>
    </section>
    {result.loading && <p role="status">Loading jobs...</p>}
    {result.error && <p role="alert" className="error">{result.error}</p>}
    {capabilities.error && <p role="alert" className="error">{capabilities.error}</p>}
    {result.data && <section className="card" aria-label="Job results"><div className="card-body">
      <div className="table-responsive table-scroll"><table className="table table-hover mb-0 w-100 crm-central-jobs"><thead><tr><th>Job ID</th><th>Job Date</th><th>Account Name</th><th>Sales Agent</th><th>Job Status</th>{departments.map((item) => <th key={item.department}>{item.label}</th>)}<th className="text-end">Amount</th><th>Action</th></tr></thead><tbody>
        {result.data.items.map((job) => <tr key={job.id}><td><RecordedValue value={job.jobNumber} /></td><td><RecordedValue value={job.jobDate} /></td><td><div className="crm-cell-scroll"><RecordedValue value={job.accountName} /></div></td><td className="text-center"><RecordedValue value={job.assignedName} /></td>
          <td><span className={"crm-status-box " + (job.sourceImport?.readOnly && !job.jobStatus ? "bg-light text-muted" : job.jobStatus === "Hold" ? "crm-status-hold" : job.jobStatus === "Closed" ? "crm-status-closed" : "crm-status-active")}>{job.jobStatus || (job.sourceImport?.readOnly ? "Not imported" : "Active")}</span></td>
          {departments.map((item) => { const assignment = job.departments?.find((value) => value.department === item.department); const absent = job.sourceImport?.readOnly ? "Not imported" : job.departments ? "Not Assigned" : "Not recorded"; const status = assignment?.status || absent, name = assignment?.userName || absent;
            return <td key={item.department}><span className={"badge " + departmentColor(assignment?.status)} title={name} aria-label={`${item.department}: ${status}; assigned to ${name}`}>{status}</span></td>;
          })}<td className="text-end"><RecordedValue value={job.serviceCharge} /></td>
          <td><div className="d-flex gap-1"><Link className="btn btn-outline-secondary btn-sm" href={"/jobs/" + job.id} aria-label={"View job " + job.dealName}><i className="ph ph-eye" aria-hidden="true" /><span className="visually-hidden">View</span></Link>
            {job.sourceImport?.readOnly ? <span className="badge bg-info-subtle text-dark">Zoho · read-only</span> : <>
            <button type="button" className="btn btn-outline-primary btn-sm" title="Assign Department" aria-label={"Assign departments for " + job.dealName} onClick={event => { assignmentOpener.current = event.currentTarget; setAssigning(job); }}><i className="ph ph-pencil" aria-hidden="true" /></button>
            <button type="button" className="btn btn-outline-dangers btn-sm" title="Put Job on Hold" aria-label={"Update status for " + job.dealName} onClick={event => { statusOpener.current = event.currentTarget; setChangingStatus(job); }}><i className="ti ti-player-pause" aria-hidden="true" /></button></>}</div></td></tr>)}
      </tbody></table></div>
      {result.data.total === 0 && <p>No jobs match the current filters.</p>}
      <Pagination data={result.data} page={page} onPage={setPage} />
    </div></section>}
    {assigning && <JobAssignmentDialog key={assigning.id} initialJob={assigning} onSaved={result.reload} onClose={() => { setAssigning(undefined); if (assignmentOpener.current?.isConnected) assignmentOpener.current.focus(); else heading.current?.focus(); }} />}
    {changingStatus && <JobStatusDialog key={changingStatus.id} initialJob={changingStatus} onSaved={result.reload} onClose={() => { setChangingStatus(undefined); if (statusOpener.current?.isConnected) statusOpener.current.focus(); else heading.current?.focus(); }} />}
  </div>;
}
