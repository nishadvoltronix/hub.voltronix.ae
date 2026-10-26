import type { SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { inspectZohoImportExtension } from "./zoho-import-store.js";

export class ZohoImportReadOnlyError extends Error {
  readonly status = 409;
  constructor() {
    super("Imported Zoho records are read-only local snapshots. Changes are unavailable in this CRM.");
    this.name = "ZohoImportReadOnlyError";
  }
}

/** Import membership is separate from ordinary remote IDs and local workflow
 * ownership. No existing record becomes read-only merely because it has a Zoho
 * identifier. Reinspect the immutable extension rather than caching absence. */
export function createZohoImportGuard(db: SqliteDatabase) {
  function isImported(taskId: unknown): boolean {
    if (!inspectZohoImportExtension(db)) return false;
    if (typeof taskId !== "string" || !/^[1-9][0-9]{0,18}$/.test(taskId)
      || BigInt(taskId) > 9_223_372_036_854_775_807n) return false;
    return !!db.prepare("SELECT 1 FROM crm_demo_zoho_import_records WHERE module='Deals' AND local_id=?").get(taskId);
  }
  function assertWritable(taskId: unknown, authorizeRead: () => unknown): void {
    if (!isImported(taskId)) return;
    // Keep authentication and each endpoint's existing resource scope ahead of
    // the read-only response; an ID guess must not reveal import membership.
    authorizeRead();
    throw new ZohoImportReadOnlyError();
  }
  function annotate<T extends object>(taskId: unknown, value: T): T & { sourceImport?: { provider: "zoho"; readOnly: true } } {
    return isImported(taskId) ? { ...value, sourceImport: { provider: "zoho", readOnly: true } } : value;
  }
  return { isImported, assertWritable, annotate };
}
