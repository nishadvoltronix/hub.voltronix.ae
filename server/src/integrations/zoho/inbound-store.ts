import { randomUUID } from "node:crypto";
import type { MysqlDatabase } from "../../crm/db/mysql/database.js";
import { parseZohoInboundChangeSet, ZOHO_INBOUND_PROFILE } from "./inbound-sync-contracts.js";
import { applyZohoInboundChanges } from "./inbound-apply.js";

export type ZohoInboundModule = "Products" | "Deals" | "Notes" | "Quotes" | "VZ_app_users";
export type ZohoInboundStoreCode = "INPUT_INVALID" | "ACCESS_DENIED" | "SOURCE_MISMATCH" | "LEASE_LOST" | "DATABASE" | "ABORTED"
  | "REQUEST_FAILED" | "RATE_LIMITED" | "RESPONSE_INVALID" | "PAGINATION_INVALID" | "LIMIT_EXCEEDED" | "ORGANIZATION_MISMATCH" | "CURSOR_TOO_OLD" | "INCOMPLETE_QUOTE";
export class ZohoInboundStoreError extends Error {
  constructor(readonly code: ZohoInboundStoreCode) { super(`Zoho inbound synchronization unavailable (${code}). No remote write or automatic repair was attempted.`); }
}
export interface ZohoInboundCounts { read: number; applied: number; skipped: number; conflicts: number; deleted: number }
export interface ZohoInboundLease {
  readonly runId: string; readonly organizationId: string; readonly principalId: string; readonly generation: number;
  readonly startedAt: string; readonly watermark: string | null; readonly since: string | null; readonly leaseMs: number;
}
interface SourceRow {
  organization_id: string; profile: string; generation: number; watermark: string | null;
  last_attempt_at: string | null; last_success_at: string | null; last_state: "idle" | "running" | "partial" | "ready" | "failed";
  last_counts_json: string | null; last_error: string | null; lease_id: string | null; lease_principal_id: string | null;
  lease_started_at: string | null; lease_expires_at: string | null;
}
export interface ZohoInboundStatus {
  state: "idle" | "running" | "partial" | "ready" | "failed"; lastAttemptAt: string | null; lastSuccessAt: string | null;
  generation: number; checkpointAvailable: boolean; counts: ZohoInboundCounts | null; errorCode: ZohoInboundStoreCode | null;
  leaseActive: boolean; leaseExpiresAt: string | null;
}
const codes: readonly string[] = ["INPUT_INVALID","ACCESS_DENIED","SOURCE_MISMATCH","LEASE_LOST","DATABASE","ABORTED","REQUEST_FAILED",
  "RATE_LIMITED","RESPONSE_INVALID","PAGINATION_INVALID","LIMIT_EXCEEDED","ORGANIZATION_MISMATCH","CURSOR_TOO_OLD","INCOMPLETE_QUOTE"];
