import { z } from "zod";
import { inboundSourceDecimal, inboundDecimal, inboundSourceName } from "./inbound-values.js";
import { zohoInboundProductSchema, zohoInboundDealSchema, zohoInboundNoteSchema, assertZohoInboundMissingValues } from "./inbound-snapshot.js";

export const ZOHO_INBOUND_PROFILE = "voltronix-inbound-v1" as const;
const id = z.string().regex(/^[1-9][0-9]{0,29}$/);
const timestamp = z.iso.datetime({ offset: true }).max(32).refine(value => Number.isFinite(Date.parse(value)));
const text = (max: number) => z.string().max(max).refine(value => !value.includes("\0"));
const lookup = z.object({ externalId: id, name: text(200) }).strict();
const sourceLookup = z.object({ id, name: text(200) });
const optionalText = (max: number) => text(max).nullable().optional();
const totals = z.object({ subtotal: inboundDecimal.nullable(), discount: inboundDecimal.nullable(), tax: inboundDecimal.nullable(),
  adjustment: inboundDecimal.nullable(), grandTotal: inboundDecimal.nullable() }).strict();
const header = z.object({ project: text(2000).nullable(), termsOfPayment: text(10_000).nullable(), specification: text(100_000).nullable(),
  generalExclusion: text(100_000).nullable(), brand: text(2000).nullable(), warranty: text(10_000).nullable(), delivery: text(10_000).nullable(),
  validTill: z.iso.date().nullable(), description: text(100_000).nullable() }).strict();
const line = z.object({ externalId: id, product: lookup.nullable(), description: text(100_000).nullable(), uom: text(100).nullable(),
  quantity: inboundDecimal.nullable(), unitPrice: inboundDecimal.nullable(), itemDiscount: inboundDecimal.nullable(), netTotal: inboundDecimal.nullable() }).strict();
const quoteSourceFields = ["Deal_Name", "Contact_Name", "Quote_No", "Project", "Terms_of_Payment", "Specification", "General_Exclusion", "Brand", "Warranty", "Delivery", "Valid_Till", "Description", "Sub_Total", "Discount", "Tax", "Adjustment", "Grand_Total", "Quoted_Items"] as const;
const missing = (allowed: readonly string[]) => z.array(z.string()).max(allowed.length).refine(values => new Set(values).size === values.length && values.every(value => allowed.includes(value)));
const sourceJson = z.record(z.string(), z.json()).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024);
const quote = z.object({ externalId: id, dealId: id.nullable(), contact: lookup.nullable(), quoteNumber: text(200).nullable(),
  subject: inboundSourceName(2000), createdAt: timestamp, modifiedAt: timestamp, header, totals, lines: z.array(line).max(200),
  missingOptionalFields: missing(quoteSourceFields), source: sourceJson }).strict();
const appUser = z.object({ externalId: id, name: inboundSourceName(200), email: text(254).nullable(), status: text(100).nullable(),
  createdAt: timestamp, modifiedAt: timestamp, missingOptionalFields: missing(["Email", "user_status"]) }).strict();
const tombstone = z.object({ module: z.enum(["Products", "Deals", "Quotes", "VZ_app_users"]), externalId: id,
  deletedAt: timestamp, type: z.enum(["recycle", "permanent", "all"]) }).strict();
export type ZohoInboundHistoricalQuote = z.infer<typeof quote>;
export type ZohoInboundAppUser = z.infer<typeof appUser>;
export type ZohoInboundTombstone = z.infer<typeof tombstone>;

export const zohoInboundLimitsSchema = z.object({ pageSize: z.number().int().min(1).max(200), maxPages: z.number().int().min(1).max(500),
  maxProducts: z.number().int().min(1).max(100_000), maxDeals: z.number().int().min(1).max(100_000), maxNotes: z.number().int().min(1).max(100_000),
  maxQuotes: z.number().int().min(1).max(20_000), maxAppUsers: z.number().int().min(1).max(20_000), maxTombstones: z.number().int().min(1).max(100_000),
  maxRequests: z.number().int().min(11).max(25_000), maxBytes: z.number().int().min(1024).max(128 * 1024 * 1024) }).strict();
