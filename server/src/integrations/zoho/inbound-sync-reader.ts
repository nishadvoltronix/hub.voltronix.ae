import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { ZohoClientError } from "./client.js";
import type { VerifiedZohoRequestPort } from "./transports.js";
import { normalizeZohoInboundRecord, zohoInboundProjection } from "./inbound-snapshot.js";
import { ZOHO_INBOUND_PROFILE, ZohoInboundSyncError, normalizeZohoInboundAppUser, normalizeZohoInboundQuote,
  normalizeZohoInboundTombstone, parseZohoInboundChangeSet, zohoInboundReadInputSchema,
  type ZohoInboundChangesInput, type ZohoInboundChangeSet, type ZohoInboundSyncFailure, type ZohoInboundTombstone } from "./inbound-sync-contracts.js";

const id = z.string().regex(/^[1-9][0-9]{0,29}$/);
const timestamp = z.iso.datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)));
const modules = ["Products", "Deals", "Notes", "Quotes", "VZ_app_users"] as const;
type Module = typeof modules[number];
const fields: Record<Module, readonly string[]> = { ...zohoInboundProjection, Quotes: ["Modified_Time"],
  VZ_app_users: ["Name", "Email", "user_status", "Created_Time", "Modified_Time"] };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const hybrid = (value: Record<string, unknown>) => ["code", "error", "errors", "status", "message"].some(key => Object.hasOwn(value, key));
