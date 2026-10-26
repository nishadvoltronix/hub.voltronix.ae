"use client";
import Image from "next/image";
import { logAttachmentExtensions, logAttachmentLimit } from "@voltronix/crm-contracts";
import { useId, useRef, useState } from "react";
import { DEPARTMENTS, LOG_OPTIONS, type Department, type DepartmentJob as Job } from "@/server/departments/contracts";
import { message, readApi, writeApi } from "@/components/settings/client";
import { Attachments } from "./attachments";
import { WorkLogs } from "./work-logs";
import { RecordedValue } from "./read-client";
import { JobSourceDetails } from "./job-source-details";
import { ZohoImportNotice } from "./zoho-import-notice";
function logStatusLabel(department: Department, value: string) {
  if (value === "-") return "Choose...";
  if (value === "Process") return "Under Process";
  if (value === "Hold") return "ON HOLD";
  if (department === "Electrical" && value === "Complete") return "COMPLETE";
  if (department === "Civil" && value === "Completed") return "COMPLETED";
  return value;
}
function DepartmentForms({ job, department, onSaved, onBusy }: { job: Job; department: Department; onSaved: (job: Job) => void; onBusy: (busy: boolean) => void }) {
  const ids = useId();
  const options = LOG_OPTIONS[department];
  const authorities = "authority" in options ? options.authority : undefined;
  const scopes = "scope" in options ? options.scope : undefined;
  const [status, setStatus] = useState(["Process", "Completed"].includes(job.assignment.status) ? job.assignment.status : "Process");
  const [selection, setSelection] = useState("-"); const [logStatus, setLogStatus] = useState("-"); const [comments, setComments] = useState(""); const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const logFile = useRef<HTMLInputElement>(null);
  const statusDialog = useRef<HTMLDialogElement>(null);
  const illustration = { Electrical: "electricgif.gif", Civil: "civilgif.gif", PM: "PM.gif", Switchgear: "switchgear.gif", Maintenance: "Maintenancemtn.gif" }[department];
  const notesLabel = department === "Electrical" ? "Electrician Notes" : `${department} Notes`;
  function clearDraft() { setSelection("-"); setLogStatus("-"); setComments(""); setNotes(""); setError(""); if (logFile.current) logFile.current.value = ""; }
  async function save(kind: "status" | "logs") {
    setBusy(true); onBusy(true); setError(""); setNotice("");
    try {
      const path = `/api/departments/${department}/jobs/${job.id}/${kind}`;
      const values = {
        expectedVersion: job.version, ...(kind === "status" ? { status } : { status: logStatus, ...(authorities ? { authority: selection, comments } : { scope: selection }), notes }),
      };
      const file = kind === "logs" ? logFile.current?.files?.[0] : undefined;
      let updated: Job;
      if (file) {
        const payload = new FormData(); payload.append("payload", JSON.stringify(values)); payload.append("file", file);
        const { csrfToken } = await readApi<{ csrfToken: string }>("/api/auth/csrf");
        const response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrfToken }, body: payload });
        if (!response.ok) { const result = await response.json() as { error?: string }; throw new Error(result.error ?? "Unable to save work log."); }
        updated = await response.json() as Job;
      } else updated = await writeApi<Job>(path, kind === "status" ? "PATCH" : "POST", values);
      if (kind === "logs") { setNotes(""); setComments(""); if (logFile.current) logFile.current.value = ""; } else { statusDialog.current?.close(); setStatus(updated.assignment.status); }
      onSaved(updated); setNotice(kind === "logs" ? "Work log added." : "Department status saved.");
    } catch (failure) { setError(message(failure)); } finally { setBusy(false); onBusy(false); }
  }
  const unavailable = ["Hold", "Closed"].includes(job.jobStatus ?? "");
  return <>{error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}{unavailable && <p>This job is on hold or closed. Department changes are unavailable.</p>}
    <section className="card crm-worker-form" aria-label={department + " work log"}><div className="card-header d-flex justify-content-between align-items-center"><h2 className="h5 mb-0">{department === "PM" ? "Project Manager" : department}</h2><span className={"badge " + (job.assignment.status === "Completed" ? "bg-warning" : job.assignment.status === "Process" ? "bg-purple" : "bg-danger")}>{job.assignment.status}</span></div><div className="card-body"><div className="row g-4"><div className="col-lg-8"><form onSubmit={(event) => { event.preventDefault(); void save("logs"); }}><fieldset disabled={busy || unavailable || job.assignment.status === "Completed"}>
      <div className="crm-worker-field"><label htmlFor={ids + "scope"}>{authorities ? department === "Electrical" ? "DEWA Authority" : "Civil Authority" : "Scope of Work"}</label><div className="input-group"><span className="input-group-text">Options</span><select className="form-select" aria-label={authorities ? "Authority" : "Scope of work"} id={ids + "scope"} value={selection} onChange={(event) => setSelection(event.target.value)}>{(authorities ?? scopes)!.map((value) => <option value={value} key={value}>{value === "-" ? "Choose..." : value}</option>)}</select></div></div>
      <div className="crm-worker-field"><label htmlFor={ids + "log"}>Status</label><div className="input-group"><span className="input-group-text">Options</span><select className="form-select" aria-label="Log status" id={ids + "log"} value={logStatus} onChange={(event) => setLogStatus(event.target.value)}>{options.status.map((value) => <option value={value} key={value}>{logStatusLabel(department, value)}</option>)}</select></div></div>
      {authorities && <div className="crm-worker-field"><label htmlFor={ids + "comments"}>Authority Comments</label><textarea className="form-control" aria-label="Authority comments" id={ids + "comments"} value={comments} maxLength={4000} onChange={(event) => setComments(event.target.value)} /></div>}
      <div className="crm-worker-field"><label htmlFor={ids + "notes"}>{notesLabel}</label><textarea className="form-control" aria-label="Work notes" id={ids + "notes"} value={notes} maxLength={4000} onChange={(event) => setNotes(event.target.value)} /></div>
      <div className="crm-worker-field"><label htmlFor={ids + "file"}>Upload Document</label><input className="form-control" aria-label="Work log attachment (optional)" ref={logFile} id={ids + "file"} type="file" accept={logAttachmentExtensions(department).map(value => "." + value).join(",")} /></div>
      <p className="field-hint">One static GIF, PNG, JPEG or PDF{["Switchgear", "Maintenance"].includes(department) ? ", Excel or CSV" : ""}, up to {(logAttachmentLimit(department) / 1024).toLocaleString("en-US")} KB. Saved with this work log; available to current assigned workers and job managers.</p><div className="actions"><button className="btn btn-primary" type="submit" aria-label="Add work log">Submit</button><button className="btn btn-secondary" type="button" onClick={clearDraft}>Clear</button></div>
      {job.assignment.status === "Completed" && <p className="field-hint">This job is completed and cannot be edited.</p>}
    </fieldset></form></div><div className="col-lg-4 text-center"><Image className="crm-worker-illustration" src={`/legacy/assets/images/${illustration}`} width={360} height={300} alt="" unoptimized /><button type="button" className="btn btn-warning btn-sm" disabled={busy || unavailable} onClick={() => { setStatus(["Process", "Completed"].includes(job.assignment.status) ? job.assignment.status : ""); setError(""); statusDialog.current?.showModal(); }}><i className="ph ph-pen me-1" aria-hidden="true" />Update Status</button></div></div></div></section>
    <dialog ref={statusDialog} className="crm-lead-stage-dialog" aria-labelledby={ids + "status-title"} onCancel={event => { if (busy) event.preventDefault(); }}>
      <div className="modal-content"><div className="modal-header"><h2 id={ids + "status-title"} className="h5 mb-0">{department === "Electrical" ? "Update Status" : `Update ${department} Status`}</h2><button type="button" className="btn-close" aria-label="Close department status" disabled={busy} onClick={() => statusDialog.current?.close()} /></div>
      <form onSubmit={event => { event.preventDefault(); if (status) void save("status"); }}><fieldset disabled={busy || unavailable}><div className="modal-body">{error && <p className="error" role="alert">{error}</p>}<label className="form-label" htmlFor={ids + "status"}>Status <span className="text-danger">*</span></label><select className="form-select" aria-label="Department status" id={ids + "status"} required value={status} onChange={(event) => setStatus(event.target.value)}><option value="">--Select--</option><option value="Process">Under Process</option><option value="Completed">Completed</option></select></div><div className="modal-footer"><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => statusDialog.current?.close()}>Close</button><button type="submit" className="btn btn-primary" aria-label="Save department status" disabled={busy || unavailable || !status}>Save changes</button></div></fieldset></form></div>
    </dialog>
  </>;
}
export function DepartmentJob({ initialJob, department }: { initialJob: Job; department: Department }) {
  const tabsId = useId(); const [tab, setTab] = useState("details");
  const [job, setJob] = useState(initialJob); const [revision, setRevision] = useState(0); const [logsRevision, setLogsRevision] = useState(0);
  const [busy, setBusy] = useState(false); const [refreshing, setRefreshing] = useState(false); const [error, setError] = useState("");
  async function reload() {
    setRefreshing(true); setError("");
    try { setJob(await readApi<Job>(`/api/departments/${department}/jobs/${job.id}`)); setRevision((value) => value + 1); setLogsRevision((value) => value + 1); }
    catch (failure) { setError(message(failure)); } finally { setRefreshing(false); }
  }
  const tabs = [{ key: "details", label: "Details", icon: "ph ph-user-circle" }, ...DEPARTMENTS.map(value => ({
    key: value === department ? "work" : value, label: value === "PM" ? "Project Manager" : value,
    icon: { Electrical: "ph ph-lightning", Civil: "ph ph-buildings", PM: "ph ph-user-gear", Switchgear: "ph ph-plug", Maintenance: "ph ph-wrench" }[value],
  }))];
  return <div className="crm-stack"><section className="card"><div className="card-body p-3"><div className="nav nav-pills nav-justified crm-worker-tabs" role="tablist" aria-label="Job departments">{tabs.map(({ key, label, icon }, index) => <button key={key} id={tabsId + key + "-tab"} className={"nav-link" + (tab === key ? " active" : "")} type="button" role="tab" aria-selected={tab === key} aria-controls={tabsId + key} tabIndex={tab === key ? 0 : -1} onClick={() => setTab(key)} onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = tabs[event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length]!.key; setTab(next); document.getElementById(tabsId + next + "-tab")?.focus(); } }}><i className={icon} aria-hidden="true" /> <span className="d-none d-sm-inline">{label}</span><span className="visually-hidden d-sm-none">{label}</span></button>)}</div></div></section>
    <div id={tabsId + "details"} role="tabpanel" aria-labelledby={tabsId + "details-tab"} hidden={tab !== "details"}><div className="row g-4">
    <div className="col-xxl-3 col-xl-4 col-lg-12"><section className="card" aria-label="Recorded job"><div className="card-header"><h2 className="h5 mb-0">Job Details</h2></div><div className="card-body"><dl className="legacy-record-list mb-0">
      {[["Account", job.accountName], ["Deal No.", job.qualificationNumber], ["Quote No.", job.quotationNumber], ["Job number", job.jobNumber], ["Created", job.createdAt], ["Updated", job.updatedAt], ["Deal status", job.salesStatus], ["Job status", job.jobStatus || (job.sourceImport?.readOnly ? "Not imported" : "Active")], ["Department", department], ["Assigned to", job.assignment.userName], ["Date assigned", job.assignment.assignedAt], ["Your status", job.assignment.status]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd><RecordedValue value={value} /></dd></div>)}
    </dl></div></section></div>
    <div className="col-xxl-9 col-xl-8 col-lg-12 legacy-detail-content"><section className="card"><div className="card-header d-flex align-items-center justify-content-between flex-wrap gap-2"><h1 className="h5 mb-0">{job.dealName}</h1><span className="badge bg-primary">{department} · {job.assignment.status}</span></div>
      {job.sourceImport?.readOnly && <ZohoImportNotice source={job.sourceImport} className="m-3" />}
      <JobSourceDetails job={job} />
      <div className="card-body"><strong className="text-danger">Administrator remarks:</strong><p className="preserve-lines"><RecordedValue value={job.remarks} /></p>
      <button className="btn btn-outline-secondary btn-sm" type="button" disabled={busy || refreshing} onClick={() => void reload()}>Reload department job</button><p className="field-hint mt-2">Reloading discards unsaved edits.</p>{error && <p role="alert">{error}</p>}</div></section>
      <Attachments taskId={job.id} />
    </div></div></div>
    <div id={tabsId + "work"} role="tabpanel" aria-labelledby={tabsId + "work-tab"} hidden={tab !== "work"}><section aria-label={department + " work"}>{job.sourceImport?.readOnly
      ? <ZohoImportNotice source={job.sourceImport} />
      : <fieldset className="crm-worker-workspace" disabled={refreshing}><DepartmentForms key={revision} job={job} department={department} onBusy={setBusy} onSaved={(updated) => { setJob(updated); setLogsRevision((value) => value + 1); }} /></fieldset>}</section>
      <WorkLogs key={logsRevision} department={department} path={`/api/departments/${department}/jobs/${job.id}/logs`} />
    </div>
    {DEPARTMENTS.filter(value => value !== department).map(value => <div key={value} id={tabsId + value} role="tabpanel" aria-labelledby={tabsId + value + "-tab"} hidden={tab !== value}>
      {tab === value && <WorkLogs key={value + logsRevision} department={value} showLatestSubmission path={`/api/departments/${value}/jobs/${job.id}/logs`} />}
    </div>)}
  </div>;
}
