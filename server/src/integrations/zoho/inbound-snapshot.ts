import { z } from "zod";
import { ZohoClientError } from "./client.js";
import { inboundDecimal as decimal, inboundSourceDecimal as sourceDecimal, inboundSourceName as sourceName } from "./inbound-values.js";
import type { VerifiedZohoRequestPort } from "./transports.js";

export interface ZohoInboundLookup { externalId: string; name: string }
interface SourceTimes { createdAt: string; modifiedAt: string; missingOptionalFields: string[] }
export interface ZohoInboundProduct extends SourceTimes { externalId: string; name: string; description: string | null; unitPrice: string | null }
export interface ZohoInboundDeal extends SourceTimes {
  externalId: string; name: string; stage: string; applicationStatus: string | null; amount: string | null;
  account: ZohoInboundLookup | null; contact: ZohoInboundLookup | null; owner: ZohoInboundLookup | null;
  assignedTo: ZohoInboundLookup | null; createdBy: ZohoInboundLookup | null;
  dealNumber: string | null; enquiryNumber: string | null; qualificationNumber: string | null; siteNumber: string | null;
  quotationNumber: string | null; jobNumber: string | null; lostNumber: string | null;
  qualificationDate: string | null; siteDate: string | null; quotationDate: string | null; jobDate: string | null; lostDate: string | null;
  email: string | null; phone: string | null; mobile: string | null; address: string | null; description: string | null;
  department: string | null; poBox: string | null; trn: string | null;
}
export interface ZohoInboundNote extends SourceTimes {
  externalId: string; dealId: string; title: string | null; content: string | null; createdBy: ZohoInboundLookup | null;
}
export const ZOHO_INBOUND_EXCLUDED_SCOPES = ["Quotes", "Attachments", "Users", "Accounts", "Contacts", "Deleted records", "History"] as const;
export interface ZohoInboundSnapshot {
  organizationId: string; capturedAt: string; products: ZohoInboundProduct[]; deals: ZohoInboundDeal[]; notes: ZohoInboundNote[];
  complete: true; snapshotConsistent: false; deletionsVerified: false; richTextCompletenessVerified: false;
  excludedScopes: readonly typeof ZOHO_INBOUND_EXCLUDED_SCOPES[number][]; requestsPerformed: number;
  excludedNoteCounts: { otherModules: number; unavailableDeals: number };
}
export interface ZohoInboundReadLimits { pageSize: number; maxPages: number; maxProducts: number; maxDeals: number; maxNotes: number; maxRequests: number }
export interface ZohoInboundReadInput { organizationId: string; capturedAt: string; limits: ZohoInboundReadLimits }
export type ZohoInboundReadFailure = "INPUT_INVALID" | "REQUEST_FAILED" | "ACCESS_DENIED" | "RATE_LIMITED" | "RESPONSE_INVALID"
  | "PAGINATION_INVALID" | "DUPLICATE_RECORD" | "PARENT_MISMATCH" | "LIMIT_EXCEEDED" | "SNAPSHOT_INVALID";
export interface ZohoInboundDiagnostic {
  module: "Products" | "Deals" | "Notes"; field: string;
  issue: "invalid_type" | "invalid_format" | "too_big" | "too_small" | "invalid_value" | "invalid_union" | "custom" | "envelope" | "pagination"
    | "blank_text" | "unsupported_control" | "decimal_empty" | "decimal_noncanonical" | "decimal_exponent_unrepresentable";
}
export class ZohoInboundReadError extends Error {
  readonly diagnostic?: ZohoInboundDiagnostic;
  constructor(readonly code: ZohoInboundReadFailure, diagnostic?: ZohoInboundDiagnostic) {
    super(`Zoho inbound snapshot ${code}. No complete import snapshot is available.`); this.name = "ZohoInboundReadError";
    const safe = safeZohoInboundDiagnostic(diagnostic); if (safe) this.diagnostic = Object.freeze(safe);
  }
}
const fail = (code: ZohoInboundReadFailure): never => { throw new ZohoInboundReadError(code); };
const id = z.string().regex(/^[1-9][0-9]{0,29}$/);
const timestamp = z.iso.datetime({ offset: true }).max(32).refine(value => Number.isFinite(Date.parse(value)));
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const stageDate = z.union([timestamp, calendarDate]);
const text = (maximum: number) => z.string().max(maximum).refine(value => !value.includes("\0"));
const label = (maximum: number) => text(maximum).min(1).refine(value => value.trim().length > 0
  && Array.from(value).every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127));
