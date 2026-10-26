import { NextRequest } from "next/server";
import { getDatabase } from "@/server/db";
import { createLeadsService } from "@/server/leads/service";
import { crmRead, crmQuery } from "@/server/crm-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: NextRequest) {
  return crmRead(request, (token) => createLeadsService(getDatabase()).listAgents(token, crmQuery(request, ["query", "scope"], ["page", "pageSize"])));
}

