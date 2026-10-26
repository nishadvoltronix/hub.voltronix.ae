import { NextRequest } from "next/server";
import { commercialResponse } from "@/server/commercial/http";
import { crmQuery } from "@/server/crm-http";
export const runtime = "nodejs";
export function GET(request: NextRequest) {
  return commercialResponse(request, async ({ service, token }) => {
    const query = crmQuery(request, ["query", "sort", "direction"], ["page","pageSize"]);
    const result = await service.listProducts(token, query);
    return { ...result, items: result.items.map((item) => ({ ...item, id: item.externalId })) };
  });
}
export function POST(request: NextRequest) {
  return commercialResponse(request, ({ service, token, body }) => {
    crmQuery(request, [], []);
    return service.createProduct(token, body);
  }, "product");
}

