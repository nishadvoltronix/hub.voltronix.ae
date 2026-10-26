"use client";
import { hasLocalRecordWorkflow, hasRemoteWorkflow } from "@voltronix/crm-contracts";

import Link from "next/link";
import { useId, useRef, useState } from "react";
import type { LeadDetail, CrmWriteCapabilities } from "@voltronix/crm-contracts";
import { parseLocalQuotationInput, parseQuotationInput, previewQuotationDraft, type QuotationInput } from "@/server/commercial/quotations";
import type { CommercialMutationResult, CommercialPage, QuotationCandidate, QuotationCapabilities, QuotationDetail } from "@/server/commercial/persistence-contracts";
import { message, writeApi } from "@/components/settings/client";
import { useRead } from "./read-client";
import { createLocalWriteState } from "./local-write-state";
import { ProductSearch } from "./product-search";
import { quotationTermLimit } from "./quotation-display";
export { ProductSearch } from "./product-search";

type Item = QuotationInput["items"][number];
type Candidate = QuotationCandidate & { id: string };

const blankItem = (): Item => ({ productId: "", productName: "", description: "", uom: "NOS", quantity: "1", unitPrice: "0", itemDiscount: "0" });
const blankQuote = (): QuotationInput => ({ subject: "", kindAttention: "", project: null, termsOfPayment: null,
  specification: null, generalExclusion: null, brand: null, warranty: null, delivery: null, notes: null,
  validUntil: null, discountType: "percentage", discount: "0", adjustment: "0", items: [blankItem()] });
const candidateLabel = (candidate: Candidate) => `${candidate.dealNumber || candidate.dealName} — ${candidate.dealName} (${candidate.taskId})`;

