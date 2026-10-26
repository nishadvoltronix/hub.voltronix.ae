import type { MysqlDatabase } from "../../crm/db/mysql/database.js";

export class ZohoUserBindingError extends Error {
  readonly status = 403;
  constructor() { super("A verified custom Zoho application-user binding is required."); }
}
/** Caller owns the current authorization transaction. No lookup fallback to a
 * standard Zoho owner, same-name record, stale session identity or another org. */
export async function assertZohoActorBinding(db: MysqlDatabase,
  user: { localUserId: string; externalUserId: string | null }, organizationId: string): Promise<void> {
  if (!/^[1-9][0-9]{0,29}$/.test(organizationId) || !user.externalUserId || !/^[1-9][0-9]{0,29}$/.test(user.externalUserId)) throw new ZohoUserBindingError();
  const row = await db.prepare(`SELECT b.organization_id organizationId,b.module_api_name moduleName,b.external_user_id externalId,
    b.record_email boundEmail,u.user_id currentExternalId,u.email currentEmail,u.status
    FROM crm_zoho_user_bindings b JOIN users u ON u.id=b.local_user_id WHERE b.local_user_id=?`).get(user.localUserId) as {
      organizationId: string; moduleName: string; externalId: string; boundEmail: string; currentExternalId: string | null; currentEmail: string; status: string;
    } | undefined;
  if (!row || row.organizationId !== organizationId || row.moduleName !== "VZ_app_users" || row.externalId !== user.externalUserId
    || row.currentExternalId !== user.externalUserId || row.status !== "active" || typeof row.boundEmail !== "string" || typeof row.currentEmail !== "string"
    || row.boundEmail.toLowerCase() !== row.currentEmail.toLowerCase()) throw new ZohoUserBindingError();
  if (await db.prepare("SELECT 1 FROM crm_zoho_sync_records WHERE organization_id=? AND module_api_name='VZ_app_users' AND external_id=? AND state!='active' LIMIT 1")
    .get(organizationId, user.externalUserId)) throw new ZohoUserBindingError();
}
