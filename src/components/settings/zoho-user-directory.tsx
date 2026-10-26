"use client";

import Link from "next/link";
import { useState } from "react";
import type { ZohoDirectoryUser } from "@voltronix/crm-contracts";
import { RecordedValue } from "@/components/crm/read-client";
import { Pagination, SearchBox, usePaged } from "./client";

function SyncedAt({ value }: { value: string }) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return <span className="text-muted">Not recorded</span>;
  return <time dateTime={value}>{new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Dubai",
  }).format(timestamp)}</time>;
}

export function ZohoUserDirectory() {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const list = usePaged<ZohoDirectoryUser>("/api/settings/zoho-users", query, page);
  return <section className="card mt-4" aria-label="Zoho user directory">
    <div className="card-header"><h2 className="h5">Zoho CRM users</h2></div>
    <div className="card-body">
      <p>Users saved from Zoho. A linked CRM login lets a salesperson see their assigned leads. Login access and permissions are managed separately.</p>
      <SearchBox label="Search Zoho users" onSearch={value => { setQuery(value); setPage(1); }} />
      {list.loading && <p role="status">Loading Zoho users...</p>}
      {list.error && <p role="alert" className="error">{list.error}</p>}
      {list.data && <>
        <div className="table-responsive table-scroll" role="region" aria-label="Zoho CRM users" tabIndex={0}>
          <table className="table table-hover mb-0"><thead><tr><th>Name</th><th>Email</th><th>Zoho status</th><th>CRM account</th><th>Last synced</th></tr></thead>
            <tbody>{list.data.items.map(row => <tr key={row.externalId}>
              <td className="text-break"><strong><RecordedValue value={row.name} /></strong></td>
              <td className="text-break"><RecordedValue value={row.email} /></td>
              <td><span className={"badge " + (row.sourceState === "active" && row.status === "active" ? "bg-success" : "bg-secondary")}>
                {row.sourceState === "deleted" ? "Deleted" : row.status === "active" ? "Active" : row.status === "inactive" ? "Inactive" : row.status || "Not recorded"}
              </span>{row.sourceState === "conflict" && <small className="d-block">Sync needs review</small>}</td>
              <td>{row.linkedUser ? <>
                <Link href={"/settings/users?editId=" + row.linkedUser.id}>{row.linkedUser.name}</Link>
                <small className="d-block">{row.linkedUser.status === "active" ? "Active login" : "Inactive login"}</small>
              </> : <span>No linked login</span>}
                {row.linkState === "linked" && <span className="badge bg-success d-block">Linked</span>}
                {row.linkState === "review-required" && <span className="badge bg-warning text-dark d-block">Link needs review</span>}
              </td>
              <td><SyncedAt value={row.lastSyncedAt} /></td>
            </tr>)}</tbody>
          </table>
        </div>
        {list.data.items.length === 0 && <p>No Zoho users match your search.</p>}
      </>}
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mt-3">
        <Pagination data={list.data} page={page} onPage={setPage} />
        <button type="button" className="btn btn-outline-secondary" onClick={list.reload} disabled={list.loading}>Refresh Zoho users</button>
      </div>
      <p className="field-hint mt-2">Times use Asia/Dubai. Refresh displays saved users from the latest sync.</p>
    </div>
  </section>;
}
