"use client";
import { isLocalPersistence } from "@voltronix/crm-contracts";
import Link from "next/link";
import { useState } from "react";
import type { CommercialPage, QuotationCapabilities, QuotationDetail, QuotationSummary } from "@/server/commercial/persistence-contracts";
import { Pagination, SearchBox } from "@/components/settings/client";
import { RecordedValue, useRead } from "./read-client";
import { HISTORICAL_QUOTATION_NOTICE } from "./quotation-display";
import { CommercialPageLength, CommercialSortHeading } from "./commercial-list-controls";
import type { QUOTATION_SORTS } from "@/server/commercial/list-order";
import { SyncedQuotations } from "./synced-quotations";
function dealStatusColor(status?: string) {
  if (["Pending", "Qualification"].includes(status ?? "")) return "bg-primary";
  if (status === "Site Visit") return "bg-red-500";
  if (["Proposal", "Proposal/Price Quote"].includes(status ?? "")) return "bg-green-500";
  if (["Close to Won", "Closed Won"].includes(status ?? "")) return "bg-yellow-500";
  if (["Close to Lost", "Closed Lost", "Omitted", "Proposal-Omitted"].includes(status ?? "")) return "bg-pink-500";
  return "bg-secondary";
}
export function Quotations({ canCreate }: { canCreate: boolean }) {
  const [query, setQuery] = useState(""); const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10), [sort, setSort] = useState<typeof QUOTATION_SORTS[number]>("createdAt"), [direction, setDirection] = useState<"asc" | "desc">("desc");
  function order(value: typeof sort) { setDirection(sort === value && direction === "asc" ? "desc" : "asc"); setSort(value); setPage(1); }
  const result = useRead<CommercialPage<QuotationSummary>>("/api/quotations?" + new URLSearchParams({ query, page: String(page), pageSize: String(pageSize), sort, direction }));
  return <div className="crm-stack"><h1>Quotations</h1>{canCreate && <div className="actions"><Link className="btn btn-primary btn-sm" href="/quotations/new"><i className="ph ph-plus me-1" aria-hidden="true" />Create quotation</Link></div>}
    <section className="panel"><div className="crm-commercial-toolbar"><CommercialPageLength label="Quotations per page" value={pageSize} onChange={size => { setPageSize(size); setPage(1); }} /><SearchBox label="Search quotations" onSearch={(value) => { setQuery(value); setPage(1); }} /></div>
      {result.loading && <p role="status">Loading quotations...</p>}{result.error && <p role="alert" className="error">{result.error}</p>}
      {result.data && <><div className="table-scroll" role="region" aria-label="All quotations" tabIndex={0}><table className="table table-hover mb-0 crm-quotation-list"><thead><tr>{([
        ["createdAt", "Quote Created"], ["quoteNumber", "Quote Number"], ["dealNumber", "Deal Number"], ["accountName", "Account Name"], ["dealStatus", "Deal Status"], ["jobStatus", "Overall Status"], ["assignedName", "Salesperson"], ["subtotal", "Amount"],
      ] as const).map(([key, label]) => <CommercialSortHeading key={key} label={label} sortKey={key} sort={sort} direction={direction} onSort={order} />)}<th>Action</th></tr></thead><tbody>
        {result.data.items.map((quote) => <tr key={quote.id}>
          <td><time dateTime={quote.createdAt} title="Recorded quotation creation timestamp">{quote.createdAt}</time></td>
          <td><Link href={`/quotations/${quote.taskId}`}>{quote.quoteNumber}</Link></td>
          <td><RecordedValue value={quote.dealNumber} /></td><td><div className="crm-cell-scroll"><RecordedValue value={quote.accountName} /></div></td>
          <td>{quote.dealStatus ? <span className={`badge ${dealStatusColor(quote.dealStatus)}`}>{quote.dealStatus}</span> : <RecordedValue value={undefined} />}</td>
          <td>{quote.jobStatus !== undefined ? <span className={`crm-status-box ${!quote.jobStatus || quote.jobStatus === "Active" ? "crm-status-active" : quote.jobStatus === "Hold" ? "crm-status-hold" : "bg-secondary"}`}>{quote.jobStatus || "Active"}</span> : <RecordedValue value={undefined} />}</td>
          <td><RecordedValue value={quote.assignedName} /></td><td>{quote.subtotal}</td>
          <td><div className="actions">{(quote.persistence === "zoho" ? quote.pdfAvailable === true : !isLocalPersistence(quote.persistence) || quote.pdfAvailable) ? <a className="btn btn-sm btn-danger" href={`/api/quotations/${quote.taskId}/pdf`} aria-label={`Download ${quote.quoteNumber} PDF`} title="Download quotation"><i className="ph ph-download" aria-hidden="true" /></a> : <span className="small text-muted">PDF unavailable</span>}
            <Link className="btn btn-sm btn-secondary" href={`/leads/${quote.taskId}`} aria-label={`View deal for ${quote.quoteNumber}`} title="View deal"><i className="ph ph-eye" aria-hidden="true" /></Link></div></td>
        </tr>)}
      </tbody></table></div>{result.data.total === 0 && <p>No saved quotations match the current search.</p>}<Pagination data={result.data} page={page} onPage={setPage} /></>}
    </section><SyncedQuotations /><p className="notice">Eligible local deals support percentage discounts and quotations saved locally, without Zoho synchronization. Historical quotations retain their recorded values and require an approved revision before editing.</p></div>;
}
export const QUOTATION_TERMS = [
  ["project", "Project"], ["termsOfPayment", "Terms of payment"], ["specification", "Specification"], ["generalExclusion", "General exclusions"],
  ["brand", "Brand"], ["warranty", "Warranty"], ["delivery", "Delivery"], ["notes", "Notes"],
] as const;
export function QuotationDetails({ quote }: { quote: QuotationDetail }) {
  const caps = useRead<QuotationCapabilities>(`/api/quotations/${quote.taskId}/capabilities`);
  const local = isLocalPersistence(quote.persistence);
  return <div className="crm-stack"><h1>{quote.quoteNumber}</h1>{local && <p className="notice">Saved locally. Not synchronized with Zoho.</p>}<div className="actions">{(quote.persistence === "zoho" ? caps.data?.pdfAvailable === true : (!local || caps.data?.pdfAvailable === true)) && <a href={`/api/quotations/${quote.taskId}/pdf`}>Download quotation PDF</a>}
    {caps.data?.canEdit && <Link href={`/quotations/${quote.taskId}/edit`}>Edit quotation</Link>}<Link href="/quotations">All quotations</Link></div>
    {(local || quote.persistence === "zoho") && caps.data?.pdfAvailable !== true && <p className="notice">A PDF is unavailable for this quotation until its issuing company and seller details are verified.</p>}
    {caps.error && <p role="alert">{caps.error}</p>}{caps.data?.discountedEditBlocked && <p role="status" className="notice">{HISTORICAL_QUOTATION_NOTICE}</p>}
    <section className="panel" aria-label="Quotation details"><h2>{quote.quotation.subject}</h2><dl className="record-fields">
      <div><dt>Account</dt><dd><RecordedValue value={quote.task.accountName} /></dd></div><div><dt>Attention</dt><dd>{quote.quotation.kindAttention}</dd></div>
      <div><dt>Deal</dt><dd>{quote.task.dealName}</dd></div><div><dt>Valid until</dt><dd><RecordedValue value={quote.quotation.validUntil} /></dd></div>
      <div><dt>Assigned agent</dt><dd><RecordedValue value={quote.task.assignedName} /></dd></div><div><dt>{local ? "Saved locally at" : "Last confirmed"}</dt><dd><RecordedValue value={local ? quote.updatedAt : quote.remoteModifiedAt} /></dd></div>
    </dl></section>
    <section className="panel" aria-label="Quotation items"><h2>Items</h2><div className="table-scroll"><table className="crm-quotation-detail-items"><thead><tr><th>Product / description</th><th>UOM</th><th>Quantity</th><th>Unit price (AED)</th><th>Discount (%)</th><th>Line total (AED)</th></tr></thead><tbody>
      {quote.quotation.items.map((item, index) => <tr key={index}><td>{item.productName}<p className="preserve-lines">{item.description}</p></td><td>{item.uom}</td><td>{item.quantity}</td><td>{item.unitPrice}</td><td>{item.itemDiscount}</td><td>{quote.totals.lineTotals[index]}</td></tr>)}
    </tbody></table></div><dl className="record-fields"><div><dt>Subtotal (AED)</dt><dd>{quote.totals.subtotal}</dd></div>
      {quote.calculationPolicy === "percentage-only-v2" && <div><dt>Discount (%)</dt><dd>{quote.quotation.discount}</dd></div>}
      <div><dt>{quote.calculationPolicy === "percentage-only-v2" ? "Discount amount (AED)" : "Saved header discount (AED)"}</dt><dd>{quote.totals.headerDiscount}</dd></div>
      <div><dt>Taxable amount (AED)</dt><dd>{quote.totals.taxable}</dd></div><div><dt>VAT (5%)</dt><dd>{quote.totals.vatAmount}</dd></div><div><dt>Adjustment (AED)</dt><dd>{quote.totals.adjustment}</dd></div><div><dt>Grand total (AED)</dt><dd>{quote.totals.grandTotal}</dd></div></dl>
    </section><section className="panel" aria-label="Quotation terms"><h2>Terms</h2><dl className="record-fields">{QUOTATION_TERMS.map(([key, label]) => <div key={key}><dt>{label}</dt><dd><RecordedValue value={quote.quotation[key]} /></dd></div>)}</dl></section>
  </div>;
}
