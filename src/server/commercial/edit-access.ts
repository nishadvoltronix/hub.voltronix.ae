import { isLocalPersistence } from "@voltronix/crm-contracts";
import type { QuotationCapabilities, QuotationDetail } from "./persistence-contracts";

type Actor = { localUserId: string; externalUserId: string | null; permissions: readonly string[] };
type Quote = Pick<QuotationDetail, "persistence" | "localOwnerId" | "externalId" | "taskVersion" | "version"> & { task: { assignedExternalId: string | null } };

/** Missing subform identity is never reconstructed from row positions or product IDs. */
export function hasRemoteQuotationRows(quote: Pick<QuotationDetail, "remoteRowIds" | "quotation"> | undefined): boolean {
  const rows = quote?.remoteRowIds;
  return Array.isArray(rows) && rows.length > 0 && rows.length === quote?.quotation.items.length
    && rows.every(id => typeof id === "string" && /^[1-9][0-9]{0,29}$/.test(id)) && new Set(rows).size === rows.length;
}

/** Local ownership is accepted only with positively confirmed server capabilities and the same snapshot. */
export function canOpenQuotationEditor(user: Actor, quote: Quote, capabilities?: QuotationCapabilities): boolean {
  if (!user.permissions.some(key => key === "leads.manage" || key === "leads.manage.agents")) return false;
  if (!isLocalPersistence(quote.persistence)) return quote.persistence === "zoho" && capabilities?.persistence === "zoho"
    && capabilities.integrationAvailable && capabilities.canEdit && !capabilities.discountedEditBlocked && !capabilities.blockedOperationId
    && capabilities.taskVersion === quote.taskVersion && capabilities.quoteVersion === quote.version
    && user.externalUserId !== null && user.externalUserId === quote.task.assignedExternalId;
  return quote.localOwnerId === user.localUserId && quote.externalId === null && quote.task.assignedExternalId === null
    && capabilities?.persistence === quote.persistence && capabilities.canEdit && !capabilities.discountedEditBlocked && !capabilities.blockedOperationId
    && capabilities.taskVersion === quote.taskVersion && capabilities.quoteVersion === quote.version;
}
