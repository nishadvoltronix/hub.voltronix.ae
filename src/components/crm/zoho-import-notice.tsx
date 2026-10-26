import type { ZohoSyncSource } from "@voltronix/crm-contracts";

export const ZOHO_IMPORT_NOTICE = "Read-only Zoho import. This is a local snapshot, not live synchronization. Make changes in Zoho.";

export function ZohoImportNotice({ className = "", detail, source }: { className?: string; detail?: string; source?: ZohoSyncSource }) {
  const message = source?.lastSyncedAt ? source.deleted ? "Deleted in Zoho. This retained record is read-only."
    : source.conflict ? "Zoho synchronization needs review. This record is read-only until the conflict is resolved."
      : "Synchronized from Zoho. Make changes in the old CRM or Zoho; this record is read-only in Hub." : ZOHO_IMPORT_NOTICE;
  return <p role="status" className={`alert alert-info ${className}`}>{message}{source?.lastSyncedAt && <> Last synchronized: <time dateTime={source.lastSyncedAt}>{source.lastSyncedAt}</time>.</>}{detail ? ` ${detail}` : ""}</p>;
}
