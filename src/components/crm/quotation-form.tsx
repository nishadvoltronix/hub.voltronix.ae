"use client";
import { hasLocalRecordWorkflow, hasRemoteWorkflow, isLocalPersistence } from "@voltronix/crm-contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { CrmWriteCapabilities } from "@voltronix/crm-contracts";
import { parseLocalQuotationInput, parseQuotationInput, previewQuotationDraft, type QuotationInput } from "@/server/commercial/quotations";
import type { CommercialMutationResult, QuotationCapabilities, QuotationDetail } from "@/server/commercial/persistence-contracts";
import { message, writeApi } from "@/components/settings/client";
import { useRead } from "./read-client";
import { QUOTATION_TERMS } from "./quotations";
import { createLocalWriteState } from "./local-write-state";
import { ProductSearch, QuotationCreateForm } from "./quotation-create-form";
import { HISTORICAL_QUOTATION_NOTICE, quotationTermLimit, recordedCreationDate } from "./quotation-display";
import { hasRemoteQuotationRows } from "@/server/commercial/edit-access";
type Item = QuotationInput["items"][number];
const blankItem = (): Item => ({ productId: "", productName: "", description: "", uom: "NOS", quantity: "1", unitPrice: "0", itemDiscount: "0" });
function QuotationEditor({ taskId, quote }: { taskId: string; quote?: QuotationDetail }) {
  const router = useRouter();
  const caps = useRead<QuotationCapabilities>(`/api/quotations/${taskId}/capabilities`);
  const writes = useRead<CrmWriteCapabilities>("/api/capabilities");
  const operation = useRef(createLocalWriteState());
  const savedDialog = useRef<HTMLDialogElement>(null);
  // Saved historical discounts keep their recorded units and canonical totals.
  const historicalQuote = !!quote && isLocalPersistence(quote.persistence) && quote.calculationPolicy !== "percentage-only-v2";
  const percentageHeader = !quote || quote.calculationPolicy === "percentage-only-v2";
  const [input, setInput] = useState<QuotationInput>(() => quote
    ? historicalQuote ? quote.quotation : { ...quote.quotation, discountType: "percentage" }
    : { subject: "", kindAttention: "", project: null, termsOfPayment: null, specification: null,
      generalExclusion: null, brand: null, warranty: null, delivery: null, notes: null, validUntil: null, discountType: "percentage", discount: "0", adjustment: "0", items: [blankItem()] });
  const [rowIds, setRowIds] = useState(() => (quote?.quotation.items ?? [blankItem()]).map((_, index) => index));
  const nextRowId = useRef(rowIds.length);
  const [remoteRowIds, setRemoteRowIds] = useState<(string | null)[]>(() => quote?.remoteRowIds?.slice() ?? []);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false), [saved, setSaved] = useState(false);
  const [draftChanged, setDraftChanged] = useState(false);
  const [savedRemote, setSavedRemote] = useState(false);
  const totals = draftChanged ? previewQuotationDraft(input) : quote?.totals;
  const change = <K extends keyof QuotationInput>(key: K, value: QuotationInput[K]) => { setInput((old) => ({ ...old, [key]: value })); setDraftChanged(true); };
  function itemChange(index: number, patch: Partial<Item>) { setInput((old) => ({ ...old, items: old.items.map((item, i) => i === index ? { ...item, ...patch } : item) })); setDraftChanged(true); }
  const forbidden = historicalQuote || !!caps.data?.discountedEditBlocked || (caps.data && !(quote ? caps.data.canEdit : caps.data.canCreate));
  const stale = !!quote && !!caps.data && (quote.taskVersion !== caps.data.taskVersion || quote.version !== caps.data.quoteVersion);
  const localWrite = hasLocalRecordWorkflow(writes.data, caps.data?.persistence);
  const remoteWrite = hasRemoteWorkflow(writes.data) && caps.data?.persistence === "zoho" && caps.data.integrationAvailable && !caps.data.sourceImport?.readOnly
    && quote?.persistence === "zoho" && hasRemoteQuotationRows(quote) && remoteRowIds.length === input.items.length;
  const canSubmit = !!(localWrite || remoteWrite) && !!caps.data && !forbidden && !caps.data.blockedOperationId && !stale
    && !!totals && input.items.length > 0 && input.items.every(item => item.productId !== "") && !saving && !saved;
  return <>{caps.loading && <p role="status">Loading quotation access...</p>}{caps.error && <p role="alert">{caps.error}</p>}
    {writes.error && <p role="alert">{writes.error}</p>}
    <p className="field-hint">{remoteWrite ? "This quotation is saved in Zoho and verified. Kind Attention and Notes are kept in Hub and its PDF." : localWrite ? "This quotation is saved locally. It is not synchronized with Zoho." : "Saving is unavailable for this record until an approved Zoho connection is verified. Previewing does not save changes."}</p>
    {(historicalQuote || caps.data?.discountedEditBlocked) && <p role="status" className="notice">{HISTORICAL_QUOTATION_NOTICE}</p>}
    {caps.data?.blockedOperationId && <p role="alert">An earlier operation needs reconciliation before another change can be submitted.</p>}
    {stale && <p role="alert">The saved quotation changed. Reload quotation access before continuing; reloading a changed quotation discards this draft.</p>}
    {forbidden && !historicalQuote && !caps.data?.discountedEditBlocked && <p role="alert">This quotation operation is not available for this record.</p>}
    {saved && <p role="status" className="success">{savedRemote ? "Saved in Zoho and verified." : "Saved locally. Not synchronized with Zoho."} <Link href={`/quotations/${taskId}`}>View saved quotation</Link></p>}
    <div className="actions mb-3"><button type="button" className="btn btn-outline-secondary btn-sm" disabled={saving} onClick={() => { caps.reload(); writes.reload(); router.refresh(); }}>Reload quotation access</button>
      {quote && <><Link className="btn btn-outline-secondary btn-sm" href={`/quotations/${taskId}`}>Back to quotation</Link>{(quote.persistence === "zoho" ? caps.data?.pdfAvailable === true : (!isLocalPersistence(quote.persistence) || caps.data?.pdfAvailable === true)) && <a className="btn btn-primary btn-sm" href={`/api/quotations/${taskId}/pdf`}>Download quotation PDF</a>}</>}
    </div>
    <form className="crm-quotation-form quotation-edit-form" onSubmit={async event => {
      event.preventDefault(); if (!canSubmit || !caps.data) return;
      setSaving(true); setError("");
      try {
        const quotation = localWrite ? parseLocalQuotationInput(input) : parseQuotationInput(input);
        const payload = { expectedVersion: quote?.taskVersion ?? caps.data.taskVersion, quotation,
          ...(quote ? { expectedQuoteVersion: quote.version } : { taskId }),
          ...(remoteWrite ? { remoteRowIds } : {}) };
        const result = await operation.current.run(payload, value => writeApi<CommercialMutationResult>(quote ? `/api/quotations/${taskId}` : "/api/quotations", quote ? "PATCH" : "POST", value), remoteWrite ? "zoho" : undefined);
        if (result) { setSavedRemote(result.persistence === "zoho"); setSaved(true); savedDialog.current?.showModal(); }
      } catch (failure) { setError(message(failure)); } finally { setSaving(false); }
    }}><fieldset disabled={!caps.data || forbidden || saving || saved || stale}>
      {quote ? <div className="row g-3 mb-3">
        <div className="col-md-3"><label>Deal Number<input readOnly value={quote.task.dealNumber ?? ""} /></label></div>
        <div className="col-md-3"><label>Quote Number<input readOnly value={quote.quoteNumber} /></label></div>
        <div className="col-md-3"><label>Recorded creation date (Dubai)<input type="date" readOnly value={recordedCreationDate(quote.createdAt)} /></label></div>
        <div className="col-md-3"><label>Valid Until<input type="date" value={input.validUntil ?? ""} onChange={event => change("validUntil", event.target.value || null)} /></label></div>
        <div className="col-md-3"><label>Kind Attention<input aria-label="Kind attention" required={!localWrite} maxLength={200} value={input.kindAttention} onChange={event => change("kindAttention", event.target.value)} /></label></div>
        <div className="col-md-3"><label>Subject<input aria-label="Quotation subject" required maxLength={remoteWrite ? 120 : 200} value={input.subject} onChange={event => change("subject", event.target.value)} /></label></div>
        {([["brand", "Brand"], ["delivery", "Delivery Timeline"]] as const).map(([key, label]) => <div className="col-md-3" key={key}><label>{label}<input maxLength={quotationTermLimit(key, remoteWrite)} value={input[key] ?? ""} onChange={event => change(key, event.target.value || null)} /></label></div>)}
        {([["project", "Project"], ["termsOfPayment", "Payment Terms"]] as const).map(([key, label]) => <div className="col-md-6" key={key}><label>{label}<input maxLength={quotationTermLimit(key, remoteWrite)} value={input[key] ?? ""} onChange={event => change(key, event.target.value || null)} /></label></div>)}
        {([["generalExclusion", "General Exclusion"], ["specification", "Specifications"], ["warranty", "Warranty"], ["notes", "Notes"]] as const).map(([key, label]) => <div className="col-md-3" key={key}><label>{label}<textarea rows={3} maxLength={quotationTermLimit(key, remoteWrite)} value={input[key] ?? ""} onChange={event => change(key, event.target.value || null)} /></label></div>)}
      </div> : <div className="quotation-header-fields">
      <label>Quotation subject<input required maxLength={remoteWrite ? 120 : 200} value={input.subject} onChange={(event) => change("subject", event.target.value)} /></label>
      <label>Kind attention<input required={!localWrite} maxLength={200} value={input.kindAttention} onChange={(event) => change("kindAttention", event.target.value)} /></label>
      <label>Valid until<input type="date" value={input.validUntil ?? ""} onChange={(event) => change("validUntil", event.target.value || null)} /></label>
      </div>}<div className="d-flex justify-content-between align-items-center mb-3"><h2 className="section-title mb-0">{quote ? "Quotation Items" : "Proposal Items"}</h2>
      <button type="button" className="btn btn-purple btn-sm" disabled={input.items.length >= 200} onClick={() => {
        change("items", [...input.items, blankItem()]); setRowIds(current => [...current, nextRowId.current++]); setRemoteRowIds(current => [...current, null]);
      }}><i className="ph ph-plus me-1" aria-hidden="true" />Add Item</button></div>
      <div className="table-responsive table-scroll" role="region" aria-label="Quotation line items" tabIndex={0}>
        <table className="table table-bordered align-middle crm-quotation-edit-items"><thead className="table-light"><tr><th>#</th><th>Product Name</th><th>Description</th><th>UOM</th><th>Qty</th><th>Unit Price</th><th>Discount %</th><th>Total</th><th>Action</th></tr></thead><tbody>
        {input.items.map((item, index) => <tr key={rowIds[index]}><td>{index + 1}</td>
          <td className="align-top"><ProductSearch index={index} selectedProductId={item.productId} initialProductName={item.productName} disabled={!caps.data || !!forbidden || saving || saved || stale} onChange={patch => itemChange(index, patch)} /></td>
          <td><label className="w-100"><span className="visually-hidden">Item {index + 1} description</span><textarea className="form-control" rows={2} maxLength={remoteWrite ? 2000 : 10_000} value={item.description} onChange={(event) => itemChange(index, { description: event.target.value })} /></label></td>
          <td><label className="w-100"><span className="visually-hidden">Item {index + 1} UOM</span><select className="form-select form-select-sm" value={item.uom} onChange={(event) => itemChange(index, { uom: event.target.value as Item["uom"] })}>{["", "NOS", "PCS", "LS", "EA", "SET", "SQM"].map((value) => <option key={value} value={value}>{value || "None"}</option>)}</select></label></td>
          <td><label className="w-100"><span className="visually-hidden">Item {index + 1} quantity</span><input className="form-control form-control-sm" inputMode="decimal" maxLength={37} value={item.quantity} onChange={(event) => itemChange(index, { quantity: event.target.value })} /></label></td>
          <td><label className="w-100"><span className="visually-hidden">Item {index + 1} unit price</span><input className="form-control form-control-sm" inputMode="decimal" maxLength={37} value={item.unitPrice} onChange={(event) => itemChange(index, { unitPrice: event.target.value })} /></label></td>
          <td><label className="w-100"><span className="visually-hidden">Item {index + 1} discount (%)</span><input className="form-control form-control-sm" type="number" min="0" max="100" step="any" required inputMode="decimal" value={item.itemDiscount} onChange={(event) => itemChange(index, { itemDiscount: event.target.value })} /></label></td>
          <td><input className="form-control" aria-label={`Item ${index + 1} total`} value={totals?.lineTotals[index] ?? ""} readOnly /></td>
          <td className="text-center"><button type="button" className="btn btn-danger btn-sm" aria-label={`Remove item ${index + 1}`} disabled={input.items.length <= 1} onClick={() => { change("items", input.items.filter((_, i) => i !== index)); setRowIds(current => current.filter((_, i) => i !== index)); setRemoteRowIds(current => current.filter((_, i) => i !== index)); }}><i className="ph ph-trash" aria-hidden="true" /></button></td>
        </tr>)}
        </tbody></table>
      </div><div className="row mt-4"><div className="col-md-4 offset-md-8"><div className="summary-box quotation-calculation-summary"><h2 className="section-title">Calculation Summary</h2>
        <label>Sub Total<input aria-label="Preview subtotal (AED)" className="form-control" value={totals?.subtotal ?? ""} readOnly /></label>
        <label>{percentageHeader ? "Discount (%)" : "Saved header discount (AED)"}<input className="form-control" type="number" min="0" max={percentageHeader ? "100" : undefined} step="any" required inputMode="decimal" value={input.discount} onChange={(event) => change("discount", event.target.value)} /></label>
        <label>VAT (%)<input className="form-control" value="5" readOnly /></label>
        <label>Adjustment<input aria-label="Adjustment (AED)" className="form-control" inputMode="decimal" maxLength={38} value={input.adjustment} onChange={(event) => change("adjustment", event.target.value)} /></label>
        <label className="fw-bold">Grand Total<input aria-label="Preview grand total (AED)" className="form-control fw-bold text-success" value={totals?.grandTotal ?? ""} readOnly /></label>
      </div></div></div>
      {!quote && <section className="card quotation-terms mt-4"><div className="card-header bg-light"><h2 className="h6 mb-0">Additional Details</h2></div><div className="card-body quotation-term-fields">{QUOTATION_TERMS.map(([key, label]) => <label key={key}>{label}<textarea maxLength={quotationTermLimit(key, remoteWrite)} value={input[key] ?? ""} onChange={(event) => change(key, event.target.value || null)} /></label>)}</div></section>}
      {draftChanged && !totals && <p role="status">Enter valid quantities and amounts, with discounts from 0 to 100%, to preview totals.</p>}
      {totals && <p role="status" className="field-hint">{draftChanged ? "Preview only" : "Recorded totals"}. Subtotal: {totals.subtotal} AED; VAT: {totals.vatAmount} AED; grand total: {totals.grandTotal} AED.</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="mt-4 d-flex gap-2"><button type="submit" className="btn btn-success" aria-label={quote ? "Save quotation" : "Create quotation"} disabled={!canSubmit}><i className="ph ph-floppy-disk me-1" aria-hidden="true" />{saving ? "Saving quotation..." : quote ? "Update Quotation" : "Create quotation"}</button>
        <Link className="btn btn-secondary" href={`/leads/${taskId}`}>Cancel</Link></div>
    </fieldset></form>
    <dialog ref={savedDialog} className="crm-item-status-dialog" aria-labelledby="quotation-updated-title" onClose={() => { if (saved) router.push(`/leads/${taskId}`); }}>
      <div className="crm-item-status-icon" aria-hidden="true">✓</div><h2 id="quotation-updated-title">Quotation updated successfully.</h2>
      <p role="status">{savedRemote ? "Saved in Zoho and verified. Kind Attention and Notes are kept in Hub and its PDF." : "Saved locally. Not synchronized with Zoho."}</p>
      <div className="crm-item-status-actions"><button type="button" onClick={() => savedDialog.current?.close()}>OK</button></div>
    </dialog>
  </>;
}
export function QuotationForm({ initialTaskId = "", quote }: { initialTaskId?: string; quote?: QuotationDetail }) {
  if (!quote) return <QuotationCreateForm initialTaskId={initialTaskId} />;
  return <div className="crm-stack"><h1>Edit quotation</h1>
    <section className="card quotation-edit-card"><div className="card-header bg-white d-flex flex-wrap justify-content-between align-items-center gap-3 py-3">
      <div><h2 className="h4 mb-0">Edit Quotation</h2><small className="text-muted">Company: {quote.task.accountName || "-"} | Recorded creation date (Dubai): {recordedCreationDate(quote.createdAt)} | Quote Number: {quote.quoteNumber}</small></div>
      <Link className="btn btn-secondary btn-sm" href={`/leads/${quote.taskId}`}><i className="ph ph-arrow-left me-1" aria-hidden="true" />Back</Link>
    </div><div className="card-body"><QuotationEditor key={`${quote.taskId}:${quote.taskVersion}:${quote.version}`} taskId={quote.taskId} quote={quote} /></div></section>
  </div>;
}