const lookup = z.object({ id, name: text(200) });
const optionalText = (maximum: number) => text(maximum).nullable().optional();
const optionalLookup = lookup.nullable().optional();
const times = { Created_Time: timestamp, Modified_Time: timestamp };
const productSchema = z.object({ id, Product_Name: sourceName(2000), Description: optionalText(100_000), Unit_Price: sourceDecimal.nullable().optional(), ...times });
const dealSchema = z.object({ id, Deal_Name: sourceName(200), Stage: label(100), VZ_App_Status: optionalText(100), Amount: sourceDecimal.nullable().optional(), ...times,
  Account_Name: optionalLookup, Contact_Name: optionalLookup, Owner: optionalLookup, VZ_app_user: optionalLookup, Created_By: optionalLookup,
  DealNumber: optionalText(200), EnquiryNumber: optionalText(200), QualDealNumber: optionalText(200), SiteDealNumber: optionalText(200),
  QuoteDealNumber: optionalText(200), JobDealNumber: optionalText(200), LostDealNumber: optionalText(200),
  Qualified_Time: stageDate.nullable().optional(), Site_Deal_Date: stageDate.nullable().optional(), Quote_Date: stageDate.nullable().optional(),
  Job_Date: stageDate.nullable().optional(), Lost_Time: stageDate.nullable().optional(), Email: optionalText(254), Phone: optionalText(100), Mobile: optionalText(100),
  Address: optionalText(2000), Description: optionalText(100_000), Assign_Department1: optionalText(200), P_BOX: optionalText(200), TRN: optionalText(200) });
const noteSchema = z.object({ id, Note_Title: optionalText(200), Note_Content: optionalText(100_000), ...times,
  Parent_Id: z.object({ id, module: z.object({ api_name: z.literal("Deals") }) }), Created_By: optionalLookup });
const configSchema = z.object({ organizationId: id, capturedAt: timestamp, limits: z.object({
  pageSize: z.number().int().min(1).max(200), maxPages: z.number().int().min(1).max(100), maxProducts: z.number().int().min(1).max(20_000),
  maxDeals: z.number().int().min(1).max(20_000), maxNotes: z.number().int().min(1).max(20_000), maxRequests: z.number().int().min(3).max(2500),
}).strict() }).strict();
const fields = {
  Products: Object.keys(productSchema.shape).filter(key => key !== "id"),
  Deals: Object.keys(dealSchema.shape).filter(key => key !== "id"),
  Notes: Object.keys(noteSchema.shape).filter(key => key !== "id"),
} as const;
type Module = keyof typeof fields;
/** Only static projection/schema categories may leave the private reader.
 * Never return Zod messages, received values, row indices or arbitrary keys. */
