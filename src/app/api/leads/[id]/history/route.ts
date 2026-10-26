import { NextRequest } from "next/server";
import { getDatabase } from "@/server/db";
import { createLeadsService } from "@/server/leads/service";
import { crmRead, crmQuery } from "@/server/crm-http";
export const runtime = "nodejs";
type Route = { params: Promise<{ id: string }> };
export function GET(request: NextRequest, context: Route) {
  return crmRead(request, async (token) => createLeadsService(getDatabase()).listStatusHistory(token, (await context.params).id, crmQuery(request, [], ["page", "pageSize"])));
}

