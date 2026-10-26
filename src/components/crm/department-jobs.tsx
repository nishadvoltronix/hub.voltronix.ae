"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useId, useState } from "react";
import { ASSIGNMENT_STATUSES, type Department, type DepartmentJob, type Page } from "@/server/departments/contracts";
import { Pagination, SearchBox } from "@/components/settings/client";
import { RecordedValue, useRead } from "./read-client";
export function DepartmentJobs({ department }: { department: Department }) {
  const id = useId();
  const router = useRouter(); const search = useSearchParams();
  const selectedStatus = search.get("status");
  const status = selectedStatus && ASSIGNMENT_STATUSES.some(value => value === selectedStatus) ? selectedStatus : "all";
  const [query, setQuery] = useState(""); const [page, setPage] = useState(1);
  const result = useRead<Page<DepartmentJob>>(`/api/departments/${department}/jobs?` + new URLSearchParams({ query, page: String(page), pageSize: "25", status }));
  return <div className="crm-stack"><h1>{department} jobs</h1><section className="card">
    <div className="card-header d-flex align-items-center justify-content-between flex-wrap gap-2"><h2 className="h5 mb-0">{department === "PM" ? "Project Manager" : department} Jobs</h2>
      <a className="btn btn-outline-warning btn-sm" href={`/api/departments/${department}/export?` + new URLSearchParams({ query })}><i className="ph ph-download-simple me-1" aria-hidden="true" />Export assigned jobs (XLSX)</a></div>
    <div className="card-body"><div className="row g-3 align-items-end"><div className="col-md-8"><SearchBox label="Search department jobs" onSearch={(value) => { setQuery(value); setPage(1); }} /></div>
    <div className="col-md-4"><label className="form-label" htmlFor={id}>Department status filter</label><select className="form-select" id={id} value={status} onChange={(event) => { const selected = event.target.value; setPage(1); router.push(`/departments/${department}/jobs` + (selected === "all" ? "" : `?status=${selected}`)); }}><option value="all">All statuses</option>{ASSIGNMENT_STATUSES.map((value) => <option key={value}>{value}</option>)}</select></div></div>
    <p className="field-hint mt-2">The export uses the current search across all your department statuses.</p></div>
  </section>{result.error && <p role="alert">{result.error}</p>}{result.loading && <p role="status">Loading department jobs...</p>}
    {result.data && <section className="card" aria-label="Assigned jobs"><div className="card-body"><div className="table-responsive table-scroll"><table className="table table-hover mb-0 w-100 crm-department-jobs"><thead><tr><th>Date Assigned</th><th>Job ID</th><th>Job Date</th><th>Account Name</th><th>Deal Status</th><th>Overall Status</th><th>Department</th><th>Department Assigned To</th><th>Your Status</th><th>Action</th></tr></thead><tbody>
      {result.data.items.map((job) => <tr key={job.id}><td><RecordedValue value={job.assignment.assignedAt} /></td><td><RecordedValue value={job.jobNumber} /></td><td><RecordedValue value={job.jobDate} /></td><td><RecordedValue value={job.accountName} /></td><td><span className="badge bg-warning">{job.salesStatus}</span></td><td><span className={"badge " + (["Hold", "Closed"].includes(job.jobStatus ?? "") ? "bg-danger-subtle text-danger" : "bg-success-subtle text-success")}>{job.jobStatus || "Active"}</span></td><td>{job.assignment.department}</td><td><RecordedValue value={job.assignment.userName} /></td><td><span className={"badge " + (job.assignment.status === "Completed" ? "bg-warning" : job.assignment.status === "Process" ? "bg-purple" : "bg-danger")}>{job.assignment.status}</span></td><td><Link className="btn btn-sm btn-outline-primary" aria-label={"View department job " + job.dealName} href={`/departments/${department}/jobs/${job.id}`}><i className="ph ph-pencil me-1" aria-hidden="true" />{job.dealName}</Link></td></tr>)}
    </tbody></table></div>{result.data.total === 0 && <p>No assigned jobs match the current filters.</p>}<Pagination data={result.data} page={page} onPage={setPage} /></div></section>}
  </div>;
}
