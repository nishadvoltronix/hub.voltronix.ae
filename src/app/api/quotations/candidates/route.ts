import { NextRequest } from "next/server";
import { commercialResponse } from "@/server/commercial/http";
import { crmQuery } from "@/server/crm-http";
export const runtime = "nodejs";
export function GET(request: NextRequest) {
  return commercialResponse(request, async ({ service, token }) => {
    const query = crmQuery(request, ["query"], ["page","pageSize"]);
    const result = await service.listQuotationCandidates(token, query);
    return { ...result, items: result.items.map((item) => ({ ...item, id: item.taskId })) };
  });
}