export type ZohoInboundSyncLimits = z.infer<typeof zohoInboundLimitsSchema>;
export const DEFAULT_ZOHO_INBOUND_LIMITS: Readonly<ZohoInboundSyncLimits> = Object.freeze({ pageSize: 200, maxPages: 100,
  maxProducts: 20_000, maxDeals: 20_000, maxNotes: 20_000, maxQuotes: 5000, maxAppUsers: 2000, maxTombstones: 20_000,
  maxRequests: 6500, maxBytes: 64 * 1024 * 1024 });
export const zohoInboundReadInputSchema = z.object({ organizationId: id, startedAt: timestamp, since: timestamp.optional(), limits: zohoInboundLimitsSchema }).strict()
  .refine(value => value.since === undefined || Date.parse(value.since) <= Date.parse(value.startedAt));
export type ZohoInboundChangesInput = z.infer<typeof zohoInboundReadInputSchema>;
const changeSet = z.object({ schemaVersion: z.literal(1), profile: z.literal(ZOHO_INBOUND_PROFILE), organizationId: id,
  startedAt: timestamp, since: timestamp.nullable(), nextWatermark: timestamp, complete: z.literal(true), snapshotConsistent: z.literal(false),
  products: z.array(zohoInboundProductSchema).max(100_000), deals: z.array(zohoInboundDealSchema).max(100_000), notes: z.array(zohoInboundNoteSchema).max(100_000),
  quotes: z.array(quote).max(20_000), appUsers: z.array(appUser).max(20_000), tombstones: z.array(tombstone).max(100_000),
  requestsPerformed: z.number().int().min(11).max(25_000), excludedOtherModuleNotes: z.number().int().min(0).max(100_000),
  coverage: z.object({ notesDeletions: z.literal(false), quoteFinancials: z.literal("source-only"), deletionRetentionDays: z.literal(60) }).strict() }).strict();
export type ZohoInboundChangeSet = z.infer<typeof changeSet>;
export type ZohoInboundSyncFailure = "INPUT_INVALID" | "REQUEST_FAILED" | "ACCESS_DENIED" | "RATE_LIMITED" | "RESPONSE_INVALID" | "PAGINATION_INVALID"
  | "LIMIT_EXCEEDED" | "ORGANIZATION_MISMATCH" | "ABORTED" | "CURSOR_TOO_OLD" | "INCOMPLETE_QUOTE";
export class ZohoInboundSyncError extends Error {
  constructor(readonly code: ZohoInboundSyncFailure) { super(`Zoho inbound synchronization ${code}.`); this.name = "ZohoInboundSyncError"; }
}
const refuse = (): never => { throw new ZohoInboundSyncError("RESPONSE_INVALID"); };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const link = (value: z.infer<typeof sourceLookup> | null | undefined) => value == null ? null : { externalId: value.id, name: value.name };
const sourceLine = z.object({ id, Product_Name: sourceLookup.nullable().optional(), Description: optionalText(100_000), U_O_M: optionalText(100),
  Quantity: inboundSourceDecimal.nullable().optional(), List_Price: inboundSourceDecimal.nullable().optional(),
  ItemDiscount: inboundSourceDecimal.nullable().optional(), Net_Total: inboundSourceDecimal.nullable().optional() });
const sourceQuote = z.object({ id, Subject: inboundSourceName(2000), Created_Time: timestamp, Modified_Time: timestamp,
  Deal_Name: sourceLookup.nullable().optional(), Contact_Name: sourceLookup.nullable().optional(), Quote_No: optionalText(200),
  Project: optionalText(2000), Terms_of_Payment: optionalText(10_000), Specification: optionalText(100_000), General_Exclusion: optionalText(100_000),
  Brand: optionalText(2000), Warranty: optionalText(10_000), Delivery: optionalText(10_000), Valid_Till: z.iso.date().nullable().optional(), Description: optionalText(100_000),
  Sub_Total: inboundSourceDecimal.nullable().optional(), Discount: inboundSourceDecimal.nullable().optional(), Tax: inboundSourceDecimal.nullable().optional(),
  Adjustment: inboundSourceDecimal.nullable().optional(), Grand_Total: inboundSourceDecimal.nullable().optional(), Quoted_Items: z.array(sourceLine).max(200).nullable().optional(),
  $has_more: z.record(z.string(), z.boolean()).optional() });
