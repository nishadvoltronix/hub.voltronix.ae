import type { ZohoSyncSource } from "@voltronix/crm-contracts";
import type { MysqlDatabase } from "../db/mysql/database.js";
import { getZohoInboundTaskSource } from "../../integrations/zoho/inbound-store.js";

/** Only trusted SQL identifiers supplied by this application, never request input. */
export function importedTaskSql(id = "t.id") {
  if (!/^(?:t\.)?id$/.test(id)) throw new Error("Invalid task identifier.");
  return `EXISTS(SELECT 1 FROM crm_zoho_sync_records sync_record WHERE sync_record.task_id=${id === "id" ? "tasks.id" : id} AND sync_record.module_api_name='Deals' AND sync_record.origin='imported')`;
}
export function visibleSyncTaskSql(id = "t.id") {
  if (!/^(?:t\.)?id$/.test(id)) throw new Error("Invalid task identifier.");
  return `NOT EXISTS(SELECT 1 FROM crm_zoho_sync_records sync_record WHERE sync_record.task_id=${id === "id" ? "tasks.id" : id} AND sync_record.module_api_name='Deals' AND sync_record.state='deleted')`;
}
/** Retained inactive source products are not offered as current items. */
export function availableSyncProductSql() {
  return "NOT EXISTS(SELECT 1 FROM crm_zoho_sync_records sync_product WHERE sync_product.module_api_name='Products' AND sync_product.external_id=products.product_id AND sync_product.state<>'active')";
}
/** Display the recorded Zoho assignee even when there is no authorized Hub
 * login binding. This expression never supplies assigned_to or access rights. */
export function recordedSyncAssigneeSql() {
  return `(SELECT CASE WHEN JSON_TYPE(JSON_EXTRACT(sync_agent.source_json,'$.assignedTo.name')) COLLATE utf8mb4_0900_bin='STRING'
    THEN JSON_UNQUOTE(JSON_EXTRACT(sync_agent.source_json,'$.assignedTo.name')) COLLATE utf8mb4_0900_bin ELSE NULL END
    FROM crm_zoho_sync_records sync_agent WHERE sync_agent.task_id=t.id AND sync_agent.module_api_name='Deals')`;
}
/** Manager display/filter identity only. Own-scope authorization must continue
 * to use tasks.assigned_to and the authenticated, verified application user. */
export function displayedSyncAssigneeIdSql() {
  return `COALESCE(t.assigned_to,(SELECT CASE WHEN JSON_TYPE(JSON_EXTRACT(sync_agent.source_json,'$.assignedTo.externalId')) COLLATE utf8mb4_0900_bin='STRING'
    AND JSON_UNQUOTE(JSON_EXTRACT(sync_agent.source_json,'$.assignedTo.externalId')) COLLATE utf8mb4_0900_bin REGEXP '^[1-9][0-9]{0,29}$'
    THEN JSON_UNQUOTE(JSON_EXTRACT(sync_agent.source_json,'$.assignedTo.externalId')) COLLATE utf8mb4_0900_bin ELSE NULL END
    FROM crm_zoho_sync_records sync_agent WHERE sync_agent.task_id=t.id AND sync_agent.module_api_name='Deals'))`;
}
export async function taskSyncSource(db: MysqlDatabase, taskId: string): Promise<ZohoSyncSource | undefined> {
  const source = await getZohoInboundTaskSource(db, taskId);
  if (!source?.readOnly) return undefined;
  return { provider: "zoho", readOnly: true, lastSyncedAt: source.lastSyncedAt,
    sourceModifiedAt: source.sourceModifiedAt, deleted: source.deleted, conflict: source.conflict };
}
export async function withTaskSyncSource<T extends object>(db: MysqlDatabase, row: T, taskId: string): Promise<T & { sourceImport?: ZohoSyncSource }> {
  const sourceImport = await taskSyncSource(db, taskId);
  return sourceImport ? { ...row, sourceImport } : row;
}
export async function withTaskSyncPage<T extends { id: string }, P extends { items: T[] }>(db: MysqlDatabase, page: P): Promise<P> {
  // Sequential reads share the caller's MySQL transaction safely.
  const items: T[] = [];
  for (const row of page.items) items.push(await withTaskSyncSource(db, row, row.id));
  return { ...page, items };
}
