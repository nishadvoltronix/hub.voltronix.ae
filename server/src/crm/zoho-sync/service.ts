import { z } from "zod";
import type { SyncedQuotation, SyncedQuotationsPage, ZohoDirectoryPage, ZohoDirectoryUser, ZohoSyncStatus } from "@voltronix/crm-contracts";
import type { MysqlDatabase } from "../db/mysql/database.js";
import { createAuthService } from "../auth/service.js";
import { normalizeZohoInboundQuote } from "../../integrations/zoho/inbound-sync-contracts.js";

export class ZohoSyncReadError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 503) {
    super(({400: "Invalid synchronization request.", 401: "Sign in required.", 403: "Access denied.",
      404: "Record not found.", 503: "Synchronized records are temporarily unavailable."})[status]);
  }
}
const identifier = z.string().regex(/^[1-9][0-9]{0,18}$/);
const inputSchema = z.object({ taskId: identifier.optional(), query: z.string().trim().max(120).default(""),
  page: z.number().int().min(1).max(1_000_000).default(1), pageSize: z.number().int().min(1).max(20).default(10) }).strict();
const directoryInput = z.object({ query: z.string().trim().max(120).refine(value => !value.includes("\0")).default(""),
  page: z.number().int().min(1).max(1_000_000).default(1), pageSize: z.number().int().min(1).max(100).default(25) }).strict();
const directoryText = (field: "name" | "email" | "status") => `CASE WHEN JSON_TYPE(JSON_EXTRACT(directory.source_json,'$.${field}')) COLLATE utf8mb4_0900_bin='STRING'
  THEN JSON_UNQUOTE(JSON_EXTRACT(directory.source_json,'$.${field}')) COLLATE utf8mb4_0900_bin ELSE NULL END`;
const directoryRow = z.object({ externalId: z.string().regex(/^[1-9][0-9]{0,29}$/), name: z.string().max(200).nullable(),
  email: z.string().max(254).nullable(), status: z.string().max(100).nullable(), sourceState: z.enum(["active", "conflict", "deleted"]),
  sourceModifiedAt: z.string().max(32), lastSyncedAt: z.string().max(32), boundId: identifier.nullable(), boundEmail: z.string().max(254).nullable(),
  localId: identifier.nullable(), localName: z.string().max(120).nullable(), localEmail: z.string().max(254).nullable(),
  localStatus: z.enum(["active", "inactive"]).nullable(), localExternalId: z.string().max(100).nullable() });
type Row = { id: string; taskId: string | null; dealName: string | null; accountName: string | null; snapshot: string;
  observedAt: string; deleted: number; state: string };

/** Source-only quotations have their own read model. Never calculate history or
 * manufacture a local issuing company, tax rate, currency or PDF. */
