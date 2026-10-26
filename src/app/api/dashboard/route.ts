import { NextRequest } from "next/server";
import { getDatabase } from "@/server/db";
import { createDashboardService } from "@/server/dashboard/service";
import { crmRead, crmQuery } from "@/server/crm-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: NextRequest) {
  return crmRead(request, (token) => createDashboardService(getDatabase()).getDashboard(token, crmQuery(request, ["employeeSearch"], ["employeePage", "employeePageSize"])));
}

