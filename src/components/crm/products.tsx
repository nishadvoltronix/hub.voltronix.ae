"use client";
import { assertPersistenceReceipt, hasRemoteWorkflow, isLocalPersistence } from "@voltronix/crm-contracts";
import Link from "next/link";
import { useRef, useState } from "react";
import type { CrmWriteCapabilities } from "@voltronix/crm-contracts";
import type { CommercialMutationResult, CommercialPage, ProductRecord } from "@/server/commercial/persistence-contracts";
import { message, Pagination, SearchBox, writeApi } from "@/components/settings/client";
import { RecordedValue, useRead } from "./read-client";
import { CommercialPageLength, CommercialSortHeading } from "./commercial-list-controls";
export function Products({ canCreate }: { canCreate: boolean }) {
  const [query, setQuery] = useState(""); const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10), [sort, setSort] = useState<"name" | "updatedAt">("name"), [direction, setDirection] = useState<"asc" | "desc">("asc");
  function order(value: typeof sort) { setDirection(sort === value && direction === "asc" ? "desc" : "asc"); setSort(value); setPage(1); }
  const capabilities = useRead<CrmWriteCapabilities>("/api/capabilities");
  const result = useRead<CommercialPage<ProductRecord>>("/api/items?" + new URLSearchParams({ query, page: String(page), pageSize: String(pageSize), sort, direction }));
  return <div className="crm-stack"><h1>Items</h1>
    <p className="notice">{hasRemoteWorkflow(capabilities.data) ? "Showing saved products. New products are saved in Zoho and verified before appearing in Hub." : capabilities.data?.productCreate ? "Showing saved products. New products are saved locally and are not synchronized with Zoho." : "Showing saved products. Live synchronization and product creation require a verified Zoho connection."}</p>
    {capabilities.error && <p role="alert" className="error">{capabilities.error}</p>}
    {canCreate && <div className="actions"><Link className="btn btn-primary btn-sm" href="/items/new"><i className="ph ph-plus me-1" aria-hidden="true" />Create Item</Link></div>}
    <section className="panel"><div className="crm-commercial-toolbar"><CommercialPageLength label="Items per page" value={pageSize} onChange={size => { setPageSize(size); setPage(1); }} /><SearchBox label="Search Items" onSearch={(value) => { setQuery(value); setPage(1); }} /></div>
      {result.loading && <p role="status">Loading products...</p>}{result.error && <p role="alert" className="error">{result.error}</p>}
      {result.data && <><p><strong>Records on this page:</strong> {result.data.items.length}</p><div className="table-scroll" role="region" aria-label="Items" tabIndex={0}><table className="table table-bordered table-hover table-sm crm-product-list"><thead><tr><th>#</th><CommercialSortHeading label="Item Name" sortKey="name" sort={sort} direction={direction} onSort={order} /><CommercialSortHeading label="Modified" sortKey="updatedAt" sort={sort} direction={direction} onSort={order} /></tr></thead><tbody>
        {result.data.items.map((item, index) => <tr key={item.externalId}><td>{(page - 1) * result.data!.pageSize + index + 1}</td><td>{item.name}</td><td><RecordedValue value={item.updatedAt} /></td></tr>)}
      </tbody></table></div>{result.data.total === 0 && <p>No items found.</p>}<Pagination data={result.data} page={page} onPage={setPage} /></>}
    </section></div>;
}
export function ProductCreate() {
  const capabilities = useRead<CrmWriteCapabilities>("/api/capabilities");
  const [name, setName] = useState(""), [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [savedName, setSavedName] = useState("");
  const dialog = useRef<HTMLDialogElement>(null), nameInput = useRef<HTMLInputElement>(null);
  const request = useRef<{ key: string; operationId: string } | null>(null);
  const remoteWrite = hasRemoteWorkflow(capabilities.data);
  const available = capabilities.data?.productCreate && (remoteWrite || isLocalPersistence(capabilities.data?.persistence));
  const [savedRemote, setSavedRemote] = useState(false);
  return <div className="crm-stack"><h1>Create Item</h1>
    {capabilities.loading ? <p role="status">Loading available product actions...</p> : <p className="notice">{available ? remoteWrite ? "Products created here are saved in Zoho and recorded in Hub after verification." : "Products created here are saved locally. They are not synchronized with Zoho." : "Product creation is unavailable until an approved Zoho connection is verified. No product will be saved from this form."}</p>}
    {capabilities.error && <p role="alert" className="error">{capabilities.error}</p>}
    <section className="card"><div className="card-body"><form onSubmit={async (event) => {
      event.preventDefault(); if (!available || busy) return;
      const payload = { name: name.trim(), description: description.trim() }, key = JSON.stringify(payload);
      if (!payload.name) { nameInput.current?.setCustomValidity("Item Name is required."); nameInput.current?.reportValidity(); return; }
      if (request.current?.key !== key) request.current = { key, operationId: crypto.randomUUID() };
      setBusy(true); setError(""); setSavedName(""); dialog.current?.showModal();
      try { const saved = await writeApi<CommercialMutationResult>("/api/items", "POST", { ...payload, operationId: request.current.operationId });
        if (remoteWrite) assertPersistenceReceipt(saved, { operationId: request.current.operationId, persistence: "zoho" });
        setSavedRemote(saved.persistence === "zoho"); setName(""); setDescription(""); request.current = null; setSavedName(payload.name); }
      catch (caught) { setError(message(caught)); } finally { setBusy(false); }
    }}><div className="card shadow-sm mb-0"><div className="card-header bg-light"><h2 className="h6 mb-0"><i className="ph ph-package me-2" aria-hidden="true" />Add New Item</h2></div>
      <div className="card-body"><div className="row g-3"><div className="col-md-12"><label className="form-label">Item Name <span className="text-danger">*</span><input className="form-control" ref={nameInput} aria-label="Item Name" required maxLength={200} name="name" placeholder="Enter item name" value={name} disabled={busy} onChange={(event) => { event.target.setCustomValidity(""); setName(event.target.value); }} /></label></div>
      <div className="col-md-12"><label className="form-label">Description (Optional)<textarea className="form-control" rows={3} maxLength={10_000} name="description" value={description} disabled={busy} onChange={(event) => setDescription(event.target.value)} /></label></div></div></div>
      <div className="card-footer text-end"><button className="btn btn-dangers px-4" type="submit" disabled={!available || busy}><i className="ph ph-floppy-disk me-1" aria-hidden="true" />{busy ? "Saving..." : "Save Item"}</button></div></div>
    </form></div></section><Link href="/items">Back to items</Link>
    <dialog ref={dialog} className="crm-item-status-dialog" aria-labelledby="item-status-title" onCancel={event => { if (busy) event.preventDefault(); }}>
      {busy ? <><div className="crm-item-status-spinner" aria-hidden="true" /><h2 id="item-status-title">Creating Item</h2><p role="status">{remoteWrite ? "Please wait, item is being saved in Zoho and verified..." : "Please wait, item is being saved locally..."}</p></> : <>
        <div className={`crm-item-status-icon${error ? " crm-item-status-error" : ""}`} aria-hidden="true">{error ? "!" : "✓"}</div>
        <h2 id="item-status-title">{error ? "Item Creation Failed" : "Item Created Successfully"}</h2>
        <p role={error ? "alert" : "status"}>{error || (savedRemote ? "Saved in Zoho and verified." : "Saved locally. Not synchronized with Zoho.")}</p>
        {!error && <div className="crm-item-status-details"><strong>Item Name:</strong> {savedName}</div>}
        <div className="crm-item-status-actions">{!error && <button type="button" onClick={() => { dialog.current?.close(); nameInput.current?.focus(); }}>Create Another</button>}<button type="button" onClick={() => dialog.current?.close()}>OK</button></div>
      </>}
    </dialog></div>;
}
