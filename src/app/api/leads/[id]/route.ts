import { NextRequest } from "next/server";
import { getDatabase } from "@/server/db";
import { createLeadsService } from "@/server/leads/service";
import { crmQuery, crmRead } from "@/server/crm-http";
export const runtime = "nodejs";
type Route = { params: Promise<{ id: string }> };
export function GET(request: NextRequest, context: Route) {
  return crmRead(request, async (token) => {
    const lead = await createLeadsService(getDatabase()).getLead(token, (await context.params).id);
    crmQuery(request, [], []);
    return lead;
  });
}