export function safeZohoInboundCode(error: unknown): ZohoInboundStoreCode {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && codes.includes(code) ? code as ZohoInboundStoreCode : "DATABASE";
}
export function emptyZohoInboundCounts(): ZohoInboundCounts { return { read: 0, applied: 0, skipped: 0, conflicts: 0, deleted: 0 }; }
const validId = (value: string) => /^[1-9][0-9]{0,29}$/.test(value);
const instant = (now: () => number) => { const value = now(); if (!Number.isSafeInteger(value) || value < 0) throw new ZohoInboundStoreError("INPUT_INVALID"); return new Date(value).toISOString(); };
async function safe<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { throw error instanceof ZohoInboundStoreError ? error : new ZohoInboundStoreError(safeZohoInboundCode(error)); }
}
async function source(db: MysqlDatabase): Promise<SourceRow | undefined> {
  return await db.prepare("SELECT organization_id,profile,generation,watermark,last_attempt_at,last_success_at,last_state,last_counts_json,last_error,lease_id,CAST(lease_principal_id AS CHAR) lease_principal_id,lease_started_at,lease_expires_at FROM crm_zoho_sync_source WHERE id=1").get() as SourceRow | undefined;
}
export async function assertZohoInboundPrincipal(db: MysqlDatabase, principalId: string): Promise<void> {
  if (!validId(principalId)) throw new ZohoInboundStoreError("INPUT_INVALID");
  const user = await db.prepare("SELECT status FROM users WHERE id=?").get(principalId) as { status: string } | undefined;
  const grants = await db.prepare("SELECT p.`key` permissionKey FROM permissions p JOIN admin_user_permissions a ON a.permission_id=p.id WHERE a.admin_user_id=? AND p.`key` IN ('users.write','permissions.manage')").all(principalId) as { permissionKey: string }[];
  if (user?.status !== "active" || !["users.write","permissions.manage"].every(key => grants.some(grant => grant.permissionKey === key))) throw new ZohoInboundStoreError("ACCESS_DENIED");
}
function pinned(row: SourceRow | undefined, organizationId: string) {
  if (row && (row.organization_id !== organizationId || row.profile !== ZOHO_INBOUND_PROFILE)) throw new ZohoInboundStoreError("SOURCE_MISMATCH");
}
function current(row: SourceRow | undefined, lease: ZohoInboundLease, now: string) {
  pinned(row, lease.organizationId);
  if (!row || row.lease_id !== lease.runId || row.lease_principal_id !== lease.principalId || row.generation !== lease.generation
    || row.lease_started_at !== lease.startedAt || !row.lease_expires_at || Date.parse(row.lease_expires_at) <= Date.parse(now)) throw new ZohoInboundStoreError("LEASE_LOST");
}
export async function readZohoInboundStatus(db: MysqlDatabase, organizationId: string, principalId: string, now = Date.now): Promise<ZohoInboundStatus> {
  return safe(async () => {
    if (!validId(organizationId)) throw new ZohoInboundStoreError("INPUT_INVALID");
    await assertZohoInboundPrincipal(db, principalId); const row = await source(db); pinned(row, organizationId);
    const active = !!row?.lease_id && !!row.lease_expires_at && Date.parse(row.lease_expires_at) > now();
    return { state: active ? "running" : row?.last_state === "running" ? "failed" : row?.last_state ?? "idle",
      lastAttemptAt: row?.last_attempt_at ?? null, lastSuccessAt: row?.last_success_at ?? null, generation: row?.generation ?? 0,
      checkpointAvailable: !!row?.watermark, counts: row?.last_counts_json ? JSON.parse(row.last_counts_json) as ZohoInboundCounts : null,
      errorCode: row?.last_state === "running" && !active ? "LEASE_LOST" : row?.last_error ? safeZohoInboundCode({ code: row.last_error }) : null,
      leaseActive: active, leaseExpiresAt: active ? row!.lease_expires_at : null };
  });
}
export function createZohoInboundStore(db: MysqlDatabase, options: { organizationId: string; now?: () => number }) {
  const now = options.now ?? Date.now, organizationId = options.organizationId;
  if (!validId(organizationId)) throw new ZohoInboundStoreError("INPUT_INVALID");
  const release = (lease: ZohoInboundLease, state: string, counts: ZohoInboundCounts, code: string | null) => db.prepare(
    "UPDATE crm_zoho_sync_source SET last_state=?,last_counts_json=?,last_error=?,lease_id=NULL,lease_principal_id=NULL,lease_started_at=NULL,lease_expires_at=NULL WHERE id=1 AND lease_id=?")
    .run(state, JSON.stringify(counts), code, lease.runId);
  return {
    status: (principalId: string) => readZohoInboundStatus(db, organizationId, principalId, now),
    async acquire(principalId: string, input: { leaseMs?: number } = {}): Promise<ZohoInboundLease | null> {
      const leaseMs = input.leaseMs ?? 120_000;
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 60_000 || leaseMs > 600_000) throw new ZohoInboundStoreError("INPUT_INVALID");
      return safe(() => db.transaction(async () => {
        await assertZohoInboundPrincipal(db, principalId); const at = instant(now); let row = await source(db); pinned(row, organizationId);
        if (row?.lease_id && row.lease_expires_at && Date.parse(row.lease_expires_at) > now()) return null;
        if (!row) {
          const organizations = await db.prepare("SELECT organization_id FROM crm_zoho_user_bindings UNION SELECT organization_id FROM crm_zoho_quotations").all() as { organization_id: string }[];
          if (organizations.some(value => value.organization_id !== organizationId)) throw new ZohoInboundStoreError("SOURCE_MISMATCH");
          await db.prepare("INSERT INTO crm_zoho_sync_source(id,organization_id,profile,generation,last_state) VALUES(1,?,?,0,'idle')").run(organizationId, ZOHO_INBOUND_PROFILE);
          row = await source(db);
        }
        if (!row) throw new ZohoInboundStoreError("DATABASE");
        if (row.lease_id && row.lease_principal_id && row.lease_started_at) {
          await db.prepare("INSERT INTO crm_zoho_sync_runs(run_id,organization_id,principal_id,profile,state,started_at,completed_at,generation_before,generation_after,watermark,counts_json,error_code) VALUES(?,?,?,?,'failed',?,?,?,?,?,?,?)")
            .run(row.lease_id,organizationId,row.lease_principal_id,ZOHO_INBOUND_PROFILE,row.lease_started_at,at,row.generation,row.generation,row.watermark,JSON.stringify(emptyZohoInboundCounts()),"LEASE_LOST");
        }
        const lease: ZohoInboundLease = Object.freeze({ runId: randomUUID(), organizationId, principalId, generation: row.generation, startedAt: at,
          watermark: row.watermark, since: row.watermark ? new Date(Date.parse(row.watermark) - 300_000).toISOString() : null, leaseMs });
        await db.prepare("UPDATE crm_zoho_sync_source SET last_attempt_at=?,last_state='running',last_error=NULL,lease_id=?,lease_principal_id=?,lease_started_at=?,lease_expires_at=? WHERE id=1")
          .run(at,lease.runId,principalId,at,new Date(now()+leaseMs).toISOString());
        return lease;
      })());
    },
    async renew(lease: ZohoInboundLease): Promise<void> {
      await safe(() => db.transaction(async () => {
        await assertZohoInboundPrincipal(db, lease.principalId); current(await source(db),lease,instant(now));
        await db.prepare("UPDATE crm_zoho_sync_source SET lease_expires_at=? WHERE id=1 AND lease_id=?").run(new Date(now()+lease.leaseMs).toISOString(),lease.runId);
      })());
    },
    async apply(lease: ZohoInboundLease, value: unknown, signal?: AbortSignal) {
      const changes = parseZohoInboundChangeSet(value);
      if (changes.organizationId !== organizationId || changes.startedAt !== lease.startedAt || changes.since !== lease.since) throw new ZohoInboundStoreError("SOURCE_MISMATCH");
      return safe(() => db.transaction(async () => {
        await assertZohoInboundPrincipal(db, lease.principalId); const at=instant(now); current(await source(db),lease,at);
        if (signal?.aborted) throw new ZohoInboundStoreError("ABORTED");
        // The global application lock excludes another owner throughout apply.
        // Extend this atomic phase once; no concurrent heartbeat or provider I/O
        // runs inside the transaction, and the caller's deadline still applies.
        await db.prepare("UPDATE crm_zoho_sync_source SET lease_expires_at=? WHERE id=1 AND lease_id=?")
          .run(new Date(now()+300_000).toISOString(),lease.runId);
        const {counts,partial} = await applyZohoInboundChanges(db,lease,changes,at,signal);
        const state = partial ? "partial" : "ready";
        await db.prepare("UPDATE crm_zoho_sync_source SET generation=generation+1,watermark=?,last_success_at=? WHERE id=1 AND lease_id=?")
          .run(changes.nextWatermark,at,lease.runId);
        if(signal?.aborted)throw new ZohoInboundStoreError("ABORTED");
        current(await source(db),{...lease,generation:lease.generation+1},instant(now));
        await release(lease,state,counts,null);
        return { status: partial ? "partial" as const : "completed" as const, runId:lease.runId,generation:lease.generation+1,counts };
      })());
    },
    async fail(lease: ZohoInboundLease, error: unknown): Promise<void> {
      await safe(() => db.transaction(async () => {
        const row=await source(db); pinned(row,organizationId);
        if (!row || row.lease_id!==lease.runId || row.lease_principal_id!==lease.principalId) return;
        const at=instant(now),counts=emptyZohoInboundCounts(),code=safeZohoInboundCode(error);
        await db.prepare("INSERT INTO crm_zoho_sync_runs(run_id,organization_id,principal_id,profile,state,started_at,completed_at,generation_before,generation_after,watermark,counts_json,error_code) VALUES(?,?,?,?,'failed',?,?,?,?,?,?,?)")
          .run(lease.runId,organizationId,lease.principalId,ZOHO_INBOUND_PROFILE,lease.startedAt,at,lease.generation,lease.generation,lease.watermark,JSON.stringify(counts),code);
        await release(lease,"failed",counts,code);
      })());
    },
  };
}