export function safeZohoInboundDiagnostic(value: unknown): ZohoInboundDiagnostic | undefined {
  try {
    const parsed = z.object({ module: z.enum(["Products", "Deals", "Notes"]), field: z.string(),
      issue: z.enum(["invalid_type", "invalid_format", "too_big", "too_small", "invalid_value", "invalid_union", "custom", "envelope", "pagination",
        "blank_text", "unsupported_control", "decimal_empty", "decimal_noncanonical", "decimal_exponent_unrepresentable"]) }).strict().safeParse(value);
    if (!parsed.success || !["id", "$record", "$response", "$pagination", ...fields[parsed.data.module]].includes(parsed.data.field)) return undefined;
    return parsed.data;
  } catch { return undefined; }
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function hybridError(value: Record<string, unknown>): boolean {
  return ["code", "error", "errors", "status", "message"].some(key => value[key] !== undefined);
}
function number(value: unknown, maximum: number): number | undefined {
  if (typeof value === "string" && /^(?:0|[1-9][0-9]{0,5})$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
}
function missing(raw: Record<string, unknown>, module: Module): string[] { return fields[module].filter(field => !Object.hasOwn(raw, field) || raw[field] === undefined); }
function link(value: z.infer<typeof lookup> | null | undefined): ZohoInboundLookup | null {
  return value == null ? null : { externalId: value.id, name: value.name };
}
function validate<T>(schema: z.ZodType<T>, value: unknown, module?: Module): T {
  const parsed = schema.safeParse(value); if (parsed.success) return parsed.data;
  if (!module) return fail("RESPONSE_INVALID");
  const issue = parsed.error.issues[0], candidate = issue?.path[0];
  const field = typeof candidate === "string" && ["id", ...fields[module]].includes(candidate) ? candidate : "$record";
  let category: string | undefined = issue?.code;
  if (category === "custom" && ["Product_Name", "Deal_Name", "Stage"].includes(field) && object(value) && typeof value[field] === "string") {
    category = (value[field] as string).trim().length === 0 ? "blank_text" : "unsupported_control";
  }
  if (category === "invalid_format" && ["Amount", "Unit_Price"].includes(field) && object(value) && typeof value[field] === "string") {
    const raw = value[field] as string;
    category = raw.trim().length === 0 ? "decimal_empty"
      : /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?[eE][+-]?[0-9]+$/.test(raw) ? "decimal_exponent_unrepresentable" : "decimal_noncanonical";
  }
  const diagnostic = safeZohoInboundDiagnostic({ module, field, issue: category });
  throw new ZohoInboundReadError("RESPONSE_INVALID", diagnostic ?? { module, field, issue: "envelope" });
}
function readProduct(raw: Record<string, unknown>): ZohoInboundProduct {
  const row = validate(productSchema, raw, "Products");
  return { externalId: row.id, name: row.Product_Name, description: row.Description ?? null, unitPrice: row.Unit_Price ?? null,
    createdAt: row.Created_Time, modifiedAt: row.Modified_Time, missingOptionalFields: missing(raw, "Products") };
}
function readDeal(raw: Record<string, unknown>): ZohoInboundDeal {
  const row = validate(dealSchema, raw, "Deals");
  return { externalId: row.id, name: row.Deal_Name, stage: row.Stage, applicationStatus: row.VZ_App_Status ?? null, amount: row.Amount ?? null,
    createdAt: row.Created_Time, modifiedAt: row.Modified_Time, missingOptionalFields: missing(raw, "Deals"),
    account: link(row.Account_Name), contact: link(row.Contact_Name), owner: link(row.Owner), assignedTo: link(row.VZ_app_user), createdBy: link(row.Created_By),
    dealNumber: row.DealNumber ?? null, enquiryNumber: row.EnquiryNumber ?? null, qualificationNumber: row.QualDealNumber ?? null,
    siteNumber: row.SiteDealNumber ?? null, quotationNumber: row.QuoteDealNumber ?? null, jobNumber: row.JobDealNumber ?? null, lostNumber: row.LostDealNumber ?? null,
    qualificationDate: row.Qualified_Time ?? null, siteDate: row.Site_Deal_Date ?? null, quotationDate: row.Quote_Date ?? null,
    jobDate: row.Job_Date ?? null, lostDate: row.Lost_Time ?? null, email: row.Email ?? null, phone: row.Phone ?? null, mobile: row.Mobile ?? null,
    address: row.Address ?? null, description: row.Description ?? null, department: row.Assign_Department1 ?? null, poBox: row.P_BOX ?? null, trn: row.TRN ?? null };
}
function readNote(raw: Record<string, unknown>, parent: string): ZohoInboundNote {
  const row = validate(noteSchema, raw, "Notes");
  if (row.Parent_Id.id !== parent) return fail("PARENT_MISMATCH");
  return { externalId: row.id, dealId: row.Parent_Id.id, title: row.Note_Title ?? null, content: row.Note_Content ?? null,
    createdBy: link(row.Created_By), createdAt: row.Created_Time, modifiedAt: row.Modified_Time, missingOptionalFields: missing(raw, "Notes") };
}

const dtoLookup = z.object({ externalId: id, name: text(200) }).strict().nullable();
const dtoTimes = { createdAt: timestamp, modifiedAt: timestamp };
const missingFields = (module: Module) => z.array(z.string()).max(fields[module].length).refine(values => new Set(values).size === values.length
  && values.every(value => fields[module].includes(value) && !["Created_Time", "Modified_Time", "Product_Name", "Deal_Name", "Stage", "Parent_Id"].includes(value)));
const dtoProduct = z.object({ externalId: id, name: sourceName(2000), description: text(100_000).nullable(), unitPrice: decimal.nullable(),
  ...dtoTimes, missingOptionalFields: missingFields("Products") }).strict();
const dtoDeal = z.object({ externalId: id, name: sourceName(200), stage: label(100), applicationStatus: text(100).nullable(), amount: decimal.nullable(),
  ...dtoTimes, missingOptionalFields: missingFields("Deals"), account: dtoLookup, contact: dtoLookup, owner: dtoLookup, assignedTo: dtoLookup, createdBy: dtoLookup,
  dealNumber: text(200).nullable(), enquiryNumber: text(200).nullable(), qualificationNumber: text(200).nullable(), siteNumber: text(200).nullable(),
  quotationNumber: text(200).nullable(), jobNumber: text(200).nullable(), lostNumber: text(200).nullable(),
  qualificationDate: stageDate.nullable(), siteDate: stageDate.nullable(), quotationDate: stageDate.nullable(), jobDate: stageDate.nullable(), lostDate: stageDate.nullable(),
  email: text(254).nullable(), phone: text(100).nullable(), mobile: text(100).nullable(), address: text(2000).nullable(), description: text(100_000).nullable(),
  department: text(200).nullable(), poBox: text(200).nullable(), trn: text(200).nullable() }).strict();
const dtoNote = z.object({ externalId: id, dealId: id, title: text(200).nullable(), content: text(100_000).nullable(), createdBy: dtoLookup,
  ...dtoTimes, missingOptionalFields: missingFields("Notes") }).strict();
const dtoSnapshot = z.object({ organizationId: id, capturedAt: timestamp, products: z.array(dtoProduct).max(20_000), deals: z.array(dtoDeal).max(20_000),
  notes: z.array(dtoNote).max(20_000), complete: z.literal(true), snapshotConsistent: z.literal(false), deletionsVerified: z.literal(false),
  richTextCompletenessVerified: z.literal(false), excludedScopes: z.array(z.enum(ZOHO_INBOUND_EXCLUDED_SCOPES)).length(ZOHO_INBOUND_EXCLUDED_SCOPES.length)
    .refine(values => new Set(values).size === values.length), requestsPerformed: z.number().int().min(3).max(2500),
  excludedNoteCounts: z.object({ otherModules: z.number().int().min(0).max(20_000), unavailableDeals: z.number().int().min(0).max(20_000) }).strict() }).strict();
const sourceToDto = {
  Products: { Description: "description", Unit_Price: "unitPrice" },
  Deals: { VZ_App_Status: "applicationStatus", Amount: "amount", Account_Name: "account", Contact_Name: "contact", Owner: "owner",
    VZ_app_user: "assignedTo", Created_By: "createdBy", DealNumber: "dealNumber", EnquiryNumber: "enquiryNumber", QualDealNumber: "qualificationNumber",
    SiteDealNumber: "siteNumber", QuoteDealNumber: "quotationNumber", JobDealNumber: "jobNumber", LostDealNumber: "lostNumber",
    Qualified_Time: "qualificationDate", Site_Deal_Date: "siteDate", Quote_Date: "quotationDate", Job_Date: "jobDate", Lost_Time: "lostDate",
    Email: "email", Phone: "phone", Mobile: "mobile", Address: "address", Description: "description", Assign_Department1: "department", P_BOX: "poBox", TRN: "trn" },
  Notes: { Note_Title: "title", Note_Content: "content", Created_By: "createdBy" },
} as const;

/** Shared source/DTO validation for the production change reader. A change set
 * may contain a Note whose unchanged Deal is already present in the store. */
export const zohoInboundProductSchema = dtoProduct;
export const zohoInboundDealSchema = dtoDeal;
export const zohoInboundNoteSchema = dtoNote;
export const zohoInboundProjection = fields;
export function assertZohoInboundMissingValues(module: Module, row: { missingOptionalFields: readonly string[] }): void {
  const mapping = sourceToDto[module] as Record<string, string>;
  for (const field of row.missingOptionalFields) if ((row as unknown as Record<string, unknown>)[mapping[field]!] !== null) fail("SNAPSHOT_INVALID");
}
export function normalizeZohoInboundRecord(module: "Products", value: unknown): ZohoInboundProduct;
export function normalizeZohoInboundRecord(module: "Deals", value: unknown): ZohoInboundDeal;
export function normalizeZohoInboundRecord(module: "Notes", value: unknown): ZohoInboundNote;
export function normalizeZohoInboundRecord(module: Module, value: unknown): ZohoInboundProduct | ZohoInboundDeal | ZohoInboundNote {
  if (!object(value) || hybridError(value)) return fail("RESPONSE_INVALID");
  if (module === "Products") return readProduct(value);
  if (module === "Deals") return readDeal(value);
  const parsed = validate(noteSchema, value, "Notes");
  return readNote(value, parsed.Parent_Id.id);
}

/** Strict staged-JSON validation only. This cannot authenticate the producer,
 * establish org ownership or authorize a DB import; callers and the store must
 * separately verify those boundaries. No timestamps/statuses are synthesized. */
export function parseZohoInboundSnapshot(value: unknown): ZohoInboundSnapshot {
  try {
    const parsed = dtoSnapshot.safeParse(value); if (!parsed.success) return fail("SNAPSHOT_INVALID");
    const snapshot = parsed.data, dealIds = new Set(snapshot.deals.map(row => row.externalId));
    if (snapshot.notes.length + snapshot.excludedNoteCounts.otherModules + snapshot.excludedNoteCounts.unavailableDeals > 20_000
      || snapshot.notes.some(row => !dealIds.has(row.dealId))) return fail("SNAPSHOT_INVALID");
    for (const [module, rows] of [["Products", snapshot.products], ["Deals", snapshot.deals], ["Notes", snapshot.notes]] as const) {
      if (new Set(rows.map(row => row.externalId)).size !== rows.length) return fail("SNAPSHOT_INVALID");
      const mapping = sourceToDto[module] as Record<string, string>;
      for (const row of rows) for (const field of row.missingOptionalFields) {
        if ((row as unknown as Record<string, unknown>)[mapping[field]!] !== null) return fail("SNAPSHOT_INVALID");
      }
    }
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > 20 * 1024 * 1024) return fail("SNAPSHOT_INVALID");
    return snapshot;
  } catch { return fail("SNAPSHOT_INVALID"); }
}

/** Fixed, bounded GET-only source projection. The injected client must bind the
 * caller-pinned organization and own credentials, response byte limits and per-
 * request deadlines. organizationId is a caller assertion, not a proof made here.
 *
 * Active PHP webhook mappings: ZohoWebhook.php:199-238,1220-1247. In particular
 * assigned_to comes from VZ_app_user, not Owner or the operator performing this
 * read. True Created_Time/Modified_Time are mandatory; never use import time.
 * Optional absent fields are reported individually; null is not called observed.
 *
 * All selected pages must finish before a result is returned. This is not a
 * transactionally consistent backup and excludes quotes/files/local history.
 * Up to ten discrete pages, then bounded provider page tokens encoded only as
 * query values at the SAME fixed collection endpoint. At most 100 pages and
 * 20,000 source rows/module; no arbitrary URL following, truncation, implicit
 * retry, fallback identity, writes, DB or environment access. Notes collection
 * requires an admin token; non-Deals/unavailable-parent notes are counted only.
 * https://www.zoho.com/crm/developer/docs/api/v8/get-records.html
 * https://www.zoho.com/crm/developer/docs/api/v8/get-notes.html */
export async function readZohoInboundSnapshot(port: VerifiedZohoRequestPort, input: ZohoInboundReadInput): Promise<ZohoInboundSnapshot> {
  let parsed: z.infer<typeof configSchema>;
  try { const result = configSchema.safeParse(input); if (!result.success || !port || typeof port.request !== "function") return fail("INPUT_INVALID"); parsed = result.data; }
  catch { return fail("INPUT_INVALID"); }
  const { limits } = parsed;
  const products: ZohoInboundProduct[] = [], deals: ZohoInboundDeal[] = [], notes: ZohoInboundNote[] = [];
  const seen = { Products: new Set<string>(), Deals: new Set<string>(), Notes: new Set<string>() };
  const excludedNoteCounts = { otherModules: 0, unavailableDeals: 0 };
  let requestsPerformed = 0, retainedBytes = 0;
  async function read(module: Module): Promise<void> {
    let previousId: bigint | undefined;
    let pageToken: string | undefined, rowsSeen = 0;
    const usedTokens = new Set<string>();
    const target = module === "Products" ? products : module === "Deals" ? deals : notes;
    const maximum = module === "Products" ? limits.maxProducts : module === "Deals" ? limits.maxDeals : limits.maxNotes;
    for (let page = 1; page <= limits.maxPages; page++) {
      if (requestsPerformed >= limits.maxRequests) return fail("LIMIT_EXCEEDED");
      const query = new URLSearchParams({ fields: fields[module].join(","), per_page: String(limits.pageSize) });
      if (pageToken === undefined) query.set("page", String(page));
      else {
        if (usedTokens.has(pageToken)) return fail("PAGINATION_INVALID");
        usedTokens.add(pageToken); query.set("page_token", pageToken);
      }
      if (module !== "Notes") { query.set("sort_by", "id"); query.set("sort_order", "asc"); }
      const path = `/${module}`;
      let reply: { status: number; body: unknown };
      try { requestsPerformed++; reply = await port.request({ apiVersion: "v8", method: "GET", path: `${path}?${query}` }); }
      catch (error) {
        if (error instanceof ZohoClientError && [401, 403].includes(error.httpStatus ?? 0)) return fail("ACCESS_DENIED");
        if (error instanceof ZohoClientError && error.httpStatus === 429) return fail("RATE_LIMITED");
        return fail("REQUEST_FAILED");
      }
      try {
        if (!object(reply) || !Number.isInteger(reply.status)) return fail("RESPONSE_INVALID");
        if ([401, 403].includes(reply.status)) return fail("ACCESS_DENIED");
        if (reply.status === 429) return fail("RATE_LIMITED");
        if (reply.status === 204) {
          if (reply.body !== undefined && reply.body !== null) return fail("RESPONSE_INVALID");
          if (page !== 1) return fail("PAGINATION_INVALID");
          return;
        }
        if (reply.status !== 200) return fail("REQUEST_FAILED");
        const body = reply.body;
        if (!object(body) || hybridError(body) || !Array.isArray(body.data)
          || body.data.length > limits.pageSize || !object(body.info)) return fail("RESPONSE_INVALID");
        const info = body.info;
        const tokenPage = number(info.page, 100);
        const validPage = pageToken === undefined ? number(info.page, 100) === page
          : info.page === undefined || info.page === null || (tokenPage !== undefined && tokenPage > 0);
        if (!validPage || number(info.per_page, 200) !== limits.pageSize || number(info.count, 200) !== body.data.length
          || hybridError(info) || typeof info.more_records !== "boolean" || (!body.data.length && (info.more_records || page > 1))) return fail("PAGINATION_INVALID");
        if (module !== "Notes" && (info.sort_by !== "id" || info.sort_order !== "asc")) return fail("PAGINATION_INVALID");
        const nextToken = info.next_page_token;
        if (nextToken !== undefined && nextToken !== null && (!info.more_records || typeof nextToken !== "string"
          || !/^[\x21-\x7e]{1,4096}$/.test(nextToken))) return fail("PAGINATION_INVALID");
        if (rowsSeen + body.data.length > maximum) return fail("LIMIT_EXCEEDED");
        rowsSeen += body.data.length;
        for (const raw of body.data) {
          if (!object(raw) || hybridError(raw)) return fail("RESPONSE_INVALID");
          const identifier = validate(id, raw.id);
          if (seen[module].has(identifier)) return fail("DUPLICATE_RECORD");
          seen[module].add(identifier);
          if (module === "Notes") {
            const parent = validate(z.object({ id, module: z.object({ api_name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/) }) }), raw.Parent_Id);
            if (parent.module.api_name !== "Deals") { excludedNoteCounts.otherModules++; continue; }
            if (!seen.Deals.has(parent.id)) { excludedNoteCounts.unavailableDeals++; continue; }
          }
          const record = module === "Products" ? readProduct(raw) : module === "Deals" ? readDeal(raw)
            : readNote(raw, (raw.Parent_Id as { id: string }).id);
          if (module !== "Notes") {
            const currentId = BigInt(record.externalId);
            if (previousId !== undefined && currentId <= previousId) return fail("PAGINATION_INVALID"); previousId = currentId;
          }
          retainedBytes += Buffer.byteLength(JSON.stringify(record), "utf8");
          if (retainedBytes > 20 * 1024 * 1024) return fail("LIMIT_EXCEEDED");
          (target as (ZohoInboundProduct | ZohoInboundDeal | ZohoInboundNote)[]).push(record);
        }
        if (!info.more_records) return;
        if (page === limits.maxPages || rowsSeen >= maximum) return fail("LIMIT_EXCEEDED");
        if (page >= 10) {
          if (typeof nextToken !== "string" || usedTokens.has(nextToken)) return fail("PAGINATION_INVALID");
          pageToken = nextToken;
        }
      } catch (error) {
        if (error instanceof ZohoInboundReadError && error.diagnostic) throw error;
        const code = error instanceof ZohoInboundReadError ? error.code : "RESPONSE_INVALID";
        throw new ZohoInboundReadError(code, { module, field: code === "PAGINATION_INVALID" ? "$pagination" : "$response",
          issue: code === "PAGINATION_INVALID" ? "pagination" : "envelope" });
      }
    }
    return fail("LIMIT_EXCEEDED");
  }
  await read("Products"); await read("Deals"); await read("Notes");
  return parseZohoInboundSnapshot({ organizationId: parsed.organizationId, capturedAt: parsed.capturedAt, products, deals, notes,
    complete: true, snapshotConsistent: false, deletionsVerified: false, richTextCompletenessVerified: false,
    excludedScopes: [...ZOHO_INBOUND_EXCLUDED_SCOPES], requestsPerformed, excludedNoteCounts });
}
