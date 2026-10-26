"use client";
import { useState } from "react";
import Link from "next/link";
import type { CrmWriteCapabilities, SyncedQuotationsPage, ZohoSyncStatus } from "@voltronix/crm-contracts";
import { Pagination, SearchBox } from "@/components/settings/client";
import { RecordedValue, useRead } from "./read-client";

const headerLabels: Record<string, string> = { project: "Project", termsOfPayment: "Terms of payment", specification: "Specification",
  generalExclusion: "General exclusions", brand: "Brand", warranty: "Warranty", delivery: "Delivery", validTill: "Valid until", description: "Description" };
export function SyncedQuotations({ taskId }: { taskId?: string }) {
  const capabilities = useRead<CrmWriteCapabilities>("/api/capabilities");
  const [page, setPage] = useState(1), [query, setQuery] = useState("");
  const params = new URLSearchParams({ page: String(page), pageSize: "10", query, ...(taskId ? { taskId } : {}) });
  const result = useRead<SyncedQuotationsPage>(capabilities.data?.zohoInbound ? "/api/zoho-sync/quotations?" + params : null);
  const status = useRead<ZohoSyncStatus>(capabilities.data?.zohoInbound ? "/api/zoho-sync/status" : null);
  if (!capabilities.data?.zohoInbound) return null;
  return <section className="panel" aria-label="Quotations synchronized from Zoho"><h2>Quotations from Zoho</h2>
    <p className="field-hint">Recorded quotation values, synchronized from Zoho. Changes are made in the old CRM or Zoho.</p>
    {status.data && <p role="status">{({ idle: "The first synchronization has not completed.", running: "Synchronization is running.",
      partial: "Synchronization completed with records requiring review.", ready: "The last synchronization completed.", failed: "Synchronization needs attention. Previously synchronized values may be out of date." })[status.data.state]}
      {status.data.lastSuccessAt && <> Last completed pass: <time dateTime={status.data.lastSuccessAt}>{status.data.lastSuccessAt}</time>.</>}</p>}
    {status.error && <p role="alert">Synchronization status is unavailable.</p>}
    {!taskId && <SearchBox label="Search synchronized quotations" onSearch={value => { setQuery(value); setPage(1); }} />}
    <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => { result.reload(); status.reload(); }}>Refresh synchronized quotations</button>
    {result.loading && <p role="status">Loading synchronized quotations...</p>}{result.error && <p role="alert">{result.error}</p>}
    {result.data?.items.map(quote => <details key={quote.id} className="note-card"><summary>{quote.quoteNumber ?? "Quotation number not recorded"} · {quote.subject}</summary>
      <p>{quote.taskId ? <Link href={`/leads/${quote.taskId}`}>{quote.dealName}</Link> : "A linked deal is not available in Hub."}</p>
      {(quote.deleted || quote.conflict) && <p role="status" className="notice">{quote.deleted ? "Deleted in Zoho; retained for reference." : "This quotation has a synchronization conflict requiring review."}</p>}
      <dl className="record-fields"><div><dt>Account</dt><dd><RecordedValue value={quote.accountName} /></dd></div>
        <div><dt>Recorded currency</dt><dd><RecordedValue value={quote.currency} /></dd></div>
        <div><dt>Modified in Zoho</dt><dd><time dateTime={quote.modifiedAt}>{quote.modifiedAt}</time></dd></div>
        <div><dt>Last synchronized</dt><dd><time dateTime={quote.lastSyncedAt}>{quote.lastSyncedAt}</time></dd></div></dl>
      <div className="table-scroll" role="region" aria-label="Recorded quotation items" tabIndex={0}><table className="table"><thead><tr><th>Product / description</th><th>UOM</th><th>Quantity</th><th>Unit price</th><th>Recorded discount</th><th>Recorded line total</th></tr></thead>
        <tbody>{quote.lines.map(line => <tr key={line.externalId}><td><RecordedValue value={line.productName} /><p className="preserve-lines">{line.description}</p></td>
          <td><RecordedValue value={line.uom} /></td><td><RecordedValue value={line.quantity} /></td><td><RecordedValue value={line.unitPrice} /></td>
          <td><RecordedValue value={line.itemDiscount} /></td><td><RecordedValue value={line.netTotal} /></td></tr>)}</tbody></table></div>
      {!quote.lines.length && <p>Quotation items were not recorded in the synchronized source.</p>}
      <dl className="record-fields">{([['subtotal', 'Subtotal'], ['discount', 'Recorded discount'], ['tax', 'Recorded tax'], ['adjustment', 'Adjustment'], ['grandTotal', 'Grand total']] as const).map(([key, label]) =>
        <div key={key}><dt>{label}</dt><dd><RecordedValue value={quote.totals[key]} /></dd></div>)}</dl>
      <dl className="record-fields">{Object.entries(headerLabels).map(([key, label]) => <div key={key}><dt>{label}</dt><dd className="preserve-lines"><RecordedValue value={quote.header[key]} /></dd></div>)}</dl>
    </details>)}
    {result.data && <>{!result.data.total && <p>No synchronized quotations are available.</p>}<Pagination data={result.data} page={page} onPage={setPage} /></>}
  </section>;
}
