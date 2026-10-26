import { z } from "zod";
import { add, compare, decimal, exact, money, multiply, percent, subtract } from "./decimal";
import { CommercialError, externalIdSchema, multiLine, parseCommercial, singleLine } from "./validation";

const decimalString = z.string().regex(/^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$/);
const signedDecimalString = z.string().regex(/^-?(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$/);
const zero = decimal("0");
const itemSchema = z.object({
  productId: externalIdSchema, productName: singleLine(200).min(1), description: multiLine(10_000),
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
  discount: decimalString, adjustment: signedDecimalString,
  items: z.array(itemSchema).min(1).max(200),
}).strict();

export type QuotationInput = z.infer<typeof quotationSchema>;
export function parseQuotationInput(input: unknown): QuotationInput { return parseCommercial(quotationSchema, input); }
export function assertQuotationMode(quote: QuotationInput, mode: { operation: "create" } | { operation: "edit"; quoteId: string }) {
  if (mode.operation === "edit") {
    parseCommercial(externalIdSchema, mode.quoteId);
    if (quote.items.some((item) => compare(decimal(item.itemDiscount), zero) !== 0)) throw new CommercialError(409);
  }
}

/** Source characterization only: create + both forms use percentage; edit PHP uses flat. */
export function calculateQuotation(input: unknown, interpretation: "percentage" | "flat") {
  const quote = parseQuotationInput(input);
  const lines = quote.items.map((item) => {
    const base = multiply(decimal(item.quantity), decimal(item.unitPrice));
    return subtract(base, interpretation === "percentage"
      ? percent(base, decimal(item.itemDiscount)) : decimal(item.itemDiscount));
  });
  const subtotal = lines.reduce(add, zero);
  const discounted = subtract(subtotal, decimal(quote.discount));
  const taxable = compare(discounted, zero) < 0 ? zero : discounted;
  const vat = percent(taxable, decimal("5"));
  const grandTotal = add(add(taxable, vat), decimal(quote.adjustment));
  return { interpretation, lineTotals: lines.map(money), exactLineTotals: lines.map(exact),
    subtotal: money(subtotal), exactSubtotal: exact(subtotal), headerDiscount: exact(decimal(quote.discount)),
    taxable: money(taxable), exactTaxable: exact(taxable), vatPercent: "5", vatAmount: money(vat),
    adjustment: exact(decimal(quote.adjustment)), grandTotal: money(grandTotal) };
}

export function inspectQuotationRules(input: unknown) {
  const quote = parseQuotationInput(input);
  const formAndCreate = calculateQuotation(quote, "percentage");
  const editServer = calculateQuotation(quote, "flat");
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
