"use client";
import { useId, useRef, useState } from "react";
import { TASK_ATTACHMENT_EXTENSIONS } from "@voltronix/crm-contracts";
import type { Attachment } from "@/server/attachments/service";
import { Pagination, message, readApi } from "@/components/settings/client";
import { useRead } from "./read-client";
type List = { items: Attachment[]; total: number; pageSize: number; version: number; canUpload: boolean };
function AttachmentCard({ file }: { file: Attachment }) {
  const image = ["image/gif", "image/png", "image/jpeg"].includes(file.mediaType);
  const canPreview = image || ["text/plain", "text/csv"].includes(file.mediaType);
  const [unavailable, setUnavailable] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), id = useId();
  const download = `/api/attachments/${file.id}`, preview = download + "/preview";
  const extension = file.name.includes(".") ? file.name.split(".").at(-1) : "File";
  return <div className="col-xl-2 col-lg-3 col-md-4 col-sm-6 mb-3"><article className="attachment-card" aria-label={file.name}>
    <div className="attachment-preview">{image && !unavailable ? <a href={preview} target="_blank" rel="noopener noreferrer" aria-label={`Preview image ${file.name}`}>
      {/* Private previews require the current browser cookie; never send them to an image optimizer. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="attachment-image" src={preview} alt={file.name} loading="lazy" onError={() => setUnavailable(true)} />
    </a> : <div className="file-icon-wrapper"><i className={`ph ${file.mediaType === "application/pdf" ? "ph-file-pdf" : file.mediaType === "text/csv" ? "ph-table" : unavailable ? "ph-warning" : "ph-paperclip"} file-icon`} aria-hidden="true" /><small className="text-uppercase text-muted">{unavailable ? "Preview unavailable" : extension}</small></div>}</div>
    <div className="attachment-info"><div className="attachment-name" title={file.name}><a href={download} download>{file.name}</a></div><small className="text-muted d-block">{file.size} bytes</small>{file.createdAt && <small className="text-muted d-block">Created: {file.createdAt}</small>}
      <div className="attachment-actions">{canPreview && (unavailable ? <button className="btn btn-outline-primary btn-sm" type="button" aria-label={`View ${file.name}`} onClick={() => dialog.current?.showModal()}>View</button> : <a className="btn btn-outline-primary btn-sm" href={preview} target="_blank" rel="noopener noreferrer" aria-label={`View ${file.name}`}><i className="ph ph-eye" aria-hidden="true" /> View</a>)}<a className="btn btn-success btn-sm" href={download} download aria-label={`Download ${file.name}`}><i className="ph ph-download" aria-hidden="true" /><span className="visually-hidden">Download</span></a></div>
      {!canPreview && <small className="text-muted d-block">Download only</small>}
    </div>
    <dialog ref={dialog} className="crm-lead-stage-dialog" aria-labelledby={id}><div className="modal-header bg-dangers"><h3 className="h6 text-white mb-0" id={id}>File unavailable</h3><button type="button" className="btn-close btn-close-white" aria-label="Close unavailable file" onClick={() => dialog.current?.close()} /></div><div className="modal-body"><p>Unable to preview this file. Download it or refresh the attachments to try again.</p></div><div className="modal-footer"><button type="button" className="btn btn-secondary btn-sm" onClick={() => dialog.current?.close()}>OK</button></div></dialog>
  </article></div>;
}
export function Attachments({ taskId }: { taskId: string }) {
  const [page, setPage] = useState(1), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const data = useRead<List>(`/api/leads/${taskId}/attachments?page=${page}&pageSize=25`);
  async function upload(values: FormData) {
    if (!data.data) return;
    setBusy(true); setError(""); setNotice(""); values.set("expectedVersion", String(data.data.version));
    try {
      const { csrfToken } = await readApi<{ csrfToken: string }>("/api/auth/csrf");
      const response = await fetch(`/api/leads/${taskId}/attachments`, { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrfToken }, body: values });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Upload failed.");
      form.current?.reset(); setNotice("Attachment saved. Reload other open editing forms before making another change."); setPage(1); data.reload();
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  return <section className="card crm-task-attachments" aria-label="Local attachments"><div className="card-header"><h2 className="h5 mb-0">File Upload</h2></div><div className="card-body">
    <p className="field-hint">Images (GIF, PNG, JPEG, WebP, BMP), PDF, Word, Excel, PowerPoint, UTF-8 text, CSV, ZIP, RAR and 7z files, up to 16,000 KB. View supported static images and text in a new tab; other files are download only.</p>
    {(data.error || error) && <p role="alert" className="error">{error || data.error}</p>}{notice && <p role="status" className="success">{notice}</p>}
    {data.loading && <p role="status">Loading attachments...</p>}
    {data.data?.canUpload && <form ref={form} onSubmit={(event) => { event.preventDefault(); void upload(new FormData(event.currentTarget)); }}>
      <label className="form-label">Attachment file<input className="form-control" type="file" name="file" accept={TASK_ATTACHMENT_EXTENSIONS.map(value => "." + value).join(",")} required disabled={busy} /></label>
      <div className="text-center mt-3"><button className="btn btn-primary btn-sm" aria-label="Upload attachment" disabled={busy}>Upload Now</button></div>
    </form>}
    <hr className="my-4" /><div className="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3"><h3 className="h5 mb-0">Uploaded Attachments</h3><div className="d-flex align-items-center gap-2"><span className="badge bg-primary">{data.data?.total ?? 0} Files</span><button type="button" className="btn btn-outline-secondary btn-sm" disabled={busy} onClick={data.reload}>Refresh attachments</button></div></div>
    {data.data && <><div className="row">{data.data.items.map(file => <AttachmentCard key={file.id} file={file} />)}</div>
      {data.data.total === 0 && <p>No local attachments recorded.</p>}<Pagination data={data.data} page={page} onPage={setPage} /></>}
  </div></section>;
}