export interface ZohoInboundProvenance {
  provider: "zoho"; readOnly: boolean; deleted: boolean; conflict: boolean; lastSyncedAt: string; sourceModifiedAt: string; externalId: string;
}
function provenance(row: { origin: string; state: string; last_synced_at: string; source_modified_at: string; external_id: string }): ZohoInboundProvenance {
  return { provider:"zoho",readOnly:row.origin!=="native"||row.state!=="active",deleted:row.state==="deleted",conflict:row.state==="conflict",
    lastSyncedAt:row.last_synced_at,sourceModifiedAt:row.source_modified_at,externalId:row.external_id };
}
export async function getZohoInboundProvenance(db: MysqlDatabase,input:{module:ZohoInboundModule;externalId?:string;localId?:string}) {
  if ((input.externalId===undefined)===(input.localId===undefined)) throw new ZohoInboundStoreError("INPUT_INVALID");
  const row=await db.prepare(`SELECT origin,state,last_synced_at,source_modified_at,external_id FROM crm_zoho_sync_records WHERE module_api_name=? AND ${input.externalId!==undefined?"external_id":"local_id"}=?`)
    .get(input.module,input.externalId??input.localId!) as Parameters<typeof provenance>[0]|undefined;
  return row?provenance(row):undefined;
}
export async function getZohoInboundTaskSource(db:MysqlDatabase,taskId:string) {
  const rows=await db.prepare(`SELECT origin,state,last_synced_at,source_modified_at,external_id FROM (
    SELECT origin,state,last_synced_at,source_modified_at,external_id FROM crm_zoho_sync_records WHERE task_id=? AND (module_api_name='Deals' OR state IN ('deleted','conflict'))
    UNION ALL SELECT r.origin,r.state,r.last_synced_at,r.source_modified_at,r.external_id FROM crm_zoho_sync_records r
      JOIN crm_zoho_user_bindings b ON b.organization_id=r.organization_id AND b.external_user_id=r.external_id
      JOIN users u ON u.id=b.local_user_id AND u.user_id=b.external_user_id JOIN tasks t ON t.assigned_to=u.user_id
      WHERE t.id=? AND r.module_api_name='VZ_app_users' AND r.state IN ('deleted','conflict')
    ) observed ORDER BY CASE state WHEN 'deleted' THEN 0 WHEN 'conflict' THEN 1 ELSE 2 END,last_synced_at DESC`)
    .all(taskId,taskId) as Parameters<typeof provenance>[0][];
  return rows.length?provenance(rows[0]!):undefined;
}
