"use client";
import { hasRemoteWorkflow, isLocalPersistence } from "@voltronix/crm-contracts";
import Link from "next/link";
import { useRef, useState } from "react";
import type { CrmWriteCapabilities } from "@voltronix/crm-contracts";
import type { LeadMutationResult } from "@/server/lead-mutations/contracts";
import { parseDealInput } from "@/server/commercial/deals";
import { message, writeApi } from "@/components/settings/client";
import { useRead } from "./read-client";
import { createLocalWriteState } from "./local-write-state";

export function DealForm() {
  const capabilities = useRead<CrmWriteCapabilities>("/api/capabilities");
  const operation = useRef(createLocalWriteState());
  const form = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [savedId, setSavedId] = useState("");
  const remoteWrite = hasRemoteWorkflow(capabilities.data);
  const available = capabilities.data?.dealCreate && (remoteWrite || (isLocalPersistence(capabilities.data?.persistence) && capabilities.data.localWorkflow));
  const [savedRemote, setSavedRemote] = useState(false);
  return <div className="crm-stack"><h1>Create deal</h1>
    {capabilities.loading ? <p role="status">Loading available deal actions...</p> : <p className="notice">{available
      ? remoteWrite ? "New deals are saved in Zoho and recorded in Hub after verification." : "New deals are saved locally under your account. They are not synchronized with Zoho."
      : "Deal creation is unavailable in this runtime. Existing Zoho records require an approved connection."}</p>}
    {(error || capabilities.error) && <p role="alert" className="error">{error || capabilities.error}</p>}
    {savedId && <div role="status" className="success">{savedRemote ? "Saved in Zoho and verified." : "Saved locally. Not synchronized with Zoho."} <Link href={`/leads/${savedId}`}>View created deal</Link></div>}
    <section className="card" aria-label="Customer and deal information"><form ref={form} onSubmit={async event => {
      event.preventDefault(); if (!available || busy || savedId) return;
      setBusy(true); setError("");
      try {
        const fields = new FormData(event.currentTarget);
        const payload = parseDealInput(Object.fromEntries(fields.entries()));
        if (remoteWrite && !payload.closingDate) throw new Error("Enter the expected closing date for Zoho.");
        if (remoteWrite && `${payload.firstName} ${payload.lastName}`.length > 120) throw new Error("The combined first and last name must be at most 120 characters for Zoho.");
        const saved = await operation.current.run(payload, value => writeApi<LeadMutationResult>("/api/deals", "POST", value), remoteWrite ? "zoho" : undefined);
        if (saved) { setSavedRemote(saved.persistence === "zoho"); setSavedId(saved.taskId); }
      } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
    }}><fieldset className="border-0 p-0 m-0" disabled={!available || busy || !!savedId}>
      <div className="card-body"><h2 className="h6 text-dangers mb-3">Customer Information</h2><div className="row g-3">
        <div className="col-md-3"><label className="form-label">First name<input className="form-control" name="firstName" required maxLength={remoteWrite ? 40 : 100} autoComplete="given-name" /></label></div>
        <div className="col-md-3"><label className="form-label">Last name<input className="form-control" name="lastName" required maxLength={remoteWrite ? 80 : 100} autoComplete="family-name" /></label></div>
        <div className="col-md-3"><label className="form-label">Company name<input className="form-control" name="companyName" required maxLength={200} autoComplete="organization" /></label></div>
        <div className="col-md-3"><label className="form-label">Customer email<input className="form-control" name="email" type="email" required maxLength={remoteWrite ? 100 : 254} autoComplete="email" /></label></div>
      </div><hr className="my-4" /><h2 className="h6 text-dangers mb-3">Contact Details</h2><div className="row g-3">
        <div className="col-md-2"><label className="form-label">Mobile<input className="form-control" name="mobile" type="tel" required maxLength={remoteWrite ? 30 : 40} /></label></div>
        <div className="col-md-2"><label className="form-label">Phone<input className="form-control" name="phone" type="tel" required maxLength={remoteWrite ? 30 : 40} /></label></div>
        <div className="col-md-3"><label className="form-label">Company department<select className="form-select" name="department" required defaultValue=""><option value="">Select department</option><option>VOLTRONIX CONTRACTING LLC</option><option>VOLTRONIX SWITCHGEAR LLC</option></select></label></div>
        <div className="col-md-3"><label className="form-label">P.O. box<input className="form-control" name="poBox" maxLength={100} /></label></div>
        <div className="col-md-2"><label className="form-label">TRN<input className="form-control" name="trn" maxLength={100} /></label></div>
      </div><hr className="my-4" /><h2 className="h6 text-dangers mb-3">Additional Information</h2><div className="row g-3">
        {remoteWrite && <div className="col-md-4"><label className="form-label">Expected closing date<input className="form-control" name="closingDate" type="date" required /></label></div>}
        <div className="col-md-6"><label className="form-label">Address<textarea className="form-control" name="address" rows={3} maxLength={remoteWrite ? 250 : 2000} /></label></div>
        <div className="col-md-6"><label className="form-label">Description<textarea className="form-control" name="description" rows={3} maxLength={10_000} /></label></div>
      </div></div><div className="card-footer d-flex justify-content-end"><button className="btn btn-dangers px-4" type="submit" disabled={!available || busy || !!savedId}>{busy ? "Saving deal..." : "Save Deal"}</button></div>
    </fieldset></form></section>
    {savedId && <button className="btn btn-outline-secondary" type="button" onClick={() => { form.current?.reset(); setSavedId(""); setError(""); }}>Create another deal</button>}
  </div>;
}
