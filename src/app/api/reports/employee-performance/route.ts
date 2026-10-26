import { NextRequest } from "next/server";
import { getDatabase } from "@/server/db";
import { jobsResponse } from "@/server/jobs-http";
import { crmQuery } from "@/server/crm-http";
import { createReportsService, ReportError } from "@/server/reports/service";
import { HttpError } from "@/server/http-security";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: NextRequest) {
  return jobsResponse(request, async ({ token }) => {
    try { return await createReportsService(getDatabase()).employeePerformance(token, crmQuery(request, ["dateFrom", "dateTo", "query"], ["page", "pageSize"])); }
    catch (error) { if (error instanceof ReportError) throw new HttpError(error.status, error.message); throw error; }
  });
}
