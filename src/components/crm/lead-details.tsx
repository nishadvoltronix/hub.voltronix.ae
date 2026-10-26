"use client";
import { isLocalPersistence } from "@voltronix/crm-contracts";
import { useCallback, useState } from "react";
import type { LeadDetail, LeadNote, LeadPage, LeadStatusEvent } from "@/server/leads/contracts";
import { Pagination } from "@/components/settings/client";
import { RecordedValue, useRead } from "./read-client";
import { Attachments } from "./attachments";
import { LeadMutationControls } from "./lead-mutation-controls";
import { QuotationLinks } from "./quotation-links";
import { ZohoImportNotice } from "./zoho-import-notice";
function Fields({ fields }: { fields: [string, string | null][] }) {
  return <dl className="legacy-record-list mb-0">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd><RecordedValue value={value} /></dd></div>)}</dl>;
}
function NoteActionSlot({ noteId, onTarget }: { noteId: string; onTarget: (noteId: string, target: HTMLDivElement | null) => void }) {
  const ref = useCallback((target: HTMLDivElement | null) => onTarget(noteId, target), [noteId, onTarget]);
  return <div ref={ref} />;
}
export function LeadDetails({ lead }: { lead: LeadDetail }) {
  const [stageActionTarget, setStageActionTarget] = useState<HTMLDivElement | null>(null);
  const [noteActionTargets, setNoteActionTargets] = useState<Record<string, HTMLDivElement | null>>({});
  const noteTarget = useCallback((noteId: string, target: HTMLDivElement | null) => {
    setNoteActionTargets(current => current[noteId] === target ? current : { ...current, [noteId]: target });
  }, []);
  const [notePage, setNotePage] = useState(1);
  const [historyPage, setHistoryPage] = useState(1);
  const notes = useRead<LeadPage<LeadNote>>("/api/leads/" + lead.id + "/notes?page=" + notePage + "&pageSize=25");
  const history = useRead<LeadPage<LeadStatusEvent>>("/api/leads/" + lead.id + "/history?page=" + historyPage + "&pageSize=25");
  return <div className="row g-4">
    <div className="col-xxl-3 col-xl-4 col-lg-12">
    <section className="card" aria-label="Lead details"><div className="card-header"><h2 className="h5 mb-0">Job Details</h2></div><Fields fields={[
      ["Deal Name", lead.dealName], ["Assigned agent", lead.assignedName], ["Status", lead.status], ["Job status", lead.jobStatus],
      ["Service charge (AED)", lead.serviceCharge], ["Created", lead.createdAt], ["Updated", lead.updatedAt],
      ["Deal number", lead.dealNumber], ["Enquiry number", lead.enquiryNumber], ["Qualification number", lead.qualificationNumber],
      ["Site visit number", lead.siteNumber], ["Quotation number", lead.quotationNumber], ["Job number", lead.jobNumber], ["Lost / omitted number", lead.lostNumber],
    ]} /></section>
    <QuotationLinks taskId={lead.id} />
    <section className="card mt-4" aria-label="Recorded stage dates"><div className="card-header"><h2 className="h5 mb-0"><i className="ph ph-calendar-blank me-2 text-danger" aria-hidden="true" />Recorded stage dates</h2></div><Fields fields={[
      ["Enquiry", lead.enquiryDate], ["Qualification", lead.qualificationDate], ["Site visit", lead.siteDate],
      ["Quotation", lead.quotationDate], ["Won", lead.jobDate], ["Lost / omitted", lead.lostDate],
    ]} /></section>
    </div>
    <div className="col-xxl-9 col-xl-8 col-lg-12 legacy-detail-content">
    <section className="card" aria-label="Description and remarks"><div className="card-header d-flex align-items-center justify-content-between flex-wrap gap-2"><h1 className="h5 mb-0">Deal Name: {lead.dealName}</h1><div className="d-flex align-items-center gap-2 ms-auto"><span className="badge bg-primary">{lead.status}</span><div ref={setStageActionTarget} /></div></div>
      {lead.sourceImport?.readOnly ? <ZohoImportNotice source={lead.sourceImport} className="m-3" /> : isLocalPersistence(lead.persistence) && <p className="notice m-3">Saved locally. Not synchronized with Zoho.</p>}
      <div className="card-body border-bottom"><strong className="text-danger">Description:</strong><p className="preserve-lines"><RecordedValue value={lead.description} /></p>
        <strong className="text-danger">Account Name:</strong><p className="mb-0"><RecordedValue value={lead.accountName} /></p></div>
      <div className="card-body"><Fields fields={[["Remarks", lead.remark], ["Notes", lead.notes], ["Assignment notes", lead.assignmentNotes]]} /></div>
    </section>
    <section className="card" aria-label="Customer details"><div className="card-header"><h2 className="h5 mb-0"><i className="ph ph-user-circle me-2 text-danger" aria-hidden="true" />Customer details</h2></div><div className="card-body"><div className="row g-3">
      {[["Customer", lead.customerName], ["Email", lead.customerEmail], ["Contact", lead.customerContact], ["Address", lead.address]].map(([label, value]) =>
        <div className="col-sm-6" key={label}><strong>{label}: </strong><RecordedValue value={value} /></div>)}
    </div></div></section>
    <Attachments taskId={lead.id} />
    <section className="card mt-4" aria-label="Lead notes"><div className="card-header d-flex align-items-center justify-content-between flex-wrap gap-2"><h2 className="h5 mb-0"><i className="ph ph-pencil-ruler me-2 text-danger" aria-hidden="true" />Lead notes</h2><NoteActionSlot noteId="new" onTarget={noteTarget} /></div><div className="card-body">
      {notes.loading && <p role="status">Loading notes…</p>}{notes.error && <p role="alert" className="error">{notes.error}</p>}
      {notes.data?.items.map((note) => <article className="note-card" key={note.id}><div className="d-flex align-items-center justify-content-between flex-wrap gap-2"><h3>{note.title}</h3><NoteActionSlot noteId={note.id} onTarget={noteTarget} /></div><p className="preserve-lines">{note.content}</p><p className="muted">Updated {note.updatedAt}</p></article>)}
      {notes.data?.total === 0 && <p>No notes are recorded for this lead.</p>}
      <Pagination data={notes.data} page={notePage} onPage={setNotePage} />
    </div></section>
    <section className="card" aria-label="Status history"><div className="card-header"><h2 className="h5 mb-0">Status history</h2></div><div className="card-body">
      {history.loading && <p role="status">Loading status history…</p>}{history.error && <p role="alert" className="error">{history.error}</p>}
      {history.data && <div className="table-responsive table-scroll"><table className="table table-hover mb-0"><thead><tr><th>Status</th><th>Changed by</th><th>Recorded at</th></tr></thead><tbody>
        {history.data.items.map((event) => <tr key={event.id}><td><span className="badge bg-primary-subtle text-primary">{event.status}</span></td><td><RecordedValue value={event.actorName} /></td><td>{event.occurredAt}</td></tr>)}
      </tbody></table></div>}
      {history.data?.total === 0 && <p>No status changes are recorded for this lead.</p>}
      <Pagination data={history.data} page={historyPage} onPage={setHistoryPage} />
    </div></section>
    <LeadMutationControls taskId={lead.id} sourceImport={lead.sourceImport} currentStatus={lead.status} currentServiceCharge={lead.serviceCharge} notes={notes.data?.items} stageActionTarget={stageActionTarget} noteActionTargets={noteActionTargets} onReload={() => { notes.reload(); history.reload(); }} />
    <p className="notice">Zoho-synchronized attachments remain unavailable.</p>
  </div></div>;
}

