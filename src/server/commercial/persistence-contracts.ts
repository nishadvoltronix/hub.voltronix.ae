import type { calculateQuotation, QuotationInput } from "./quotations";
export interface CommercialPage<T> { items: T[]; total: number; page: number; pageSize: number }
export interface ProductRecord { externalId: string; name: string; description: string | null; unitPrice: string | null; version: number; createdAt: string; updatedAt: string }
export interface QuotationSummary { id: string; taskId: string; externalId: string | null; quoteNumber: string; subject: string;
  persistence?: "local-demo" | "local-mysql" | "zoho"; localOwnerId?: string; pdfAvailable?: boolean;
  accountName: string | null; dealName: string; assignedName: string | null; subtotal: string; grandTotal: string;
  /** Read-only list context, omitted only by older API snapshots. */
  dealNumber?: string | null; dealStatus?: string; jobStatus?: string | null;
  version: number; taskVersion: number;
  /** Recorded quotation creation timestamp; never a submitted issue date. */
  createdAt: string;
  /** Recorded latest quotation save; source PDF Date uses this in Asia/Dubai. */
  updatedAt: string }
export interface QuotationDetail extends QuotationSummary {
  remoteModifiedAt: string | null; calculationPolicy: "percentage-create-v1" | "percentage-only-v2"; quotation: QuotationInput;
  /** Verified Zoho subform IDs in the same order as quotation.items. */
  remoteRowIds?: string[];
  totals: ReturnType<typeof calculateQuotation>;
  task: { dealName: string; dealNumber: string | null; accountName: string | null; customerName: string | null;
    customerEmail: string | null; customerContact: string | null; address: string | null; status: string; jobStatus?: string | null;
    assignedExternalId: string | null; assignedLocalId?: string; assignedName: string | null; assignedCompany: string | null; assignedSaleName: string | null;
    createdAt: string; quoteDealDate: string | null; quoteDealNumber: string | null;
    pBox: string | null; trn: string | null; taxTotal: string | null };
}
export interface QuotationCandidate { taskId: string; dealName: string; dealNumber: string | null; accountName: string | null; version: number; persistence?: "local-demo" | "local-mysql" | "zoho"; localOwnerId?: string }
export interface QuotationCapabilities { taskVersion: number; quoteVersion: number | null; canCreate: boolean; canEdit: boolean;
  sourceImport?: import("@voltronix/crm-contracts").ZohoSyncSource;
  integrationAvailable: boolean;
  /** Legacy wire name: true for every preserved historical quote, including zero discounts. */
  discountedEditBlocked: boolean; blockedOperationId?: string; persistence?: "local-demo" | "local-mysql" | "zoho"; pdfAvailable?: boolean }
export interface CommercialMutationResult { remoteVerified?: true; operationId: string; taskId?: string; productId?: string; quoteId?: string; version: number; quoteVersion?: number; persistence?: "local-demo" | "local-mysql" | "zoho"; localOwnerId?: string }
