"use client";
import { useState } from "react";
import type { Department, Page, WorkLog } from "@/server/departments/contracts";
import { Pagination } from "@/components/settings/client";
import { useRead } from "./read-client";
import { recordedWorkLogDate } from "./work-log-date";
function LogAttachment({ attachment }: { attachment: WorkLog["attachment"] }) {
  return attachment ? <><a href={`/api/log-attachments/${attachment.id}`} download aria-label={`Download ${attachment.name}`}>{attachment.name}</a> ({attachment.size} bytes)
    {["image/gif", "image/png", "image/jpeg", "text/csv"].includes(attachment.mediaType)
      ? <> · <a href={`/api/log-attachments/${attachment.id}/preview`} target="_blank" rel="noopener noreferrer" aria-label={`View ${attachment.name}`}>View</a></>
      : <span className="field-hint"> · Preview unavailable; download this file.</span>}</> : <>No file</>;
}
export function WorkLogs({ path, revision = 0, department, showLatestSubmission = false }: { path: string; revision?: number; department?: Department; showLatestSubmission?: boolean }) {
  const [page, setPage] = useState(1);
  const result = useRead<Page<WorkLog>>(path + (path.includes("?") ? "&" : "?") + new URLSearchParams({ page: String(page), pageSize: "25" }));
  const latest = useRead<Page<WorkLog>>(showLatestSubmission ? path + (path.includes("?") ? "&" : "?") + "page=1&pageSize=1" : null);
  const submission = latest.data?.items[0];
  const authority = department === "Electrical" || department === "Civil";
  if (department) return <>{showLatestSubmission && <section className="card shadow-sm border-0" aria-label={department + " recorded submission"}>
    <div className="card-header bg-light"><h2 className="h5 mb-0"><i className="ph ph-lightning me-1" aria-hidden="true" />{department} Department Submission</h2></div>
    <div className="card-body">{latest.loading && <p role="status">Loading recorded submission...</p>}{latest.error && <p role="alert">{latest.error}</p>}
      {submission && <>{[[authority ? department === "Electrical" ? "DEWA Authority" : "Civil Authority" : "Scope of Work", submission.authority ?? submission.scope], ["Status", submission.status],
        ...(authority ? [["Authority Comments", submission.comments]] : []), [department === "Electrical" ? "Electrician Notes" : department + " Notes", submission.notes]].map(([label, value], index) =>
        <div className="row mb-3" key={label}><div className="col-md-4 text-muted fw-semibold">{label}</div><div className="col-md-8 preserve-lines">{index < 2
          ? <span className={"badge " + (index === 0 ? "bg-info" : "bg-success")}>{value || "Not recorded"}</span>
          : <div className="p-2 border rounded bg-light">{value || "Not recorded"}</div>}</div></div>)}
        <div className="row mb-2"><div className="col-md-4 text-muted fw-semibold">Uploaded Document</div><div className="col-md-8 crm-log-text"><LogAttachment attachment={submission.attachment} /></div></div></>}
      {latest.data?.total === 0 && <p>No update recorded.</p>}</div>
    <div className="card-footer text-muted small">Submitted on - {submission?.createdAt ? recordedWorkLogDate(submission.createdAt, true) : "Not submitted yet"}</div>
  </section>}<section className="card shadow-sm border-0 mt-4" aria-label="Work log history" data-revision={revision}>
    <div className="card-header bg-light"><h2 className="h5 mb-0"><i className="ti ti-clipboard-list me-1" aria-hidden="true" />Logs</h2></div><div className="card-body p-0">
      {result.loading && <p role="status">Loading work logs...</p>}{result.error && <p role="alert">{result.error}</p>}
      {result.data && <div className="table-responsive table-scroll" role="region" aria-label={department + " logs table"} tabIndex={0}><table className="table table-hover mb-0 w-100 crm-worker-logs"><thead className="table-light"><tr><th>Date</th><th>{authority ? "Authority" : "Scope of Work"}</th><th>Status</th>{authority && <th>Comments</th>}<th>Notes</th><th>File</th><th>Assigned User</th></tr></thead><tbody>{result.data.items.map(log => <tr key={log.id}>
        <td className="text-nowrap">{recordedWorkLogDate(log.createdAt)}</td><td><span className="badge bg-info">{log.authority ?? log.scope ?? "-"}</span></td><td><span className={"badge " + (/APPROVED/i.test(log.status) ? "bg-success" : /PENDING/i.test(log.status) ? "bg-warning" : /REJECT/i.test(log.status) ? "bg-danger" : "bg-secondary")}>{log.status}</span></td>{authority && <td className="crm-log-text">{log.comments || "-"}</td>}<td className="crm-log-text">{log.notes}</td><td className="crm-log-text"><LogAttachment attachment={log.attachment} /></td><td>{log.actorName}</td>
      </tr>)}</tbody></table></div>}
      {result.data?.total === 0 && <p className="p-3">No work logs recorded.</p>}<div className="px-3"><Pagination data={result.data} page={page} onPage={setPage} /></div>
    </div></section></>;
  // Parent remounts after a mutation; revision is retained in the heading for assistive feedback.
  return <section className="panel" aria-label="Work log history" data-revision={revision}><h2>Work log history</h2>
    {result.loading && <p role="status">Loading work logs...</p>}{result.error && <p role="alert">{result.error}</p>}
    {result.data?.items.map((log) => <article key={log.id}><h3>{log.status}</h3><p>{log.authority ?? log.scope} · {log.actorName} · {log.createdAt}</p>
      {log.comments && <p className="preserve-lines">{log.comments}</p>}<p className="preserve-lines">{log.notes}</p>
      {log.attachment && <p><a href={`/api/log-attachments/${log.attachment.id}`} download aria-label={`Download ${log.attachment.name}`}>{log.attachment.name}</a> ({log.attachment.size} bytes)
        {["image/gif", "image/png", "image/jpeg", "text/csv"].includes(log.attachment.mediaType)
          ? <> · <a href={`/api/log-attachments/${log.attachment.id}/preview`} target="_blank" rel="noopener noreferrer" aria-label={`View ${log.attachment.name}`}>View</a></>
          : <span className="field-hint"> · Preview unavailable; download this file.</span>}
      </p>}</article>)}
    {result.data?.total === 0 && <p>No work logs recorded.</p>}<Pagination data={result.data} page={page} onPage={setPage} />
  </section>;
}
