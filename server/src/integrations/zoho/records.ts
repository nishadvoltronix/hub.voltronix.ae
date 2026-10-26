import { z } from "zod";
import { ZohoClientError } from "./client.js";
import { inboundSourceDecimal as money, inboundSourceName as sourceName } from "./inbound-values.js";
import type { VerifiedZohoRequestPort } from "./transports.js";

const externalId = z.string().regex(/^[1-9][0-9]{0,29}$/);
const text = (maximum: number) => z.string().max(maximum).refine(value => !value.includes("\0"));
const label = (maximum: number) => text(maximum).min(1).refine(value => value.trim().length > 0
  && Array.from(value).every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127));
// The verified client retains JSON numeric lexemes as strings. Never convert
// money or IDs through Number(), round them, trim text or invent absent values.
const timestamp = z.iso.datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)));
const lookup = z.object({ id: externalId, name: text(200) });
const products = z.object({ id: externalId, Product_Name: sourceName(2000), Description: text(100_000).nullable(),
  Unit_Price: money.nullable(), Modified_Time: timestamp });
const deals = z.object({ id: externalId, Deal_Name: sourceName(200), Stage: label(100), Amount: money.nullable(),
  Account_Name: lookup.nullable(), Contact_Name: lookup.nullable(), Owner: lookup.nullable(), Modified_Time: timestamp });
const notes = z.object({ id: externalId, Note_Title: text(200).nullable(), Note_Content: text(100_000).nullable(),
  Parent_Id: z.object({ id: externalId, module: z.object({ api_name: z.literal("Deals") }) }), Modified_Time: timestamp });

export type ZohoRecordScope = { module: "Products" } | { module: "Deals" } | { module: "Notes"; dealId: string };
export interface ZohoReadLimits { pageSize: number; maxPages: number; maxRecords: number }
export interface ZohoProductRead { externalId: string; name: string; description: string | null; unitPrice: string | null; modifiedAt: string }
export interface ZohoLookupRead { externalId: string; name: string }
export interface ZohoDealRead { externalId: string; name: string; stage: string; amount: string | null;
  account: ZohoLookupRead | null; contact: ZohoLookupRead | null; owner: ZohoLookupRead | null; modifiedAt: string }
export interface ZohoNoteRead { externalId: string; dealId: string; title: string | null; content: string | null; modifiedAt: string }
interface ReadCompletion {
  pagesRead: number;
  /** Exhausted the selected accessible endpoint, not a tenant backup or a
   * consistent snapshot. Hidden/deleted records and rich-text completeness are
   * not established. Callers must not infer deletes or perform blind upserts. */
  complete: true;
  snapshotConsistent: false;
  deletionsVerified: false;
  richTextCompletenessVerified: false;
}
export type ZohoRecordRead = ReadCompletion & (
  { module: "Products"; records: ZohoProductRead[] } | { module: "Deals"; records: ZohoDealRead[] }
  | { module: "Notes"; dealId: string; records: ZohoNoteRead[] });
export type ZohoRecordReadFailure = "INPUT_INVALID" | "REQUEST_FAILED" | "ACCESS_DENIED" | "RATE_LIMITED"
  | "RESPONSE_INVALID" | "PAGINATION_INVALID" | "DUPLICATE_RECORD" | "LIMIT_EXCEEDED" | "PARENT_MISMATCH";
export class ZohoRecordReadError extends Error {
  constructor(readonly code: ZohoRecordReadFailure) {
    super(`Zoho record read ${code}. No complete result is available.`); this.name = "ZohoRecordReadError";
  }
}
const scopeSchema = z.discriminatedUnion("module", [z.object({ module: z.literal("Products") }).strict(),
  z.object({ module: z.literal("Deals") }).strict(), z.object({ module: z.literal("Notes"), dealId: externalId }).strict()]);
const limitsSchema = z.object({ pageSize: z.number().int().min(1).max(200), maxPages: z.number().int().min(1).max(10),
  maxRecords: z.number().int().min(1).max(2000) }).strict().refine(value => value.pageSize <= value.maxRecords);
