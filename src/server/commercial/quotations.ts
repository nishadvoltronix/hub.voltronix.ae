import { z } from "zod";
import { add, compare, decimal, exact, money, multiply, percent, subtract } from "./decimal";
import { CommercialError, externalIdSchema, multiLine, parseCommercial, singleLine } from "./validation";

const decimalString = z.string().regex(/^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$/);
const signedDecimalString = z.string().regex(/^-?(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$/);
const zero = decimal("0");
const itemSchema = z.object({
  productId: externalIdSchema, productName: singleLine(255).min(1), description: multiLine(10_000),
  uom: z.enum(["", "NOS", "PCS", "LS", "EA", "SET", "SQM"]),
  quantity: decimalString.refine((value) => compare(decimal(value), zero) > 0),
  unitPrice: decimalString,
  itemDiscount: decimalString.refine((value) => compare(decimal(value), decimal("100")) <= 0),
}).strict();
const optionalTerms = multiLine(10_000).nullable().default(null);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const quotationSchema = z.object({
  subject: singleLine(200).min(1), kindAttention: singleLine(200).min(1),
  project: optionalTerms, termsOfPayment: optionalTerms, specification: optionalTerms,
  generalExclusion: optionalTerms, brand: optionalTerms, warranty: optionalTerms,
  delivery: optionalTerms, notes: optionalTerms, validUntil: date.nullable().default(null),
  discount: decimalString, discountType: z.literal("percentage").optional(), adjustment: signedDecimalString,
  items: z.array(itemSchema).min(1).max(200),
}).strict();

export type QuotationInput = z.infer<typeof quotationSchema>;
export const PERCENTAGE_QUOTATION_POLICY = "percentage-only-v2" as const;
export type QuotationPolicy = "percentage-create-v1" | typeof PERCENTAGE_QUOTATION_POLICY;
function percentageInput(value: QuotationInput): QuotationInput {
  if (compare(decimal(value.discount), decimal("100")) > 0
    || (compare(decimal(value.discount), zero) !== 0 && value.discountType !== "percentage")) throw new CommercialError(400);
  return { ...value, discountType: "percentage" };
}
export function parseQuotationInput(input: unknown): QuotationInput { return percentageInput(parseCommercial(quotationSchema, input)); }
// The original forms allow blank attention. Local records preserve that blank;
// remote contact creation keeps the stricter existing quotation contract.
const localQuotationSchema = quotationSchema.extend({ kindAttention: singleLine(200) });
export function parseLocalQuotationInput(input: unknown): QuotationInput { return percentageInput(parseCommercial(localQuotationSchema, input)); }
/** Read provenance first. Legacy headers are amounts and never become percentages by parsing. */
export function parseSavedQuotationInput(input: unknown, policy: string, local = false): QuotationInput {
  if (policy === PERCENTAGE_QUOTATION_POLICY) {
    const value = local ? parseLocalQuotationInput(input) : parseQuotationInput(input);
    if (!(input && typeof input === "object" && "discountType" in input && input.discountType === "percentage")) throw new CommercialError(409);
    return value;
  }
  if (policy !== "percentage-create-v1") throw new CommercialError(409);
  const value = parseCommercial(local ? localQuotationSchema : quotationSchema, input);
  if (value.discountType !== undefined) throw new CommercialError(409);
  return value;
}
export function historicalDiscountEditBlocked(input: QuotationInput, policy: string): boolean {
  return policy !== PERCENTAGE_QUOTATION_POLICY && (compare(decimal(input.discount), zero) !== 0
    || input.items.some(item => compare(decimal(item.itemDiscount), zero) !== 0));
}
export function assertQuotationMode(quote: QuotationInput, mode: { operation: "create" } | { operation: "edit"; quoteId: string }) {
  if (mode.operation === "edit") {
    parseCommercial(externalIdSchema, mode.quoteId);
    void quote; // Saved-record provenance is checked by the persistence service.
  }
}

/** Active mutation arithmetic accepts percentages only. */
export function calculateQuotation(input: unknown, interpretation: "percentage" = "percentage") {
  if (interpretation !== "percentage") throw new CommercialError(400);
  return calculateParsedQuotation(parseQuotationInput(input), "percentage", true);
}
/** Read-only source characterization; never used to accept or persist mutation input. */
export function calculateLegacyQuotation(input: unknown, interpretation: "percentage" | "flat") {
  const quote = parseCommercial(quotationSchema, input);
  return calculateParsedQuotation(quote, interpretation, false);
}
export function calculateSavedQuotation(input: unknown, policy: string, local = false) {
  const quote = parseSavedQuotationInput(input, policy, local);
  return calculateParsedQuotation(quote, "percentage", policy === PERCENTAGE_QUOTATION_POLICY);
}

/** Explicit local percentage policy; no contact lookup or placeholder is involved. */
export function calculateLocalQuotation(input: unknown) {
  return calculateParsedQuotation(parseLocalQuotationInput(input), "percentage", true);
}

function calculateParsedQuotation(quote: QuotationInput, interpretation: "percentage" | "flat", percentageHeader: boolean) {
  const lines = quote.items.map((item) => {
    const base = multiply(decimal(item.quantity), decimal(item.unitPrice));
    return subtract(base, interpretation === "percentage"
      ? percent(base, decimal(item.itemDiscount)) : decimal(item.itemDiscount));
  });
  const subtotal = lines.reduce(add, zero);
  const headerDiscount = percentageHeader ? percent(subtotal, decimal(quote.discount)) : decimal(quote.discount);
  const discounted = subtract(subtotal, headerDiscount);
  const taxable = compare(discounted, zero) < 0 ? zero : discounted;
  const vat = percent(taxable, decimal("5"));
  const grandTotal = add(add(taxable, vat), decimal(quote.adjustment));
  return { interpretation, lineTotals: lines.map(money), exactLineTotals: lines.map(exact),
    subtotal: money(subtotal), exactSubtotal: exact(subtotal), headerDiscount: exact(headerDiscount),
    ...(percentageHeader ? { headerDiscountAmount: money(headerDiscount) } : {}),
    taxable: money(taxable), exactTaxable: exact(taxable), vatPercent: "5", vatAmount: money(vat),
    adjustment: exact(decimal(quote.adjustment)), grandTotal: money(grandTotal) };
}

/** Preview the original create form before a deal or product has been selected. Never submit these placeholders. */
export function previewQuotationDraft(input: QuotationInput) {
  try {
    return calculateQuotation({ ...input, subject: input.subject || "Draft preview", kindAttention: input.kindAttention || "Draft preview",
      items: input.items.map((item) => ({ ...item, productId: item.productId || "1", productName: item.productName || "Draft item" })) }, "percentage");
  } catch { return undefined; }
}

export function inspectQuotationRules(input: unknown) {
  const quote = parseCommercial(quotationSchema, input);
  const formAndCreate = calculateLegacyQuotation(quote, "percentage");
  const editServer = calculateLegacyQuotation(quote, "flat");
  return { formAndCreate, editServer,
    hasAmbiguousEditDiscount: quote.items.some((item) => compare(decimal(item.itemDiscount), zero) !== 0),
    remoteAmountUsesSubtotal: true as const,
    headerTotalsSentToZoho: false as const };
}

/** Canonical decimal-string contract. No network serialization is certified yet. */
export function buildQuotationRequest(input: unknown, links: {
  dealId: string; contactId: string; contactName: string;
}, mode: { operation: "create" } | { operation: "edit"; quoteId: string }) {
  const quote = parseQuotationInput(input);
  assertQuotationMode(quote, mode);
  const totals = calculateQuotation(quote, "percentage");
  // Empty descriptions cause a product lookup in PHP; callers must resolve that
  // lookup explicitly, rather than silently fabricate a product description.
  const unresolvedDescriptionIds = quote.items.filter((item) => item.description === "").map((item) => item.productId);
  return {
    method: mode.operation === "create" ? "POST" as const : "PUT" as const,
    apiVersion: "v2.1" as const, path: "/Quotes", unresolvedDescriptionIds, totals,
    body: { data: [{
      ...(mode.operation === "edit" ? { id: parseCommercial(externalIdSchema, mode.quoteId) } : {}),
      Deal_Name: parseCommercial(externalIdSchema, links.dealId), Subject: quote.subject,
      Project: quote.project, Terms_of_Payment: quote.termsOfPayment, Specification: quote.specification,
      General_Exclusion: quote.generalExclusion, Brand: quote.brand, Warranty: quote.warranty,
      Delivery: quote.delivery, Valid_Till: quote.validUntil,
      Contact_Name: { id: parseCommercial(externalIdSchema, links.contactId), name: parseCommercial(singleLine(200).min(1), links.contactName) },
      Amount: totals.subtotal,
      Quoted_Items: quote.items.map((item) => ({ Product_Name: { id: item.productId },
        Quantity: exact(decimal(item.quantity)), List_Price: exact(decimal(item.unitPrice)),
        ItemDiscount: exact(decimal(item.itemDiscount)), U_O_M: item.uom, Description: item.description })),
    }] },
  };
}

export function buildQuotedDealTransition(dealId: string, quoteNumber: string) {
  const id = parseCommercial(externalIdSchema, dealId);
  const number = parseCommercial(singleLine(100).min(1), quoteNumber);
  const lastPart = number.split("-").at(-1);
  if (!lastPart) throw new CommercialError(400);
  return { method: "PUT" as const, path: "/Deals", apiVersion: "v2.1" as const,
    body: { data: [{ id, Stage: "Proposal/Price Quote", QuoteDealNumber: number }] },
    localStatus: "Proposal/Price Quote", localQuoteDealNumber: number.includes("-") ? `QUOTE-${lastPart}` : number };
}
