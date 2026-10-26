import { NextRequest } from "next/server";
import { commercialResponse } from "@/server/commercial/http";
import { crmQuery } from "@/server/crm-http";
export const runtime = "nodejs";
type Context = { params: Promise<{ taskId: string }> };
export function GET(request: NextRequest, context: Context) {
  return commercialResponse(request, async ({ service, token }) => {
    const { taskId } = await context.params;
    crmQuery(request, [], []);
    return service.getQuotation(token, taskId);
  });
}
export function PATCH(request: NextRequest, context: Context) {
  return commercialResponse(request, async ({ service, token, body }) => {
    const { taskId } = await context.params;
    crmQuery(request, [], []);
    return service.updateQuotation(token, taskId, body);
  }, "quotation");
}

