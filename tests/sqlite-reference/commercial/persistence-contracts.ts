import type { calculateQuotation, QuotationInput } from "./quotations";
export interface CommercialPage<T> { items: T[]; total: number; page: number; pageSize: number }
export interface ProductRecord { externalId: string; name: string; description: string | null; unitPrice: string | null; version: number; createdAt: string; updatedAt: string }
export interface QuotationSummary { id: string; taskId: string; externalId: string; quoteNumber: string; subject: string;
  accountName: string | null; dealName: string; assignedName: string | null; subtotal: string; grandTotal: string;
  /** Read-only list context, omitted only by older API snapshots. */
  dealNumber?: string | null; dealStatus?: string; jobStatus?: string | null;
  version: number; taskVersion: number; createdAt: string; updatedAt: string }
export interface QuotationDetail extends QuotationSummary {
  remoteModifiedAt: string; calculationPolicy: "percentage-create-v1"; quotation: QuotationInput;
  totals: ReturnType<typeof calculateQuotation>;
  task: { dealName: string; dealNumber: string | null; accountName: string | null; customerName: string | null;
    customerEmail: string | null; customerContact: string | null; address: string | null; status: string; jobStatus?: string | null;
    assignedExternalId: string | null; assignedName: string | null; assignedCompany: string | null; assignedSaleName: string | null;
    createdAt: string; quoteDealDate: string | null; quoteDealNumber: string | null;
    pBox: string | null; trn: string | null; taxTotal: string | null };
}
export interface QuotationCandidate { taskId: string; dealName: string; dealNumber: string | null; accountName: string | null; version: number }
export interface QuotationCapabilities { taskVersion: number; quoteVersion: number | null; canCreate: boolean; canEdit: boolean;
  integrationAvailable: boolean; discountedEditBlocked: boolean; blockedOperationId?: string }
export interface CommercialMutationResult { operationId: string; taskId?: string; productId?: string; quoteId?: string; version: number; quoteVersion?: number }
