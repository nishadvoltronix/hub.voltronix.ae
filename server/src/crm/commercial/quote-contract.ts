import { z } from "zod";
import { assertQuotationMode, buildQuotationRequest, buildQuotedDealTransition, parseQuotationInput } from "./quotations.js";
import { CommercialError, exactSearchPath, externalIdSchema, multiLine, parseCommercial, singleLine } from "./validation.js";
import { type CommercialTransport, parseRecord, parseWriteId, requestContract } from "./transport.js";

/** Models remote sequencing with an injected port. It does not commit the local database or report a CRM operation completed. */
export async function executeQuotationContract(transport: CommercialTransport, input: unknown,
  dealId: string, mode: { operation: "create" } | { operation: "edit"; quoteId: string }) {
  const quote = parseQuotationInput(input);
  // Validate all caller-controlled values and block ambiguous edits before any remote effect.
  parseCommercial(externalIdSchema, dealId);
  assertQuotationMode(quote, mode);
  const contactSearchPath = exactSearchPath("Contacts", "Last_Name", quote.kindAttention);
  const contactSearch = await requestContract(transport, { method: "GET", apiVersion: "v2.1", path: contactSearchPath });
  let candidates: { id: string; Last_Name: string }[] = [];
  if (contactSearch.status !== 204) {
    const found = z.object({ data: z.array(z.object({ id: externalIdSchema, Last_Name: singleLine(200).min(1) })).max(1),
      info: z.object({ more_records: z.literal(false) }).optional() }).strict().safeParse(contactSearch.body);
    // A partial/paginated or mismatched search cannot identify a unique contact.
    // Never create a duplicate or bind a quote to an unrelated returned record.
    if (contactSearch.status !== 200 || !found.success) throw new CommercialError(502);
    candidates = found.data.data;
    if (candidates[0] && candidates[0].Last_Name !== quote.kindAttention) throw new CommercialError(502);
  }
  let contactId: string;
  let contactName: string;
  if (candidates.length === 0) {
    const created = await requestContract(transport, { method: "POST", apiVersion: "v2.1", path: "/Contacts",
      body: { data: [{ Last_Name: quote.kindAttention }] } });
    contactId = parseWriteId(created.body);
    contactName = quote.kindAttention;
  } else {
    contactId = candidates[0]!.id;
    contactName = candidates[0]!.Last_Name;
  }
  for (const item of quote.items) {
    if (item.description !== "") continue;
    const response = await requestContract(transport, { method: "GET", apiVersion: "v2.1", path: `/Products/${item.productId}` });
    const product = z.object({ id: externalIdSchema, Description: multiLine(10_000).nullable() }).safeParse(parseRecord(response.body));
    if (!product.success || product.data.id !== item.productId) throw new CommercialError(502);
    item.description = product.data.Description ?? "";
  }
  const request = buildQuotationRequest(quote, { dealId, contactId, contactName }, mode);
  const write = await requestContract(transport, { method: request.method, apiVersion: request.apiVersion, path: request.path, body: request.body });
  const quoteId = parseWriteId(write.body);
  if (mode.operation === "edit" && quoteId !== mode.quoteId) throw new CommercialError(502);
  const detailsResponse = await requestContract(transport, { method: "GET", apiVersion: "v2.1", path: `/Quotes/${quoteId}` });
  const details = z.object({ id: externalIdSchema, Quote_No: singleLine(100).min(1),
    Modified_Time: z.iso.datetime({ offset: true }) }).safeParse(parseRecord(detailsResponse.body));
  if (!details.success || details.data.id !== quoteId) throw new CommercialError(502);
  let dealTransition: "not-requested" | "acknowledged" | "requires-reconciliation" = "not-requested";
  if (mode.operation === "create") {
    const transition = buildQuotedDealTransition(dealId, details.data.Quote_No);
    try {
      const updated = await requestContract(transport, transition);
      if (parseWriteId(updated.body) !== dealId) throw new CommercialError(502);
      dealTransition = "acknowledged";
    } catch { dealTransition = "requires-reconciliation"; }
  }
  return { quoteId, quoteNumber: details.data.Quote_No, modifiedTime: details.data.Modified_Time,
    totals: request.totals, normalizedItems: quote.items, dealTransition,
    localCommitPerformed: false as const };
}