export function QuotationCreateForm({ initialTaskId = "" }: { initialTaskId?: string }) {
  const dealListId = useId();
  const operation = useRef(createLocalWriteState());
  const [selectedTaskId, setSelectedTaskId] = useState(initialTaskId);
  const [minimumValidUntil] = useState(() => new Date().toISOString().slice(0, 10));
  const [dealNumber, setDealNumber] = useState<string | null>(null);
  const [input, setInput] = useState<QuotationInput>(blankQuote);
  const [rowIds, setRowIds] = useState([0]);
  const nextRowId = useRef(1);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedRemote, setSavedRemote] = useState(false);
  const [error, setError] = useState("");
  const statusDialog = useRef<HTMLDialogElement>(null);
  const savedQuotation = useRead<QuotationDetail>(saved && selectedTaskId ? `/api/quotations/${selectedTaskId}` : null);
  const lead = useRead<LeadDetail>(initialTaskId ? `/api/leads/${initialTaskId}` : null);
  const visibleDealNumber = dealNumber ?? lead.data?.dealNumber ?? lead.data?.displayNumber ?? lead.data?.dealName ?? "";
  const candidateQuery = (visibleDealNumber.split(" — ")[0] ?? "").trim();
  const candidates = useRead<CommercialPage<Candidate>>(candidateQuery.length >= 2
    ? "/api/quotations/candidates?" + new URLSearchParams({ query: candidateQuery, page: "1", pageSize: "25" }) : null);
  const exactCandidates = candidates.data?.items.filter((candidate) => candidate.dealNumber === visibleDealNumber.trim()) ?? [];
  // The original form accepts a typed Deal Number. Resolve only a unique match
  // from a complete eligible-candidate result, never a guessed or hidden task.
  const exactTaskId = candidates.data?.total === candidates.data?.items.length && exactCandidates.length === 1
    ? exactCandidates[0]!.taskId : "";
  const taskId = selectedTaskId || exactTaskId;
  const caps = useRead<QuotationCapabilities>(taskId ? `/api/quotations/${taskId}/capabilities` : null);
  const writes = useRead<CrmWriteCapabilities>("/api/capabilities");
  const preview = previewQuotationDraft(input);
  const localWrite = hasLocalRecordWorkflow(writes.data, caps.data?.persistence);
  const remoteWrite = hasRemoteWorkflow(writes.data) && caps.data?.persistence === "zoho" && caps.data.integrationAvailable && !caps.data.sourceImport?.readOnly;
  const canSubmit = !!taskId && !!caps.data?.canCreate && !!(localWrite || remoteWrite) && !caps.data.blockedOperationId
    && !!preview && input.items.length > 0 && input.items.every((item) => item.productId !== "") && !saving && !saved;

  function change<K extends keyof QuotationInput>(key: K, value: QuotationInput[K]) {
    setInput((current) => ({ ...current, [key]: value }));
  }
  function itemChange(index: number, patch: Partial<Item>) {
    setInput((current) => ({ ...current, items: current.items.map((item, position) => position === index ? { ...item, ...patch } : item) }));
  }
  const terms = ([
    ["project", "Project", "Project name"], ["termsOfPayment", "Terms of Payment", "e.g. 30 Days"],
    ["brand", "Brand", "Brand name"], ["warranty", "Warranty", "Warranty period"],
    ["delivery", "Delivery", "Delivery timeline"],
  ] as const);
  return <div className="crm-stack"><h1>Create quotation</h1><section className="panel quotation-create-panel">
    {saved && <p role="status" className="success">{savedRemote ? "Saved in Zoho and verified." : "Proposal saved locally."} <Link href={`/quotations/${taskId}`}>View saved quotation</Link></p>}
    <form className="crm-quotation-form quotation-create-form" onSubmit={async (event) => {
      event.preventDefault();
      if (!canSubmit || !caps.data) return;
      setSaving(true); setError(""); statusDialog.current?.showModal();
      try {
        const quotation = remoteWrite ? parseQuotationInput(input) : parseLocalQuotationInput(input);
        const payload = { expectedVersion: caps.data.taskVersion, quotation, taskId };
        const result = await operation.current.run(payload, (value) => writeApi<CommercialMutationResult>("/api/quotations", "POST", value), remoteWrite ? "zoho" : undefined);
        if (result) { setSavedRemote(result.persistence === "zoho"); setSelectedTaskId(taskId); setSaved(true); }
      } catch (failure) { setError(message(failure)); } finally { setSaving(false); }
    }}><fieldset className="border-0 p-0 m-0" disabled={saving || saved}>
      <h2 className="h6 text-danger mb-3">Deal Information</h2>
      <div className="row g-3 quotation-deal-fields">
        <div className="col-md-3"><label className="form-label" htmlFor="quotation-deal-number">Deal Number <span className="text-danger">*</span></label>
          <input id="quotation-deal-number" className="form-control" type="text" list={dealListId} required
            value={visibleDealNumber} onChange={(event) => {
              const value = event.target.value;
              setDealNumber(value);
              const match = candidates.data?.items.find((candidate) => candidateLabel(candidate) === value);
              setSelectedTaskId(match?.taskId ?? "");
            }} />
          <datalist id={dealListId}>{candidates.data?.items.map((candidate) => <option key={candidate.taskId} value={candidateLabel(candidate)} />)}</datalist>
          {candidates.loading && <p role="status" className="field-hint mt-1">Finding eligible deals...</p>}
          {candidates.error && <p role="alert" className="text-danger small mt-1">{candidates.error}</p>}
          {candidateQuery.length >= 2 && candidates.data?.total === 0 && <p className="field-hint mt-1">No eligible deal matches this number.</p>}
          {taskId && caps.error && <p role="alert" className="text-danger small mt-1">{caps.error}</p>}
        </div>
        <div className="col-md-6"><label className="form-label" htmlFor="quotation-subject">Subject <span className="text-danger">*</span></label>
          <input id="quotation-subject" className="form-control" type="text" maxLength={remoteWrite ? 120 : 200} required placeholder="Proposal subject"
            value={input.subject} onChange={(event) => change("subject", event.target.value)} /></div>
      </div>

      <hr className="my-4" />
      <h2 className="h6 text-danger mb-3">Proposal Items</h2>
      <div className="table-responsive table-scroll" role="region" aria-label="Quotation line items" tabIndex={0}>
        <table className="table table-bordered align-middle crm-quotation-items"><thead className="table-light text-center"><tr>
          <th>#</th><th>Item</th><th>UOM</th><th>Qty</th><th>Price</th><th>Discount %</th><th>Total</th><th aria-label="Action" />
        </tr></thead><tbody>{input.items.map((item, index) => <tr key={rowIds[index]}>
          <td>{index + 1}</td><td className="align-top"><ProductSearch index={index} selectedProductId={item.productId} initialProductName={item.productName} disabled={saving || saved} onChange={(patch) => itemChange(index, patch)} />
            <textarea className="form-control form-control-sm" rows={3} maxLength={remoteWrite ? 2000 : 10_000} aria-label={`Item ${index + 1} description`}
              placeholder="Description (optional)" value={item.description} onChange={(event) => itemChange(index, { description: event.target.value })} /></td>
          <td><select className="form-select" aria-label={`Item ${index + 1} UOM`} value={item.uom}
            onChange={(event) => itemChange(index, { uom: event.target.value as Item["uom"] })}>
            {[["", "-None-"], ["NOS", "NOS"], ["PCS", "PCS"], ["LS", "LS"], ["EA", "EA"], ["SET", "SET"], ["SQM", "SQM"]].map(([value, label]) =>
              <option key={value} value={value}>{label}</option>)}</select></td>
          <td><input className="form-control" aria-label={`Item ${index + 1} quantity`} inputMode="decimal" required
            value={item.quantity} onChange={(event) => itemChange(index, { quantity: event.target.value })} /></td>
          <td><input className="form-control" aria-label={`Item ${index + 1} price`} inputMode="decimal" required
            value={item.unitPrice} onChange={(event) => itemChange(index, { unitPrice: event.target.value })} /></td>
          <td><input className="form-control" aria-label={`Item ${index + 1} discount percent`} type="number" min="0" max="100" step="any" inputMode="decimal" required
            value={item.itemDiscount} onChange={(event) => itemChange(index, { itemDiscount: event.target.value })} /></td>
          <td><input className="form-control" aria-label={`Item ${index + 1} total`} value={preview?.lineTotals[index] ?? ""} readOnly /></td>
          <td className="text-center"><button type="button" className="btn btn-danger btn-sm" aria-label={`Remove item ${index + 1}`}
            onClick={() => { change("items", input.items.filter((_, position) => position !== index));
              setRowIds((current) => current.filter((_, position) => position !== index)); }}>X</button></td>
        </tr>)}</tbody></table>
      </div>
      <button type="button" className="btn btn-outline-danger mb-3" disabled={input.items.length >= 200}
        onClick={() => { change("items", [...input.items, blankItem()]);
          setRowIds((current) => [...current, nextRowId.current++]); }}>Add Item</button>

      <hr className="my-4" />
      <h2 className="h6 text-danger mb-3">Calculation Summary</h2>
      <div className="row"><div className="col-md-4 offset-md-8 quotation-calculation-summary">
        <label className="form-label">Sub Total<input className="form-control" value={preview?.subtotal ?? ""} readOnly /></label>
        <label className="form-label">Discount (%)<input className="form-control" type="number" min="0" max="100" step="any" inputMode="decimal" required value={input.discount}
          onChange={(event) => change("discount", event.target.value)} /></label>
        <label className="form-label">VAT (%)<input className="form-control" value="5" readOnly /></label>
        <label className="form-label">Adjustment<input className="form-control" inputMode="decimal" value={input.adjustment}
          onChange={(event) => change("adjustment", event.target.value)} /></label>
        <label className="form-label fw-bold">Grand Total<input className="form-control fw-bold text-success" value={preview?.grandTotal ?? ""} readOnly /></label>
      </div></div>

      <section className="card shadow-sm mt-4 quotation-terms"><div className="card-header bg-light"><h2 className="h6 mb-0">Additional Details</h2></div>
        <div className="card-body"><div className="row g-3">
          <div className="col-md-4"><label className="form-label">Kind Attention<input className="form-control" maxLength={200} required={!localWrite}
            placeholder="Person / Department" value={input.kindAttention} onChange={(event) => change("kindAttention", event.target.value)} /></label></div>
          {terms.slice(0, 2).map(([key, label, placeholder]) => <div className="col-md-4" key={key}><label className="form-label">{label}
            <input className="form-control" maxLength={quotationTermLimit(key, remoteWrite)} placeholder={placeholder} value={input[key] ?? ""}
              onChange={(event) => change(key, event.target.value || null)} /></label></div>)}
          {([["specification", "Specification", "Technical specifications"], ["generalExclusion", "General Exclusion", "Excluded items or scope"]] as const)
            .map(([key, label, placeholder]) => <div className="col-md-6" key={key}><label className="form-label">{label}
              <textarea className="form-control" rows={3} maxLength={quotationTermLimit(key, remoteWrite)} placeholder={placeholder} value={input[key] ?? ""}
                onChange={(event) => change(key, event.target.value || null)} /></label></div>)}
          {terms.slice(2).map(([key, label, placeholder]) => <div className="col-md-4" key={key}><label className="form-label">{label}
            <input className="form-control" maxLength={quotationTermLimit(key, remoteWrite)} placeholder={placeholder} value={input[key] ?? ""}
              onChange={(event) => change(key, event.target.value || null)} /></label></div>)}
          <div className="col-md-8"><label className="form-label">Notes<textarea className="form-control" rows={3} maxLength={10_000}
            placeholder="Additional remarks" value={input.notes ?? ""} onChange={(event) => change("notes", event.target.value || null)} /></label></div>
          <div className="col-md-4"><label className="form-label">Valid Until<input className="form-control" type="date" min={minimumValidUntil}
            value={input.validUntil ?? ""} onChange={(event) => change("validUntil", event.target.value || null)} /></label></div>
        </div></div></section>

      {caps.data?.blockedOperationId && <p role="alert">An earlier operation needs reconciliation before another change can be submitted.</p>}
      {taskId && caps.data && !caps.data.canCreate && <p role="alert">This deal is not eligible for a new quotation.</p>}
      {taskId && writes.error && <p role="alert">{writes.error}</p>}
      {taskId && localWrite && <p className="field-hint">This proposal is saved locally; it does not synchronize with Zoho.</p>}
      {remoteWrite && <p className="field-hint">This quotation is saved in Zoho and verified. Kind Attention and Notes are kept in Hub and its PDF.</p>}
      {!preview && <p role="alert" className="error">{input.items.length === 0
        ? "Add at least one item before saving the proposal."
        : "Check the quotation fields. Use decimal numbers for quantities and amounts, quantities greater than zero, and discounts from 0 to 100%."}</p>}
      <div className="quotation-save-bar text-end mt-4"><button type="submit" className="btn btn-danger px-4" disabled={!canSubmit}>
        <i className="ph ph-floppy-disk me-1" aria-hidden="true" />{saving ? "Saving Proposal..." : "Save Proposal"}</button></div>
    </fieldset></form>
  </section><dialog ref={statusDialog} className="crm-item-status-dialog" aria-labelledby="quotation-status-title" onCancel={event => { if (saving) event.preventDefault(); }}>
    {saving ? <><div className="crm-item-status-spinner" aria-hidden="true" /><h2 id="quotation-status-title">Creating Quote</h2><p role="status">Please wait, quote is being created...</p></> : <>
      <div className={`crm-item-status-icon${error ? " crm-item-status-error" : ""}`} aria-hidden="true">{error ? "!" : "✓"}</div>
      <h2 id="quotation-status-title">{error ? "Creation Failed" : "Quote Created Successfully"}</h2>
      <p role={error ? "alert" : "status"}>{error || (savedRemote ? "Saved in Zoho and verified. Kind Attention and Notes are kept in Hub and its PDF." : "Proposal saved locally. Not synchronized with Zoho.")}</p>
      {saved && <>{savedQuotation.loading && <p role="status">Loading saved quotation details...</p>}
        {savedQuotation.error && <p role="alert">The proposal was saved, but its details could not be loaded. Open the saved quotation to review it.</p>}
        {savedQuotation.data && <div className="crm-item-status-details"><div><strong>Quote Number:</strong> {savedQuotation.data.quoteNumber}</div><div><strong>Quote ID:</strong> {savedQuotation.data.id}</div><div><strong>Task Number:</strong> {savedQuotation.data.taskId}</div>
          {savedQuotation.data.pdfAvailable === true && <a className="btn btn-primary btn-sm mt-3" href={`/api/quotations/${selectedTaskId}/pdf`}>Download PDF</a>}</div>}
        <Link href={`/quotations/${selectedTaskId}`}>View saved quotation</Link></>}
      <div className="crm-item-status-actions"><button type="button" onClick={() => statusDialog.current?.close()}>OK</button></div>
    </>}
  </dialog></div>;
}