export function normalizeZohoInboundQuote(value: unknown): ZohoInboundHistoricalQuote {
  const parsed = sourceQuote.safeParse(value); if (!parsed.success || !object(value)) return refuse();
  const row = parsed.data;
  if (row.$has_more?.Quoted_Items === true || row.Quoted_Items?.length === 200 && row.$has_more?.Quoted_Items !== false) throw new ZohoInboundSyncError("INCOMPLETE_QUOTE");
  const source = sourceJson.safeParse(value); if (!source.success) return refuse();
  return quote.parse({ externalId: row.id, dealId: row.Deal_Name?.id ?? null, contact: link(row.Contact_Name), quoteNumber: row.Quote_No ?? null,
    subject: row.Subject, createdAt: row.Created_Time, modifiedAt: row.Modified_Time,
    header: { project: row.Project ?? null, termsOfPayment: row.Terms_of_Payment ?? null, specification: row.Specification ?? null,
      generalExclusion: row.General_Exclusion ?? null, brand: row.Brand ?? null, warranty: row.Warranty ?? null, delivery: row.Delivery ?? null,
      validTill: row.Valid_Till ?? null, description: row.Description ?? null },
    totals: { subtotal: row.Sub_Total ?? null, discount: row.Discount ?? null, tax: row.Tax ?? null, adjustment: row.Adjustment ?? null, grandTotal: row.Grand_Total ?? null },
    lines: (row.Quoted_Items ?? []).map(item => ({ externalId: item.id, product: link(item.Product_Name), description: item.Description ?? null,
      uom: item.U_O_M ?? null, quantity: item.Quantity ?? null, unitPrice: item.List_Price ?? null, itemDiscount: item.ItemDiscount ?? null, netTotal: item.Net_Total ?? null })),
    missingOptionalFields: quoteSourceFields.filter(field => !Object.hasOwn(value, field)), source: source.data });
}
export function normalizeZohoInboundAppUser(value: unknown): ZohoInboundAppUser {
  const parsed = z.object({ id, Name: inboundSourceName(200), Email: optionalText(254), user_status: optionalText(100),
    Created_Time: timestamp, Modified_Time: timestamp }).safeParse(value);
  if (!parsed.success || !object(value)) return refuse(); const row = parsed.data;
  return { externalId: row.id, name: row.Name, email: row.Email ?? null, status: row.user_status ?? null, createdAt: row.Created_Time, modifiedAt: row.Modified_Time,
    missingOptionalFields: ["Email", "user_status"].filter(field => !Object.hasOwn(value, field)) };
}
export function normalizeZohoInboundTombstone(module: ZohoInboundTombstone["module"], value: unknown): ZohoInboundTombstone {
  const parsed = z.object({ id, deleted_time: timestamp, type: z.enum(["recycle", "permanent", "all"]) }).safeParse(value);
  if (!parsed.success) return refuse(); return { module, externalId: parsed.data.id, deletedAt: parsed.data.deleted_time, type: parsed.data.type };
}
export function parseZohoInboundChangeSet(value: unknown): ZohoInboundChangeSet {
  try {
    const parsed = changeSet.safeParse(value); if (!parsed.success) return refuse(); const result = parsed.data;
    if (result.nextWatermark !== result.startedAt || result.since !== null && Date.parse(result.since) > Date.parse(result.startedAt)
      || Buffer.byteLength(JSON.stringify(result)) > 128 * 1024 * 1024) return refuse();
    for (const list of [result.products, result.deals, result.notes, result.quotes, result.appUsers]) {
      if (new Set(list.map(item => item.externalId)).size !== list.length) return refuse();
    }
    for (const [module, rows] of [["Products", result.products], ["Deals", result.deals], ["Notes", result.notes]] as const) {
      for (const row of rows) assertZohoInboundMissingValues(module, row);
    }
    for (const row of result.appUsers) {
      if (row.missingOptionalFields.includes("Email") && row.email !== null || row.missingOptionalFields.includes("user_status") && row.status !== null) return refuse();
    }
    if (new Set(result.tombstones.map(item => `${item.module}:${item.externalId}`)).size !== result.tombstones.length) return refuse();
    for (const item of result.quotes) {
      if (new Set(item.lines.map(row => row.externalId)).size !== item.lines.length
        || JSON.stringify(normalizeZohoInboundQuote(item.source)) !== JSON.stringify(item)) return refuse();
    }
    return result;
  } catch { return refuse(); }
}
