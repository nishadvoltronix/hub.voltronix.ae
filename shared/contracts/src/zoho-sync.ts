/** Public projection only: never expose raw provider JSON, credentials or journals. */
export interface ZohoSyncSource {
  provider: "zoho";
  readOnly: true;
  lastSyncedAt?: string;
  sourceModifiedAt?: string;
  deleted?: boolean;
  conflict?: boolean;
}
export interface SyncedQuotation {
  id: string; taskId: string | null; dealName: string | null; accountName: string | null;
  quoteNumber: string | null; subject: string | null;
  currency?: string | null;
  createdAt: string; modifiedAt: string; lastSyncedAt: string;
  deleted: boolean; conflict: boolean;
  totals: { subtotal: string | null; discount: string | null; tax: string | null; adjustment: string | null; grandTotal: string | null };
  header: Record<string, string | null>;
  lines: { externalId: string; productName: string | null; description: string | null; uom: string | null;
    quantity: string | null; unitPrice: string | null; itemDiscount: string | null; netTotal: string | null }[];
}
export interface SyncedQuotationsPage { items: SyncedQuotation[]; total: number; page: number; pageSize: number }
export interface ZohoSyncStatus {
  state: "idle" | "running" | "partial" | "ready" | "failed";
  lastAttemptAt: string | null; lastSuccessAt: string | null;
}
/** Employee directory observations do not create application accounts or access. */
export interface ZohoDirectoryUser {
  externalId: string; name: string | null; email: string | null; status: string | null;
  sourceState: "active" | "conflict" | "deleted"; sourceModifiedAt: string; lastSyncedAt: string;
  linkedUser: { id: string; name: string; email: string; status: "active" | "inactive" } | null;
  linkState: "unlinked" | "linked" | "review-required";
}
export interface ZohoDirectoryPage { items: ZohoDirectoryUser[]; total: number; page: number; pageSize: number }
