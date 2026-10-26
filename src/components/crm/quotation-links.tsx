"use client";
import { isLocalPersistence } from "@voltronix/crm-contracts";
import Link from "next/link";
import type { QuotationCapabilities } from "@/server/commercial/persistence-contracts";
import { useRead } from "./read-client";
import { HISTORICAL_QUOTATION_NOTICE } from "./quotation-display";
import { ZohoImportNotice } from "./zoho-import-notice";
import { SyncedQuotations } from "./synced-quotations";
export function QuotationLinks({ taskId }: { taskId: string }) {
  const result = useRead<QuotationCapabilities>(`/api/quotations/${taskId}/capabilities`);
  return <><section className="panel" aria-label="Lead quotation"><h2>Quotation</h2>
    {result.loading && <p role="status">Loading quotation access...</p>}{result.error && <p role="alert">{result.error}</p>}
    {result.data?.quoteVersion !== null && result.data && <Link href={`/quotations/${taskId}`}>View saved quotation</Link>}
    {result.data?.canCreate && !result.data.sourceImport?.readOnly && <Link href={`/quotations/new?taskId=${taskId}`}>Create quotation</Link>}
    {result.data?.discountedEditBlocked && <p>{HISTORICAL_QUOTATION_NOTICE}</p>}
    {result.data && (result.data.sourceImport?.readOnly ? <ZohoImportNotice source={result.data.sourceImport} /> : <p className="field-hint">{result.data.persistence === "zoho" && result.data.integrationAvailable ? "Eligible quotation changes are saved in Zoho and verified." : isLocalPersistence(result.data.persistence) ? "Eligible quotation changes are saved locally, without Zoho synchronization." : "Quotation changes require a verified Zoho connection."}</p>)}
  </section><SyncedQuotations taskId={taskId} /></>;
}
