"use client";
import { useId, useState } from "react";
import type { JobRecord } from "@/server/jobs/contracts";
import { message, readApi, writeApi } from "@/components/settings/client";
import { RecordedValue } from "./read-client";
import { Attachments } from "./attachments";
import { JobAssignments } from "./job-assignments";
import { JobSourceDetails } from "./job-source-details";
import { ZohoImportNotice } from "./zoho-import-notice";
function JobForms({ job, onSaved, onBusyChange, refreshing }: {
  job: JobRecord; onSaved: (job: JobRecord) => void; onBusyChange: (busy: boolean) => void; refreshing: boolean;
}) {
  const statusId = useId();
  const remarksId = useId();
  const [jobStatus, setJobStatus] = useState(["Active", "Hold", "Closed"].includes(job.jobStatus ?? "") ? job.jobStatus! : "");
  const [remarks, setRemarks] = useState(job.remarks ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(action: "status" | "remarks") {
    setBusy(true); onBusyChange(true); setError("");
    try {
      const result = await writeApi<JobRecord>("/api/jobs/" + job.id + "/" + action, "PATCH", {
        expectedVersion: job.version, ...(action === "status" ? { jobStatus } : { remarks }),
      });
      // Saving one form must not discard the other form's unsaved input.
      if (action === "status") setJobStatus(result.jobStatus ?? "");
      else setRemarks(result.remarks ?? "");
      onSaved(result);
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); onBusyChange(false); }
  }
  return <>
    {error && <p role="alert" className="error">{error} Reload the job to see its current values before retrying.</p>}
    <div className="row g-3">
      <div className="col-md-5"><section className="card h-100"><div className="card-header"><h2 className="h5 mb-0"><i className="ph ph-flag me-2 text-danger" aria-hidden="true" />Change job status</h2></div><div className="card-body"><form onSubmit={(event) => { event.preventDefault(); void save("status"); }}>
        <label className="form-label" htmlFor={statusId}>Job status</label><select className="form-select" id={statusId} required value={jobStatus} disabled={busy || refreshing} onChange={(event) => setJobStatus(event.target.value)}>
          <option value="">Select job status</option><option>Active</option><option>Hold</option><option>Closed</option>
        </select><p className="field-hint">This changes the whole job status. Department work statuses are separate.</p>
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy || refreshing}>Save job status</button>
      </form></div></section></div>
      <div className="col-md-7"><section className="card h-100"><div className="card-header"><h2 className="h5 mb-0"><i className="ph ph-note-pencil me-2 text-danger" aria-hidden="true" />Administrator remarks</h2></div><div className="card-body"><form onSubmit={(event) => { event.preventDefault(); void save("remarks"); }}>
        <label className="form-label" htmlFor={remarksId}>Administrator remarks</label><textarea className="form-control" id={remarksId} rows={4} maxLength={4000} value={remarks} disabled={busy || refreshing} onChange={(event) => setRemarks(event.target.value)} />
        <p className="field-hint">Leave empty to clear the remarks.</p><button className="btn btn-primary btn-sm" type="submit" disabled={busy || refreshing}>Save remarks</button>
      </form></div></section></div>
    </div>
  </>;
}
export function JobDetails({ initialJob }: { initialJob: JobRecord }) {
  const [job, setJob] = useState(initialJob);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  async function reload() {
    setRefreshing(true); setError(""); setNotice("");
    try { setJob(await readApi<JobRecord>("/api/jobs/" + job.id)); setRevision((value) => value + 1); }
    catch (failure) { setError(message(failure)); }
    finally { setRefreshing(false); }
  }
  return <div className="crm-stack">
    {notice && <p role="status" className="success">{notice}</p>}{error && <p role="alert" className="error">{error}</p>}
    <JobAssignments taskId={job.id} sourceImport={job.sourceImport}><div className="row g-4">
    <div className="col-xxl-3 col-xl-4 col-lg-12"><section className="card" aria-label="Recorded job"><div className="card-header"><h2 className="h5 mb-0">Job Details</h2></div><dl className="legacy-record-list mb-0">
      <div><dt><i className="ph ph-code-block me-1 text-danger" aria-hidden="true" />Deal Name</dt><dd>{job.dealName}</dd></div>
      <div><dt>Account</dt><dd><RecordedValue value={job.accountName} /></dd></div>
      <div><dt>Deal No.</dt><dd><RecordedValue value={job.qualificationNumber} /></dd></div>
      <div><dt>Quote No.</dt><dd><RecordedValue value={job.quotationNumber} /></dd></div>
      <div><dt>Job number</dt><dd><RecordedValue value={job.jobNumber} /></dd></div>
      <div><dt>Sales stage</dt><dd>{job.salesStatus}</dd></div>
      <div><dt>Current job status</dt><dd><span className={"badge " + (job.jobStatus === "Hold" ? "bg-danger-subtle text-danger" : "bg-success-subtle text-success")}><RecordedValue value={job.jobStatus} /></span></dd></div>
      <div><dt>Created</dt><dd><RecordedValue value={job.createdAt} /></dd></div>
      <div><dt>Last updated</dt><dd>{job.updatedAt}</dd></div>
    </dl></section></div>
    <div className="col-xxl-9 col-xl-8 col-lg-12 legacy-detail-content">
      <section className="card"><div className="card-header d-flex align-items-center justify-content-between flex-wrap gap-2"><h1 className="h5 mb-0">Deal Name: {job.dealName}</h1>
        <button type="button" className="btn btn-outline-secondary btn-sm" disabled={refreshing || saving} onClick={() => void reload()}>Reload job</button></div>
        <JobSourceDetails job={job} />
        <div className="card-body"><strong className="text-danger">Administrator Remarks:</strong><p className="preserve-lines mb-0"><RecordedValue value={job.remarks} /></p></div>
      </section>
      {job.sourceImport?.readOnly ? <ZohoImportNotice source={job.sourceImport} />
        : <><JobForms key={job.id + ":" + revision} job={job} refreshing={refreshing} onBusyChange={setSaving} onSaved={(updated) => { setJob(updated); setError(""); setNotice("Job saved."); }} />
      <p className="field-hint my-3">Reloading discards unsaved edits.</p></>}
      <Attachments taskId={job.id} />
    </div></div></JobAssignments>
  </div>;
}