export function createZohoSyncReads(db: MysqlDatabase) {
  const auth = createAuthService(db);
  async function listDirectory(token: string | null | undefined, input: unknown = {}): Promise<ZohoDirectoryPage> {
    try {
      return await db.transaction(async () => {
        const actor = await auth.authenticate(token); if (!actor) throw new ZohoSyncReadError(401);
        if (!["users.write", "permissions.manage"].every(key => actor.permissions.includes(key))) throw new ZohoSyncReadError(403);
        const parsed = directoryInput.safeParse(input); if (!parsed.success) throw new ZohoSyncReadError(400);
        const value = parsed.data, search = `%${value.query.replace(/[!%_]/g, "!$&")}%`;
        // Only the pinned source organization and exact verified identity join.
        // Same names/emails never manufacture a binding or a login account.
        const from = `FROM crm_zoho_sync_records directory JOIN crm_zoho_sync_source source ON source.id=1 AND source.organization_id=directory.organization_id
          LEFT JOIN crm_zoho_user_bindings binding ON binding.organization_id=directory.organization_id AND binding.module_api_name='VZ_app_users' AND binding.external_user_id=directory.external_id
          LEFT JOIN users linked ON linked.id=binding.local_user_id WHERE directory.module_api_name='VZ_app_users'
          AND CONCAT(COALESCE((${directoryText("name")}),''),' ',COALESCE((${directoryText("email")}),''),' ',directory.external_id) COLLATE utf8mb4_0900_as_ci LIKE ? ESCAPE '!'`;
        const total = (await db.prepare(`SELECT COUNT(*) n ${from}`).get(search) as { n: number }).n;
        if (!Number.isSafeInteger(total) || total < 0) throw new ZohoSyncReadError(503);
        const rows = await db.prepare(`SELECT directory.external_id externalId,(${directoryText("name")}) name,(${directoryText("email")}) email,
          (${directoryText("status")}) status,directory.state sourceState,directory.source_modified_at sourceModifiedAt,directory.last_synced_at lastSyncedAt,
          CAST(binding.local_user_id AS CHAR) boundId,binding.record_email boundEmail,CAST(linked.id AS CHAR) localId,linked.username localName,
          linked.email localEmail,linked.status localStatus,linked.user_id localExternalId ${from}
          ORDER BY name COLLATE utf8mb4_0900_as_ci,directory.external_id LIMIT ? OFFSET ?`)
          .all(search, value.pageSize, (value.page - 1) * value.pageSize);
        const items: ZohoDirectoryUser[] = rows.map(raw => {
          const row = directoryRow.parse(raw);
          const linkedUser = row.localId && row.localName !== null && row.localEmail !== null && row.localStatus
            ? { id: row.localId, name: row.localName, email: row.localEmail, status: row.localStatus } : null;
          const linked = row.boundId !== null && linkedUser?.status === "active" && row.localExternalId === row.externalId
            && row.sourceState === "active" && row.status === "active" && row.email !== null && row.boundEmail !== null
            && row.email.toLowerCase() === row.boundEmail.toLowerCase() && row.email.toLowerCase() === linkedUser.email.toLowerCase();
          return { externalId: row.externalId, name: row.name, email: row.email, status: row.status, sourceState: row.sourceState,
            sourceModifiedAt: row.sourceModifiedAt, lastSyncedAt: row.lastSyncedAt, linkedUser,
            linkState: row.boundId === null ? "unlinked" : linked ? "linked" : "review-required" };
        });
        return { items, total, page: value.page, pageSize: value.pageSize };
      })();
    } catch (error) { if (error instanceof ZohoSyncReadError) throw error; throw new ZohoSyncReadError(503); }
  }
  async function status(token: string | null | undefined): Promise<ZohoSyncStatus> {
    try {
      return await db.transaction(async () => {
        const actor = await auth.authenticate(token); if (!actor) throw new ZohoSyncReadError(401);
        if (!actor.permissions.some(key => ["leads.view", "leads.manage", "leads.manage.agents"].includes(key))) throw new ZohoSyncReadError(403);
        const row = await db.prepare("SELECT last_state state,last_attempt_at lastAttemptAt,last_success_at lastSuccessAt,lease_expires_at leaseExpiresAt FROM crm_zoho_sync_source WHERE id=1")
          .get() as (ZohoSyncStatus & { leaseExpiresAt: string | null }) | undefined;
        if (!row) return { state: "idle" as const, lastAttemptAt: null, lastSuccessAt: null };
        const state = row.state === "running" && (!row.leaseExpiresAt || Date.parse(row.leaseExpiresAt) <= Date.now()) ? "failed" : row.state;
        return { state, lastAttemptAt: row.lastAttemptAt, lastSuccessAt: row.lastSuccessAt };
      })();
    } catch (error) { if (error instanceof ZohoSyncReadError) throw error; throw new ZohoSyncReadError(503); }
  }
  async function listQuotations(token: string | null | undefined, input: unknown = {}): Promise<SyncedQuotationsPage> {
    try {
      return await db.transaction(async () => {
        const actor = await auth.authenticate(token);
        if (!actor) throw new ZohoSyncReadError(401);
        if (!actor.permissions.some(key => ["leads.view", "leads.manage", "leads.manage.agents"].includes(key))) throw new ZohoSyncReadError(403);
        const parsed = inputSchema.safeParse(input); if (!parsed.success) throw new ZohoSyncReadError(400);
        const value = parsed.data, own = actor.permissions.includes("leads.manage.agents");
        const filters = [own ? "t.assigned_to=?" : "1=1"], params: (string | number)[] = own ? [actor.externalUserId ?? ""] : [];
        if (value.taskId) {
          const task = await db.prepare("SELECT assigned_to FROM tasks WHERE id=?").get(value.taskId) as { assigned_to: string | null } | undefined;
          if (!task || own && (!actor.externalUserId || task.assigned_to !== actor.externalUserId)) throw new ZohoSyncReadError(404);
          filters.push("t.id=?"); params.push(value.taskId);
        }
        if (value.query) { filters.push("CONCAT(COALESCE(q.quote_number,''),' ',COALESCE(q.subject,''),' ',COALESCE(t.deal_name,'')) COLLATE utf8mb4_0900_as_ci LIKE ? ESCAPE '!'"); params.push(`%${value.query.replace(/[!%_]/g, "!$&")}%`); }
        // Unlinked source quotes are visible only to existing broad quotation
        // readers. The agent branch still requires a real, owned task.
        const from = `FROM crm_zoho_inbound_quotations q LEFT JOIN tasks t ON t.id=q.task_id
          JOIN crm_zoho_sync_records r ON r.organization_id=q.organization_id AND r.module_api_name='Quotes' AND r.external_id=q.external_id WHERE ${filters.join(" AND ")}`;
        const total = (await db.prepare(`SELECT COUNT(*) n ${from}`).get(...params) as { n: number }).n;
        if (!Number.isSafeInteger(total) || total < 0) throw new ZohoSyncReadError(503);
        const rows = await db.prepare(`SELECT CAST(q.id AS CHAR) id,CAST(t.id AS CHAR) taskId,t.deal_name dealName,t.account_name accountName,
          q.snapshot_json snapshot,q.observed_at observedAt,q.deleted,r.state ${from} ORDER BY q.source_modified_at DESC,q.id DESC LIMIT ? OFFSET ?`)
          .all(...params, value.pageSize, (value.page - 1) * value.pageSize) as Row[];
        const items: SyncedQuotation[] = rows.map(row => {
          const stored = JSON.parse(row.snapshot) as { source: unknown };
          const quote = normalizeZohoInboundQuote(stored.source);
          if (JSON.stringify(quote) !== JSON.stringify(stored)) throw new ZohoSyncReadError(503);
          const sourceAccount = quote.source.Account_Name;
          const accountName = sourceAccount && typeof sourceAccount === "object" && !Array.isArray(sourceAccount)
            && typeof sourceAccount.name === "string" && sourceAccount.name.length <= 2000 ? sourceAccount.name : null;
          const currency = typeof quote.source.Currency === "string" && quote.source.Currency.length <= 20 ? quote.source.Currency : null;
          return { id: row.id, taskId: row.taskId, dealName: row.dealName, accountName, currency,
            quoteNumber: quote.quoteNumber, subject: quote.subject, createdAt: quote.createdAt, modifiedAt: quote.modifiedAt,
            lastSyncedAt: row.observedAt, deleted: !!row.deleted, conflict: row.state === "conflict", totals: quote.totals, header: quote.header,
            lines: quote.lines.map(({ product, ...line }) => ({ ...line, productName: product?.name ?? null })) };
        });
        if (Buffer.byteLength(JSON.stringify(items)) > 8 * 1024 * 1024) throw new ZohoSyncReadError(503);
        return { items, total, page: value.page, pageSize: value.pageSize };
      })();
    } catch (error) { if (error instanceof ZohoSyncReadError) throw error; throw new ZohoSyncReadError(503); }
  }
  return { listQuotations, status, listDirectory };
}
