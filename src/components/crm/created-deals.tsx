"use client";
import Link from "next/link";
import { useState } from "react";
import type { CreatedDealsPage } from "@voltronix/crm-contracts";
import { Pagination, SearchBox } from "@/components/settings/client";
import { RecordedValue, useRead } from "./read-client";

export function CreatedDeals({ canViewDetails }: { canViewDetails: boolean }) {
  const [query, setQuery] = useState(""), [page, setPage] = useState(1);
  const result = useRead<CreatedDealsPage>("/api/deals?" + new URLSearchParams({ query, page: String(page), pageSize: "25" }));
  return <div className="crm-stack"><h1>Self Created Deals</h1>
    <section className="card" aria-label="Created deals"><div className="card-body">
      <SearchBox label="Search created deals" onSearch={(value) => { setQuery(value); setPage(1); }} />
      <p className="field-hint mb-3">Deals created through this CRM. Recorded deal status is shown.</p>
      {result.loading && <p role="status">Loading created deals...</p>}{result.error && <p role="alert" className="error">{result.error}</p>}
      {result.data && <><div className="table-responsive table-scroll"><table className="table table-hover mb-0 w-100 crm-created-deals"><thead><tr><th>Date Created</th><th>Deal No.</th><th>Job No.</th><th>Account Name</th><th>Deal Status</th><th>Salesperson</th><th className="text-end">Amount</th><th>Action</th></tr></thead><tbody>
        {result.data.items.map((deal) => <tr key={deal.id}><td><RecordedValue value={deal.createdAt} /></td><td><RecordedValue value={deal.qualificationNumber} /></td><td><RecordedValue value={deal.jobNumber} /></td><td><div className="crm-cell-scroll"><RecordedValue value={deal.accountName} /></div></td><td><span className="badge bg-success"><RecordedValue value={deal.status} /></span></td><td><RecordedValue value={deal.assignedName} /></td><td className="text-end"><RecordedValue value={deal.serviceCharge} /></td><td>{canViewDetails ? <Link className="btn btn-sm btn-outline-secondary" href={"/leads/" + deal.id} aria-label={"View deal " + (deal.qualificationNumber ?? deal.id)}><i className="ph ph-eye" aria-hidden="true" /><span className="visually-hidden">View deal</span></Link> : <span className="field-hint">Lead access required</span>}</td></tr>)}
      </tbody></table></div>{result.data.total === 0 && <p>No created deals match your search.</p>}<Pagination data={result.data} page={page} onPage={setPage} /></>}
    </div></section>
  </div>;
}
