"use client";
import { assertPersistenceReceipt, hasLocalRecordWorkflow, hasRemoteWorkflow, isLocalPersistence } from "@voltronix/crm-contracts";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CrmWriteCapabilities } from "@voltronix/crm-contracts";
import type { LeadMutationCapabilities, LeadMutationResult } from "@/server/lead-mutations/contracts";
import type { LeadNote } from "@/server/leads/contracts";
import { message, writeApi } from "@/components/settings/client";
import { useRead } from "./read-client";
import { createLocalWriteState } from "./local-write-state";
import { ZohoImportNotice } from "./zoho-import-notice";

export function LeadMutationControls({ taskId, sourceImport, currentStatus, currentServiceCharge, notes = [], stageActionTarget, noteActionTargets, onReload }: { taskId: string; sourceImport?: LeadMutationCapabilities["sourceImport"]; currentStatus?: string; currentServiceCharge?: string | null; notes?: LeadNote[]; stageActionTarget?: HTMLElement | null; noteActionTargets?: Readonly<Record<string, HTMLElement | null>>; onReload: () => void }) {
  const router = useRouter(), capabilities = useRead<LeadMutationCapabilities>(`/api/leads/${taskId}/capabilities`);
  const writes = useRead<CrmWriteCapabilities>("/api/capabilities");
  const id = useId();
  const [noteId, setNoteId] = useState(""), [title, setTitle] = useState(""), [content, setContent] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [stage, setStage] = useState(""), [serviceCharge, setServiceCharge] = useState("");
  const stageOperation = useRef(createLocalWriteState());
  const stageDialog = useRef<HTMLDialogElement>(null);
  const noteDialog = useRef<HTMLDialogElement>(null);
  const request = useRef<{ key: string; operationId: string } | null>(null);
  const data = capabilities.data;
  const readOnly = sourceImport?.readOnly === true || data?.sourceImport?.readOnly === true;
  const localNotes = !readOnly && data?.canWriteNotes && !data.blockedOperationId
    && ((isLocalPersistence(writes.data?.persistence) && writes.data.leadNotes && (writes.data.persistence === "local-demo" || data.persistence === "local-mysql"))
      || hasLocalRecordWorkflow(writes.data, data.persistence));
  const localStage = !readOnly && hasLocalRecordWorkflow(writes.data, data?.persistence) && data?.canChangeStage && !data.blockedOperationId;
  const remoteWrite = !readOnly && hasRemoteWorkflow(writes.data) && data?.persistence === "zoho" && data.integrationAvailable && !data.blockedOperationId;
  const canWriteNotes = localNotes || (remoteWrite && writes.data?.leadNotes && data?.canWriteNotes);
  const canChangeStage = localStage || (remoteWrite && data?.canChangeStage);
  const stageButton = data?.canChangeStage ? <button type="button" className="btn btn-warning btn-sm" disabled={!canChangeStage || busy || !data.stages.length} onClick={() => { setError(""); setStage(""); setServiceCharge(""); stageDialog.current?.showModal(); }}><i className="ph ph-pen me-1" aria-hidden="true" />Update Status</button> : null;
  function openNote(note?: LeadNote) {
    setNoteId(note?.id ?? ""); setTitle(note?.title ?? ""); setContent(note?.content ?? ""); setError(""); setNotice(""); noteDialog.current?.showModal();
  }
  const noteButtons = data?.canWriteNotes ? [{ key: "new", button: <button type="button" className="btn btn-primary btn-sm" disabled={!canWriteNotes || busy} onClick={() => openNote()}><i className="ph ph-note-pencil me-1" aria-hidden="true" />Add Note</button> },
    ...notes.map(note => ({ key: note.id, button: <button type="button" className="btn btn-outline-warning btn-sm py-0 px-2" title="Edit Note" aria-label={`Edit note: ${note.title}`} disabled={!canWriteNotes || busy} onClick={() => openNote(note)}><i className="ph ph-pencil-simple" aria-hidden="true" /></button> }))] : [];
  function reload() { capabilities.reload(); writes.reload(); onReload(); router.refresh(); }
  return <section className="panel" aria-label="Lead changes"><h2>Lead changes</h2>
    <button type="button" className="secondary" disabled={busy} onClick={() => { setNoteId(""); setTitle(""); setContent(""); setStage(""); setServiceCharge(""); request.current = null; setError(""); setNotice(""); reload(); }}>Reload lead</button>
    {capabilities.loading && <p role="status">Loading available lead actions…</p>}
    {capabilities.error && <p className="error" role="alert">{capabilities.error}</p>}
    {writes.error && <p className="error" role="alert">{writes.error}</p>}{error && <p className="error" role="alert">{error}</p>}{notice && <p className="success" role="status">{notice}</p>}
    {readOnly ? <ZohoImportNotice source={sourceImport ?? data?.sourceImport} /> : data && (!data.canWriteNotes && !data.canChangeStage ? <p>Your account can read this lead but cannot change it.</p> : <>
      <p className="notice">{remoteWrite ? "Changes are saved in Zoho and recorded in Hub after verification." : localStage ? "Changes to this local deal are saved locally. They are not synchronized with Zoho." : localNotes ? "Lead notes are saved locally and are not synchronized with Zoho. Stage changes for existing Zoho records require an approved connection." : "Lead changes require an approved Zoho connection. Submission is unavailable until that connection is verified."}</p>
      {data.blockedOperationId && <p role="alert" className="error">An earlier integration operation needs reconciliation before another change can be submitted.</p>}
      <div className="settings-grid">
        {data.canChangeStage && <div>{stageActionTarget ? createPortal(stageButton, stageActionTarget) : stageButton}
          <dialog ref={stageDialog} className="crm-lead-stage-dialog" aria-labelledby={id + "stage-title"} onCancel={(event) => { if (busy) event.preventDefault(); }} onClose={() => { setStage(""); setServiceCharge(""); }}>
          <div className="modal-content"><div className="modal-header"><h2 className="h5 mb-0" id={id + "stage-title"}>Update Status</h2><button type="button" className="btn-close" aria-label="Close status dialog" disabled={busy} onClick={() => stageDialog.current?.close()} /></div>
          {data.stages.length > 0 ? <form onSubmit={async event => {
            event.preventDefault(); if (!canChangeStage || busy || !data.stages.includes(stage)) return;
            setBusy(true); setError(""); setNotice("");
            try {
              const saved = await stageOperation.current.run({ expectedVersion: data.version, stage, ...(stage === "Closed Won" && serviceCharge.trim() ? { serviceCharge: serviceCharge.trim() } : {}) },
                value => writeApi<LeadMutationResult>(`/api/leads/${taskId}/stage`, "PATCH", value), remoteWrite ? "zoho" : undefined);
              if (saved) { stageDialog.current?.close(); setStage(""); setServiceCharge(""); setNotice(remoteWrite ? "Saved in Zoho and verified." : "Saved locally. Not synchronized with Zoho."); reload(); }
            } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
          }}><fieldset disabled={!canChangeStage || busy} aria-label={canChangeStage ? "Lead stage editor" : "Stage submission unavailable"}><div className="modal-body">
            {error && <p className="error" role="alert">{error}</p>}
            <label className="form-label">Status <span className="text-danger">*</span><select className="form-select" aria-label="Next lead stage" required value={stage} onChange={event => { setStage(event.target.value); if (event.target.value === "Closed Won") setServiceCharge(currentServiceCharge ?? ""); }}><option value="">--Select--</option>{currentStatus === "Site Visit" && !data.stages.includes("Proposal/Price Quote") && <option value="Proposal/Price Quote" disabled>Proposal (Create quotation first)</option>}{data.stages.map(value => <option key={value} value={value}>{value === "Closed Lost" ? "Omitted" : value === "Proposal/Price Quote" ? "Proposal" : value}</option>)}</select></label>
            {stage === "Closed Won" && <label className="form-label">Amount<input className="form-control" aria-label="Service charge (AED)" type="text" inputMode="decimal" maxLength={37} value={serviceCharge} onChange={event => setServiceCharge(event.target.value)} /></label>}
            {currentStatus === "Site Visit" && !data.stages.includes("Proposal/Price Quote") && <p className="field-hint text-danger">Create a quotation before selecting Proposal.</p>}
          </div><div className="modal-footer"><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => stageDialog.current?.close()}>Close</button><button className="btn btn-primary" type="submit" aria-label="Save lead stage" disabled={!canChangeStage || busy || !stage}>Save changes</button></div>
          </fieldset></form> : <p>No further stage change is supported for this recorded stage.</p>}
          </div></dialog>
          {data.stages.length === 0 && <p>No further stage change is supported for this recorded stage.</p>}
        </div>}
        {data.canWriteNotes && <div className="actions">
          {noteButtons.map(({ key, button }) => noteActionTargets?.[key] ? createPortal(button, noteActionTargets[key], key) : <span key={key}>{button}</span>)}
          <dialog ref={noteDialog} className="crm-lead-stage-dialog crm-lead-note-dialog" aria-labelledby={id + "note-title"} onCancel={event => { if (busy) event.preventDefault(); }} onClose={() => { setNoteId(""); setTitle(""); setContent(""); }}>
          <div className="modal-content"><div className="modal-header"><h2 className="h5 mb-0" id={id + "note-title"}>{noteId ? "Edit Your Notes" : "Add Notes"}</h2><button type="button" className="btn-close" aria-label="Close note dialog" disabled={busy} onClick={() => noteDialog.current?.close()} /></div>
          <form onSubmit={async (event) => {
            event.preventDefault(); if (!canWriteNotes || busy) return;
            const payload = { expectedVersion: data.version, title: title.trim(), content: content.trim() }, key = JSON.stringify({ taskId, noteId, ...payload });
            if (request.current?.key !== key) request.current = { key, operationId: crypto.randomUUID() };
            setBusy(true); setError(""); setNotice("");
            try {
              const saved = await writeApi<LeadMutationResult>(`/api/leads/${taskId}/notes${noteId ? "/" + encodeURIComponent(noteId) : ""}`, noteId ? "PATCH" : "POST", { ...payload, operationId: request.current.operationId });
              if (remoteWrite) assertPersistenceReceipt(saved, { operationId: request.current.operationId, persistence: "zoho" });
              request.current = null; noteDialog.current?.close(); setNoteId(""); setTitle(""); setContent(""); setNotice(remoteWrite ? "Saved in Zoho and verified." : "Saved locally. Not synchronized with Zoho."); reload();
            } catch (caught) { setError(message(caught)); } finally { setBusy(false); }
          }}><fieldset disabled={!canWriteNotes || busy} aria-label={canWriteNotes ? "Lead note editor" : "Note submission unavailable"}><div className="modal-body">
            {error && <p className="error" role="alert">{error}</p>}
            <div><label className="form-label" htmlFor={id + "title"}>Note Title <span className="text-danger">*</span></label><input className="form-control" aria-label={noteId ? "Edit note title" : "New note title"} id={id + "title"} type="text" required readOnly={!!noteId} placeholder="Enter note title" maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} /></div>
            <div><label className="form-label" htmlFor={id + "content"}>Note Content <span className="text-danger">*</span></label><textarea className="form-control" aria-label={noteId ? "Edit note content" : "New note content"} id={id + "content"} required rows={noteId ? 4 : 5} placeholder={noteId ? "Write your notes here..." : "Enter note details"} maxLength={10_000} value={content} onChange={(event) => setContent(event.target.value)} /></div>
          </div><div className="modal-footer"><button type="button" className={noteId ? "btn btn-secondary" : "btn btn-light border"} disabled={busy} onClick={() => noteDialog.current?.close()}>Close</button><button className={noteId ? "btn btn-warning" : "btn btn-primary"} type="submit" aria-label={noteId ? "Save lead note" : "Add lead note"} disabled={!canWriteNotes || busy}>{noteId ? "Save changes" : <><i className="ph ph-floppy-disk me-1" aria-hidden="true" />Save Note</>}</button></div>
          </fieldset></form></div></dialog>{!canWriteNotes && <p className="field-hint">Editing recorded notes also requires the approved connection.</p>}
        </div>}
      </div>
    </>)}
  </section>;
}
