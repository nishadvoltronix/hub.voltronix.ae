import { z } from "zod";
import { exactSearchPath, externalIdSchema, multiLine, parseCommercial, singleLine, CommercialError } from "./validation";
import { type CommercialTransport, parseWriteId, requestContract } from "./transport";

const productInput = z.object({ name: singleLine(200).min(1), description: multiLine(10_000) }).strict();
const price = z.string().regex(/^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$/);
// Numeric wire amounts must be converted losslessly by a future JSON adapter;
// unsafe/unrepresentable decimal numbers are not accepted as exact CRM prices.
const recordSchema = z.object({ id: externalIdSchema, Product_Name: singleLine(200).min(1),
  Description: multiLine(10_000).nullish(), Unit_Price: price.nullish() });
export function buildProductPayload(input: unknown) {
  const product = parseCommercial(productInput, input);
  return { data: [{ Product_Name: product.name, Description: product.description }] };
}
export function buildProductSearchPath(input: unknown): string | null {
  const query = parseCommercial(singleLine(120), input);
  return query.length < 2 ? null : `${exactSearchPath("Products", "Product_Name", query)}&per_page=50`;
}
function parseProducts(body: unknown, maximum: number) {
  const parsed = z.object({ data: z.array(recordSchema).max(maximum) }).safeParse(body);
  if (!parsed.success) throw new CommercialError(502);
  return parsed.data.data.map((item) => ({ externalId: item.id, name: item.Product_Name,
    description: item.Description ?? null, unitPrice: item.Unit_Price ?? null }));
}
/** Internal injectable contract only; API callers still require their own current-session authorization. */
export function createProductContract(transport: CommercialTransport) {
  return {
    async create(input: unknown) {
      const body = buildProductPayload(input);
      const response = await requestContract(transport, { apiVersion: "v2.1", method: "POST", path: "/Products", body });
      return { externalId: parseWriteId(response.body) };
    },
    async search(input: unknown) {
      const path = buildProductSearchPath(input);
      if (path === null) return [];
      const response = await requestContract(transport, { apiVersion: "v8", method: "GET", path });
      return response.status === 204 ? [] : parseProducts(response.body, 50);
    },
    async list(pageInput: unknown) {
      const page = parseCommercial(z.number().int().min(1).max(1_000_000), pageInput);
      const response = await requestContract(transport, { apiVersion: "v2.1", method: "GET",
        path: `/Products?page=${page}&per_page=200&sort_by=Product_Name&sort_order=asc` });
      if (response.status === 204) return { items: [], page, pageSize: 200, moreRecords: false };
      const items = parseProducts(response.body, 200);
      const metadata = z.object({ info: z.object({ more_records: z.boolean() }) }).safeParse(response.body);
      if (!metadata.success) throw new CommercialError(502);
      return { items, page, pageSize: 200, moreRecords: metadata.data.info.more_records };
    },
  };
}