function integer(value: unknown): number | undefined {
  if (typeof value === "string" && /^(?:0|[1-9][0-9]{0,6})$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
const fail = (code: ZohoInboundSyncFailure): never => { throw new ZohoInboundSyncError(code); };

/** GET-only, bounded all-or-error pass. A pass is not a consistent snapshot:
 * the coordinator overlaps successful start-time watermarks and applies source
 * timestamps/hashes transactionally. No list absence implies a deletion.
 * https://www.zoho.com/crm/developer/docs/api/v8/get-records.html
 * https://www.zoho.com/crm/developer/docs/api/v8/get-deleted-records.html */
export async function readZohoInboundChanges(port: VerifiedZohoRequestPort, input: ZohoInboundChangesInput,
  signal?: AbortSignal): Promise<ZohoInboundChangeSet> {
  const config = zohoInboundReadInputSchema.safeParse(input);
  if (!config.success || !port || typeof port.request !== "function" || signal !== undefined && !(signal instanceof AbortSignal)) return fail("INPUT_INVALID");
  const { organizationId, startedAt, since, limits } = config.data;
  // Zoho accepts second precision with an explicit offset. Milliseconds + Z
  // were observed to be silently ignored. Rounding down only widens overlap;
  // use that same bound for second-precision source rows while preserving the
  // original cursor in the change set and checkpoint identity.
  const wireSince = since === undefined ? undefined : new Date(since).toISOString().replace(/\.[0-9]{3}Z$/, "+00:00");
  const sourceLowerBound = wireSince === undefined ? undefined : Date.parse(wireSince);
  // The shortest documented deletion retention is sixty days. Do not silently
  // call a long-disconnected checkpoint a complete deletion feed.
  if (since !== undefined && Date.parse(startedAt) - Date.parse(since) > 59 * 86_400_000) return fail("CURSOR_TOO_OLD");
  let requestsPerformed = 0, retainedBytes = 0, excludedOtherModuleNotes = 0, tombstonesRead = 0;
  const result: Pick<ZohoInboundChangeSet, "products" | "deals" | "notes" | "quotes" | "appUsers" | "tombstones"> = {
    products: [], deals: [], notes: [], quotes: [], appUsers: [], tombstones: [] };
  const abort = () => { if (signal?.aborted) fail("ABORTED"); };
  // Providers may ignore a conditional header or return an entire changed
  // collection. Validate every returned row/page, retaining the overlapping
  // time window except for Notes, whose parent can change without a new time.
  const changed = (at: string) => sourceLowerBound === undefined || Date.parse(at) >= sourceLowerBound;
  function retain(value: unknown): void {
    retainedBytes += Buffer.byteLength(JSON.stringify(value)); if (retainedBytes > limits.maxBytes) fail("LIMIT_EXCEEDED");
  }
  async function request(path: string, conditional = false, continuing = () => true): Promise<{ status: number; body: unknown }> {
    for (let attempt = 0; ; attempt++) {
      abort(); if (!continuing()) return fail("REQUEST_FAILED");
      if (requestsPerformed >= limits.maxRequests) return fail("LIMIT_EXCEEDED"); requestsPerformed++;
      try {
      const reply = await port.request({ apiVersion: "v8", method: "GET", path,
        ...(conditional && wireSince !== undefined ? { ifModifiedSince: wireSince } : {}) });
      abort();
      if (!object(reply) || !Number.isInteger(reply.status)) return fail("RESPONSE_INVALID");
      if ([401, 403].includes(reply.status)) return fail("ACCESS_DENIED");
      if (reply.status === 429) return fail("RATE_LIMITED");
      if (reply.status >= 500 && reply.status <= 599) throw new ZohoClientError("HTTP_FAILED", reply.status);
      if (![200, 204, ...(conditional && since !== undefined ? [304] : [])].includes(reply.status)) return fail("REQUEST_FAILED");
      return reply;
      } catch (error) {
        abort(); if (error instanceof ZohoInboundSyncError) throw error;
        if (error instanceof ZohoClientError && [401, 403].includes(error.httpStatus ?? 0)) return fail("ACCESS_DENIED");
        if (error instanceof ZohoClientError && error.httpStatus === 429) return fail("RATE_LIMITED");
        const transient = error instanceof ZohoClientError && (["TIMEOUT", "UNAVAILABLE"].includes(error.code)
          || error.code === "HTTP_FAILED" && (error.httpStatus ?? 0) >= 500 && (error.httpStatus ?? 0) <= 599);
        if (!transient || attempt >= 2 || !continuing()) return fail("REQUEST_FAILED");
        if (requestsPerformed >= limits.maxRequests) return fail("LIMIT_EXCEEDED");
        try { await delay(attempt === 0 ? 500 : 1000, undefined, { ...(signal ? { signal } : {}) }); }
        catch { abort(); return fail("REQUEST_FAILED"); }
      }
    }
  }
  async function organization(): Promise<void> {
    const reply = await request("/org");
    const parsed = z.object({ org: z.tuple([z.object({ id, type: z.literal("production") })]) }).safeParse(reply.body);
    if (reply.status !== 200 || !parsed.success || !object(reply.body) || hybrid(reply.body) || parsed.data.org[0].id !== organizationId) fail("ORGANIZATION_MISMATCH");
  }
  async function quoteDetails(list: { externalId: string; modifiedAt: string }[]): Promise<void> {
    // Four exact-record GETs stay below even Zoho's lowest documented per-app
    // concurrency limit (five). Collection pagination remains sequential.
    // https://www.zoho.com/crm/developer/docs/api/v8/api-limits.html
    const rows: ZohoInboundChangeSet["quotes"] = []; let next = 0, failed = false, failure: unknown;
    async function worker(): Promise<void> {
      while (!failed) {
        const index = next++, listed = list[index]; if (!listed) return;
        try {
          const full = await request(`/Quotes/${listed.externalId}`, false, () => !failed);
          if (full.status !== 200 || !object(full.body) || hybrid(full.body) || !Array.isArray(full.body.data) || full.body.data.length !== 1) fail("RESPONSE_INVALID");
          const row = normalizeZohoInboundQuote((full.body as { data: unknown[] }).data[0]);
          if (row.externalId !== listed.externalId || Date.parse(row.modifiedAt) < Date.parse(listed.modifiedAt)) fail("RESPONSE_INVALID");
          retain(row); rows[index] = row;
        } catch (error) { if (!failed) { failed = true; failure = error; } }
      }
    }
    // Drain all started GETs even after one fails; no queued request starts
    // after a failure is observed and no partially completed page escapes.
    await Promise.all(Array.from({ length: Math.min(4, list.length) }, () => worker()));
    if (failed) throw failure;
    result.quotes.push(...rows);
  }
  async function collection(module: Module, maximum: number, deleted = false): Promise<void> {
    const seen = new Set<string>(), usedTokens = new Set<string>(); let pageToken: string | undefined, previousId: bigint | undefined, count = 0;
    for (let page = 1; page <= limits.maxPages; page++) {
      abort();
      const query = new URLSearchParams({ per_page: String(limits.pageSize) });
      if (deleted) query.set("type", "all"); else query.set("fields", fields[module].join(","));
      if (pageToken !== undefined) { if (usedTokens.has(pageToken)) return fail("PAGINATION_INVALID"); usedTokens.add(pageToken); query.set("page_token", pageToken); }
      else query.set("page", String(page));
      if (!deleted && module !== "Notes") { query.set("sort_by", "id"); query.set("sort_order", "asc"); }
      // Lead conversion can move an old Note to a Deal without changing the
      // Note's Modified_Time. Reconcile the bounded Notes collection on every
      // pass, including after the parent Deal has left the overlap window.
      const reply = await request(`/${module}${deleted ? "/deleted" : ""}?${query}`, module !== "Notes");
      if (reply.status === 204 || reply.status === 304) {
        if (reply.body !== undefined && reply.body !== null) return fail("RESPONSE_INVALID");
        if (page !== 1) return fail("PAGINATION_INVALID"); return;
      }
      const body = reply.body;
      if (!object(body) || hybrid(body) || !Array.isArray(body.data) || !object(body.info) || hybrid(body.info)) return fail("RESPONSE_INVALID");
      const info = body.info, reportedPage = integer(info.page);
      if (integer(info.per_page) !== limits.pageSize || integer(info.count) !== body.data.length || body.data.length > limits.pageSize
        || typeof info.more_records !== "boolean" || (!body.data.length && (info.more_records || page > 1))
        || (pageToken === undefined ? reportedPage !== page : info.page !== null && info.page !== undefined && (reportedPage === undefined || reportedPage < 1))) return fail("PAGINATION_INVALID");
      if (!deleted && module !== "Notes" && (info.sort_by !== "id" || info.sort_order !== "asc")) return fail("PAGINATION_INVALID");
      const nextToken = info.next_page_token;
      if (nextToken !== undefined && nextToken !== null && (!info.more_records || typeof nextToken !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(nextToken))) return fail("PAGINATION_INVALID");
      if (deleted && nextToken != null) return fail("PAGINATION_INVALID");
      count += body.data.length; if (count > maximum) return fail("LIMIT_EXCEEDED");
      if (deleted) tombstonesRead += body.data.length;
      const listedQuotes: { externalId: string; modifiedAt: string }[] = [];
      for (const raw of body.data) {
        if (!object(raw) || hybrid(raw)) return fail("RESPONSE_INVALID");
        const identifier = id.safeParse(raw.id); if (!identifier.success || seen.has(identifier.data)) return fail("RESPONSE_INVALID");
        seen.add(identifier.data);
        if (!deleted && module !== "Notes") {
          const current = BigInt(identifier.data); if (previousId !== undefined && current <= previousId) return fail("PAGINATION_INVALID"); previousId = current;
        }
        if (deleted) {
          const row = normalizeZohoInboundTombstone(module as ZohoInboundTombstone["module"], raw);
          if (changed(row.deletedAt)) { retain(row); result.tombstones.push(row); } continue;
        }
        if (module === "Notes") {
          const parent = z.object({ id, module: z.object({ api_name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/) }) }).safeParse(raw.Parent_Id);
          if (!parent.success) return fail("RESPONSE_INVALID");
          if (parent.data.module.api_name !== "Deals") { excludedOtherModuleNotes++; continue; }
          const row = normalizeZohoInboundRecord("Notes", raw); retain(row); result.notes.push(row);
        } else if (module === "Products") { const row = normalizeZohoInboundRecord(module, raw); if (changed(row.modifiedAt)) { retain(row); result.products.push(row); } }
        else if (module === "Deals") { const row = normalizeZohoInboundRecord(module, raw); if (changed(row.modifiedAt)) { retain(row); result.deals.push(row); } }
        else if (module === "VZ_app_users") { const row = normalizeZohoInboundAppUser(raw); if (changed(row.modifiedAt)) { retain(row); result.appUsers.push(row); } }
        else {
          const listed = timestamp.safeParse(raw.Modified_Time); if (!listed.success) return fail("RESPONSE_INVALID");
          if (changed(listed.data)) listedQuotes.push({ externalId: identifier.data, modifiedAt: listed.data });
        }
      }
      if (listedQuotes.length) await quoteDetails(listedQuotes);
      if (!info.more_records) return;
      if (page === limits.maxPages || count >= maximum) return fail("LIMIT_EXCEEDED");
      if (!deleted && typeof nextToken === "string") pageToken = nextToken;
      else if (pageToken !== undefined || !deleted && page * limits.pageSize >= 2000) return fail("PAGINATION_INVALID");
    }
    return fail("LIMIT_EXCEEDED");
  }
  try {
    await organization();
    const maximum = { Products: limits.maxProducts, Deals: limits.maxDeals, Notes: limits.maxNotes, Quotes: limits.maxQuotes, VZ_app_users: limits.maxAppUsers };
    for (const module of modules) await collection(module, maximum[module]);
    for (const module of ["Products", "Deals", "Quotes", "VZ_app_users"] as const) {
      await collection(module, limits.maxTombstones - tombstonesRead, true);
    }
    await organization(); abort();
    return parseZohoInboundChangeSet({ schemaVersion: 1, profile: ZOHO_INBOUND_PROFILE, organizationId, startedAt, since: since ?? null,
      nextWatermark: startedAt, complete: true, snapshotConsistent: false, ...result, requestsPerformed, excludedOtherModuleNotes,
      coverage: { notesDeletions: false, quoteFinancials: "source-only", deletionRetentionDays: 60 } });
  } catch (error) { abort(); throw error instanceof ZohoInboundSyncError ? error : new ZohoInboundSyncError("RESPONSE_INVALID"); }
}
