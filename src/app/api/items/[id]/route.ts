import { NextRequest } from "next/server";
import { commercialResponse } from "@/server/commercial/http";
import { crmQuery } from "@/server/crm-http";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export function GET(request: NextRequest, context: Context) {
  return commercialResponse(request, async ({ service, token }) => {
    const { id } = await context.params;
    crmQuery(request, [], []);
    return service.getProduct(token, id);
  });
}

