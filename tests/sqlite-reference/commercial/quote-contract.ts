import { z } from "zod";
import { assertQuotationMode, buildQuotationRequest, buildQuotedDealTransition, parseQuotationInput } from "./quotations";
import { CommercialError, exactSearchPath, externalIdSchema, multiLine, parseCommercial, singleLine } from "./validation";
import { type CommercialTransport, parseRecord, parseWriteId, requestContract } from "./transport";

/** Models remote sequencing with an injected port. It does not commit SQLite or report a CRM operation completed. */
export async function executeQuotationContract(transport: CommercialTransport, input: unknown,
  dealId: string, mode: { operation: "create" } | { operation: "edit"; quoteId: string }) {
  const quote = parseQuotationInput(input);
  // Validate all caller-controlled values and block ambiguous edits before any remote effect.
  parseCommercial(externalIdSchema, dealId);
  assertQuotationMode(quote, mode);
  const contactSearchPath = exactSearchPath("Contacts", "Last_Name", quote.kindAttention);
  const contactSearch = await requestContract(transport, { method: "GET", apiVersion: "v2.1", path: contactSearchPath });
  let contactId: string;
  let contactName: string;
  if (contactSearch.status === 204 || (typeof contactSearch.body === "object" && contactSearch.body !== null
    && "data" in contactSearch.body && Array.isArray(contactSearch.body.data) && contactSearch.body.data.length === 0)) {
    const created = await requestContract(transport, { method: "POST", apiVersion: "v2.1", path: "/Contacts",
      body: { data: [{ Last_Name: quote.kindAttention }] } });
    contactId = parseWriteId(created.body);
    contactName = quote.kindAttention;
  } else {
    const existing = z.object({ data: z.array(z.object({ id: externalIdSchema, Last_Name: singleLine(200).min(1) })).length(1) })
      .safeParse(contactSearch.body);
    // The source picks the first same-name contact; multiple candidates now need explicit resolution.
    if (!existing.success || !existing.data.data[0]) throw new CommercialError(502);
    contactId = existing.data.data[0].id;
    contactName = existing.data.data[0].Last_Name;
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
