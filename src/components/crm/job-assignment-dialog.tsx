"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { JobRecord } from "@/server/jobs/contracts";
import { DEPARTMENTS, type Department } from "@/server/departments/contracts";
import { RecordPicker, message, writeApi } from "@/components/settings/client";
import { assignmentStatusColor, departmentIcons, departmentName, useJobAssignments } from "./job-assignment-state";
import { RecordedValue, useRead } from "./read-client";
import { ZohoImportNotice } from "./zoho-import-notice";

export function JobAssignmentDialog({ initialJob, onClose, onSaved }: {
  initialJob: JobRecord; onClose: () => void; onSaved: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const job = useRead<JobRecord>(`/api/jobs/${initialJob.id}`);
  const assignments = useJobAssignments(initialJob.id, () => { job.reload(); onSaved(); });
  const [selected, setSelected] = useState<Partial<Record<Department, string>>>({});
  const [remarksDraft, setRemarksDraft] = useState<string>();
  const [savedJob, setSavedJob] = useState<JobRecord>();
  const [savingRemarks, setSavingRemarks] = useState(false), [remarksError, setRemarksError] = useState(""), [remarksNotice, setRemarksNotice] = useState("");
  const remarksInFlight = useRef(false);
  const displayedJob = job.data ?? savedJob ?? initialJob;
  const readOnly = initialJob.sourceImport?.readOnly === true || displayedJob.sourceImport?.readOnly === true || assignments.result.data?.sourceImport?.readOnly === true;
  const busy = assignments.busy || savingRemarks;
  const unavailable = busy || !assignments.result.data || !job.data;
  const closed = displayedJob.jobStatus === "Closed";
  const pending = DEPARTMENTS.flatMap(department => selected[department] ? [{ department, userId: selected[department]! }] : []);
  useEffect(() => {
    const element = dialog.current;
    if (!element?.open) element?.showModal();
  }, []);
  function close() { if (!busy && !remarksInFlight.current) dialog.current?.close(); }
  function refresh() { setSelected({}); setRemarksDraft(undefined); setRemarksError(""); setRemarksNotice(""); assignments.refresh(); job.reload(); }
  async function saveRemarks() {
    if (readOnly || busy || remarksInFlight.current || !job.data) return;
    remarksInFlight.current = true; setSavingRemarks(true); setRemarksError(""); setRemarksNotice("");
    try {
      const updated = await writeApi<JobRecord>(`/api/jobs/${initialJob.id}/remarks`, "PATCH", { expectedVersion: job.data.version, remarks: remarksDraft ?? displayedJob.remarks ?? "" });
      setSavedJob(updated); setRemarksDraft(undefined); setRemarksNotice("Remarks updated successfully.");
      // Remarks and assignments share the task version. Both readers must reload.
      assignments.refresh(); job.reload(); onSaved();
    } catch (failure) { setRemarksError(message(failure)); }
    finally { remarksInFlight.current = false; setSavingRemarks(false); }
  }
  return <dialog ref={dialog} className="crm-job-assignment-dialog" aria-labelledby={titleId} onClose={onClose}
    onCancel={event => { if (busy || remarksInFlight.current) event.preventDefault(); }}>
    <div className="modal-content shadow-lg border-0">
      <div className="modal-header bg-primary text-white"><h2 className="h5 text-white mb-0" id={titleId}><i className="ph ph-user-plus me-2" aria-hidden="true" />Assign Departments</h2>
        <button type="button" className="btn btn-close btn-close-white" aria-label="Close job assignments" disabled={busy} onClick={close} /></div>
      {readOnly ? <><div className="modal-body"><ZohoImportNotice source={displayedJob.sourceImport ?? initialJob.sourceImport ?? assignments.result.data?.sourceImport} /></div><div className="modal-footer"><button type="button" className="btn btn-outline-secondary" onClick={close}>Close</button></div></> : <form onSubmit={async event => {
        event.preventDefault();
        if (readOnly || unavailable || closed || pending.length === 0) return;
        if (await assignments.save("assignments", { assignments: pending })) setSelected({});
      }}>
        <div className="modal-body">
          <div className="text-center mb-4"><h3 className="h5 fw-bold text-dark mb-2"><i className="ph ph-buildings text-primary me-2" aria-hidden="true" /><RecordedValue value={displayedJob.accountName} /></h3>
            <div className="d-inline-flex align-items-center px-3 py-1 rounded-pill bg-light border mb-3"><i className="ph ph-hash text-primary me-2" aria-hidden="true" /><span className="text-muted me-1">Job ID:</span><strong><RecordedValue value={displayedJob.jobNumber} /></strong></div>
            <div className="row g-3 text-start"><div className="col-md-6"><div className="bg-light border rounded p-3 h-100"><div className="text-muted small mb-2"><i className="ph ph-chat-text text-primary me-1" aria-hidden="true" />Complaint Description</div><p className="preserve-lines mb-0"><RecordedValue value={displayedJob.complaintDescription} /></p></div></div>
              <div className="col-md-6"><div className="bg-light border rounded p-3 h-100"><label className="text-muted small mb-2" htmlFor={titleId + "remarks"}><i className="ph ph-note-pencil text-primary me-1" aria-hidden="true" />Admin Remarks</label><textarea className="form-control" id={titleId + "remarks"} rows={2} maxLength={4000} placeholder="Enter remarks here..." value={remarksDraft ?? displayedJob.remarks ?? ""} disabled={busy || !job.data} onChange={event => setRemarksDraft(event.target.value)} /><div className="text-end mt-2"><button type="button" className="btn btn-primary btn-sm" disabled={busy || !job.data} onClick={() => void saveRemarks()}><i className="ph ph-floppy-disk me-1" aria-hidden="true" />Save Remarks</button></div>{remarksError && <p role="alert" className="error small mt-2">{remarksError} Refresh assignments to review current values before retrying.</p>}{remarksNotice && <p role="status" className="success small mt-2">{remarksNotice}</p>}</div></div></div>
          </div>
          {job.error && <p role="alert" className="error">{job.error}</p>}
          {assignments.result.error && <p role="alert" className="error">{assignments.result.error}</p>}
          {assignments.error && <p role="alert" className="error">{assignments.error} Refresh assignments to review the latest values before retrying.</p>}
          {assignments.notice && <p role="status" className="success">{assignments.notice}</p>}
          {(job.loading || assignments.result.loading) && <p role="status">Loading current job assignments...</p>}
          {busy && <p role="status">{savingRemarks ? "Saving remarks..." : "Saving assignment changes..."}</p>}
          {closed && <p role="status">This job is closed. Assignments cannot be changed.</p>}
          <hr />
          <fieldset className="border-0 p-0" disabled={unavailable || closed}><legend className="visually-hidden">Department assignments</legend>
            <div className="crm-assignment-cards">{DEPARTMENTS.map(department => {
              const assignment = assignments.result.data?.assignments.find(value => value.department === department);
              const unassignReason = closed ? "Cannot unassign from a closed job" : assignment?.status === "Completed" ? "Cannot unassign a completed department" : !assignment?.userId ? "No user assigned" : undefined;
              return <section key={department} className="card h-100 border-0 shadow-sm mb-0"><div className="card-body text-center p-3">
                <div className="d-flex justify-content-end mb-2"><button type="button" className="btn btn-sm btn-danger" disabled={unavailable || Boolean(unassignReason)} title={unassignReason ?? `Unassign ${assignment?.userName ?? departmentName(department)}`} aria-label={`Unassign ${department}`}
                  onClick={async () => {
                    if (unavailable || unassignReason || !window.confirm(`Are you sure you want to unassign ${assignment?.userName ?? "this user"} from ${departmentName(department)}?`)) return;
                    if (await assignments.save("unassign", { department })) setSelected(values => ({ ...values, [department]: "" }));
                  }}><i className="ph ph-user-minus" aria-hidden="true" /></button></div>
                <i className={`ph ${departmentIcons[department]} text-primary f-30`} aria-hidden="true" /><h3 className="h6 my-2">{department === "Electrical" ? "DEWA Approval" : departmentName(department)}</h3>
                <span className={`badge ${assignmentStatusColor(assignment?.status)}`}>{assignments.result.loading ? "Loading..." : assignments.result.data ? assignment?.status ?? "Not Assigned" : "Unavailable"}</span>
                <RecordPicker<{ id: string; name: string }> path={`/api/departments/${department}/assignees`} label={`${departmentName(department)} user`} required={false} value={selected[department] ?? ""} onChange={value => setSelected(values => ({ ...values, [department]: value }))} describe={user => user.name} />
                <p className="small mt-3 mb-0"><strong>Assigned To:</strong><br />{assignments.result.loading ? "Loading..." : assignments.result.data ? assignment?.userName ?? "Not Assigned" : "Unavailable"}</p>
              </div></section>;
            })}</div>
          </fieldset>
          <p className="field-hint mt-3 mb-0">Select only the departments to change. Empty selections leave existing assignments unchanged. Refreshing clears unsaved selections.</p>
        </div>
        <div className="modal-footer"><button className="btn btn-outline-secondary" type="button" disabled={busy} onClick={close}><i className="ph ph-x me-1" aria-hidden="true" />Close</button>
          <button className="btn btn-outline-secondary" type="button" disabled={busy} onClick={refresh}>Refresh assignments</button>
          <button className="btn btn-primary" type="submit" disabled={unavailable || closed || pending.length === 0}><i className="ph ph-check-circle me-1" aria-hidden="true" />Save Assignments</button></div>
      </form>}
    </div>
  </dialog>;
}
