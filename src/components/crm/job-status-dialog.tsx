"use client";
import { useEffect, useId, useRef, useState } from "react";
import { JOB_STATUSES, type JobRecord } from "@voltronix/crm-contracts";
import { message, writeApi } from "@/components/settings/client";
import { RecordedValue, useRead } from "./read-client";
import { ZohoImportNotice } from "./zoho-import-notice";

/** Source View_Jobs.php holdModal, using the existing authenticated versioned status API. */
export function JobStatusDialog({ initialJob, onClose, onSaved }: { initialJob: JobRecord; onClose: () => void; onSaved: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), saving = useRef(false), id = useId();
  const job = useRead<JobRecord>(`/api/jobs/${initialJob.id}`);
  const [draft, setDraft] = useState<string>(), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const displayed = job.data ?? initialJob;
  const readOnly = initialJob.sourceImport?.readOnly === true || displayed.sourceImport?.readOnly === true;
  const recorded = displayed.jobStatus || "Active";
  const status = draft ?? (JOB_STATUSES.some(value => value === recorded) ? recorded : "");
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  function close() { if (!saving.current) dialog.current?.close(); }
  async function save() {
    if (readOnly || saving.current || !job.data || !status) return;
    saving.current = true; setBusy(true); setError("");
    try {
      await writeApi<JobRecord>(`/api/jobs/${initialJob.id}/status`, "PATCH", { expectedVersion: job.data.version, jobStatus: status });
      onSaved(); dialog.current?.close();
    } catch (failure) { setError(message(failure)); }
    finally { saving.current = false; setBusy(false); }
  }
  return <dialog ref={dialog} className="crm-job-status-dialog" aria-labelledby={id + "title"} onClose={onClose} onCancel={event => { if (saving.current) event.preventDefault(); }}>
    <div className="modal-content shadow-lg border-0"><div className="modal-header bg-dangers text-white"><h2 id={id + "title"} className="h5 text-white mb-0"><i className="ti ti-player-pause me-1" aria-hidden="true" />Are you sure you want to update this project?</h2><button type="button" className="btn-close btn-close-white" aria-label="Close job status" disabled={busy} onClick={close} /></div>
      {readOnly ? <><div className="modal-body"><ZohoImportNotice source={displayed.sourceImport ?? initialJob.sourceImport} /></div><div className="modal-footer"><button type="button" className="btn btn-outline-secondary" onClick={close}>Close</button></div></> : <form onSubmit={event => { event.preventDefault(); void save(); }}><div className="modal-body">
        <div className="text-center mb-4"><h3 className="h5 fw-semibold mb-1"><i className="ph ph-buildings me-1 text-primary" aria-hidden="true" /><RecordedValue value={displayed.accountName} /></h3><p className="text-muted mb-0">Job ID: <strong><RecordedValue value={displayed.jobNumber} /></strong></p></div>
        {job.loading && <p role="status">Loading current job status...</p>}{(job.error || error) && <p role="alert" className="error">{error || job.error} Refresh the job before retrying.</p>}
        <hr /><div className="card border-0 shadow-sm"><div className="card-body text-center"><label className="h6 fw-semibold" htmlFor={id + "status"}>Project Status</label><select className="form-select mt-2" id={id + "status"} required value={status} disabled={busy || !job.data} onChange={event => setDraft(event.target.value)}><option value="">--Select--</option>{JOB_STATUSES.map(value => <option key={value}>{value}</option>)}</select></div></div>
      </div><div className="modal-footer"><button type="button" className="btn btn-outline-secondary" disabled={busy} onClick={close}>Close</button><button type="button" className="btn btn-outline-secondary" disabled={busy} onClick={() => { setDraft(undefined); setError(""); job.reload(); }}>Refresh job</button><button type="submit" className="btn btn-dangers" disabled={busy || !job.data || !status}>Save</button></div></form>}
    </div>
  </dialog>;
}