const fields = {
  Products: "Product_Name,Description,Unit_Price,Modified_Time",
  Deals: "Deal_Name,Stage,Amount,Account_Name,Contact_Name,Owner,Modified_Time",
  Notes: "Note_Title,Note_Content,Parent_Id,Modified_Time",
} as const;
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
const hasEnvelopeMarker = (value: Record<string, unknown>) => ["code", "error", "errors", "status", "message"].some(key => Object.hasOwn(value, key));
function integer(value: unknown, minimum: number, maximum: number): number | undefined {
  // Metadata is small enough to represent exactly. Accept the real client's
  // lossless strings and ordinary safe integers from other verified adapters.
  if (typeof value === "string" && /^(?:0|[1-9][0-9]{0,5})$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}
function failed(code: ZohoRecordReadFailure): never { throw new ZohoRecordReadError(code); }
function parseRecord(module: ZohoRecordScope["module"], value: unknown, parentId?: string): ZohoProductRead | ZohoDealRead | ZohoNoteRead {
  if (!object(value) || hasEnvelopeMarker(value)) return failed("RESPONSE_INVALID");
  if (module === "Products") {
    const parsed = products.safeParse(value); if (!parsed.success) return failed("RESPONSE_INVALID");
    const row = parsed.data;
    return { externalId: row.id, name: row.Product_Name, description: row.Description, unitPrice: row.Unit_Price, modifiedAt: row.Modified_Time };
  }
  if (module === "Deals") {
    const parsed = deals.safeParse(value); if (!parsed.success) return failed("RESPONSE_INVALID");
    const row = parsed.data, link = (value: z.infer<typeof lookup> | null): ZohoLookupRead | null => value === null ? null : { externalId: value.id, name: value.name };
    return { externalId: row.id, name: row.Deal_Name, stage: row.Stage, amount: row.Amount,
      account: link(row.Account_Name), contact: link(row.Contact_Name), owner: link(row.Owner), modifiedAt: row.Modified_Time };
  }
  const parsed = notes.safeParse(value); if (!parsed.success) return failed("RESPONSE_INVALID");
  const row = parsed.data; if (row.Parent_Id.id !== parentId) return failed("PARENT_MISMATCH");
  return { externalId: row.id, dealId: row.Parent_Id.id, title: row.Note_Title, content: row.Note_Content, modifiedAt: row.Modified_Time };
}

/** Explicit bounded inbound reads, never selected by env or invoked at import.
 * The caller supplies a client that owns org binding, auth, deadlines and bounded
 * lossless JSON decoding. No DB/files, mutation, request retry or sync scheduling.
 * All pages must validate before ANY record collection is returned.
 *
 * v8 discrete pagination supports at most 2000 records; this reader deliberately
 * uses at most ten pages and refuses truncation. It never follows provider URLs
 * or page tokens; adding token pagination requires a separately bounded design.
 * https://www.zoho.com/crm/developer/docs/api/v8/get-records.html
 * https://www.zoho.com/crm/developer/docs/api/v8/get-notes.html */
export async function readZohoRecords(port: VerifiedZohoRequestPort, input: ZohoRecordScope,
  inputLimits: ZohoReadLimits): Promise<ZohoRecordRead> {
  let selected: ZohoRecordScope, limits: ZohoReadLimits;
  try {
    selected = scopeSchema.parse(input); limits = limitsSchema.parse(inputLimits);
    if (!port || typeof port.request !== "function") return failed("INPUT_INVALID");
  } catch { return failed("INPUT_INVALID"); }
  try { return await collect(port, selected, limits); }
  catch (error) { throw error instanceof ZohoRecordReadError ? error : new ZohoRecordReadError("RESPONSE_INVALID"); }
}

async function collect(port: VerifiedZohoRequestPort, selected: ZohoRecordScope, limits: ZohoReadLimits): Promise<ZohoRecordRead> {
  const collected: (ZohoProductRead | ZohoDealRead | ZohoNoteRead)[] = [], seen = new Set<string>();
  let previousId: bigint | undefined;
  function finish(pagesRead: number): ZohoRecordRead {
    const completion: ReadCompletion = { pagesRead, complete: true, snapshotConsistent: false, deletionsVerified: false, richTextCompletenessVerified: false };
    // Records are added only through the selected module's validated parser.
    if (selected.module === "Products") return { ...completion, module: "Products", records: collected as ZohoProductRead[] };
    if (selected.module === "Deals") return { ...completion, module: "Deals", records: collected as ZohoDealRead[] };
    return { ...completion, module: "Notes", dealId: selected.dealId, records: collected as ZohoNoteRead[] };
  }
  for (let page = 1; page <= limits.maxPages; page++) {
    // Keep per_page fixed: changing it mid-run changes page offsets. Refuse a
    // next page whose requested capacity exceeds the remaining record budget,
    // even if a smaller final response might have fit. No over-budget fetch.
    if (collected.length + limits.pageSize > limits.maxRecords) return failed("LIMIT_EXCEEDED");
    const parent = selected.module === "Notes" ? selected.dealId : undefined;
    const path = selected.module === "Notes" ? `/Deals/${selected.dealId}/Notes` : `/${selected.module}`;
    const query = new URLSearchParams({ fields: fields[selected.module], page: String(page), per_page: String(limits.pageSize) });
    if (selected.module !== "Notes") { query.set("sort_by", "id"); query.set("sort_order", "asc"); }
    let reply: { status: number; body: unknown };
    try { reply = await port.request({ apiVersion: "v8", method: "GET", path: `${path}?${query}` }); }
    catch (error) {
      // The actual verified client throws on non-2xx. Preserve only its safe
      // category, not arbitrary exception text or a provider response body.
      const status = error instanceof ZohoClientError ? error.httpStatus : undefined;
      return failed(status === 401 || status === 403 ? "ACCESS_DENIED" : status === 429 ? "RATE_LIMITED" : "REQUEST_FAILED");
    }
    if (!object(reply) || !Number.isInteger(reply.status)) return failed("RESPONSE_INVALID");
    if (reply.status === 204) {
      // A subsequent empty page contradicts the preceding more_records=true;
      // it can indicate a changing set. Never call that a complete snapshot.
      if (reply.body !== undefined && reply.body !== null) return failed("RESPONSE_INVALID");
      if (page !== 1) return failed("PAGINATION_INVALID");
      return finish(page);
    }
    if ([401, 403].includes(reply.status)) return failed("ACCESS_DENIED");
    if (reply.status === 429) return failed("RATE_LIMITED");
    if (reply.status !== 200) return failed("REQUEST_FAILED");
    const body = reply.body;
    if (!object(body) || hasEnvelopeMarker(body) || !Array.isArray(body.data)
      || body.data.length > limits.pageSize || !object(body.info)) return failed("RESPONSE_INVALID");
    const info = body.info;
    if (integer(info.page, 1, 10) !== page || integer(info.per_page, 1, 200) !== limits.pageSize
      || integer(info.count, 0, limits.pageSize) !== body.data.length || typeof info.more_records !== "boolean"
      || (info.more_records && body.data.length === 0) || (page > 1 && body.data.length === 0)) return failed("PAGINATION_INVALID");
    if (selected.module !== "Notes" && (info.sort_by !== "id" || info.sort_order !== "asc")) return failed("PAGINATION_INVALID");
    // Tokens/URLs are never consumed. Their presence cannot override the fixed
    // page strategy, and a token on a final page contradicts completion.
    if (info.next_page_token !== undefined && info.next_page_token !== null
      && (typeof info.next_page_token !== "string" || info.next_page_token.length === 0 || info.next_page_token.length > 4096 || !info.more_records)) return failed("PAGINATION_INVALID");
    if (collected.length + body.data.length > limits.maxRecords) return failed("LIMIT_EXCEEDED");
    for (const raw of body.data) {
      const record = parseRecord(selected.module, raw, parent);
      if (seen.has(record.externalId)) return failed("DUPLICATE_RECORD");
      if (selected.module !== "Notes") {
        const currentId = BigInt(record.externalId);
        if (previousId !== undefined && currentId <= previousId) return failed("PAGINATION_INVALID");
        previousId = currentId;
      }
      seen.add(record.externalId); collected.push(record);
    }
    if (!info.more_records) return finish(page);
    if (page === limits.maxPages || collected.length >= limits.maxRecords) return failed("LIMIT_EXCEEDED");
  }
  return failed("LIMIT_EXCEEDED");
}
