import { NextRequest } from "next/server";
import { jobsResponse } from "@/server/jobs-http";
import { crmQuery } from "@/server/crm-http";
import { HttpError } from "@/server/http-security";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: NextRequest) {
  return jobsResponse(request, ({ service, token }) => {
    const query = crmQuery(request, ["query", "jobStatus", "cohort"], ["page", "pageSize"]);
    if (query.cohort !== undefined && !["all", "pending", "process", "completed", "hold", "closed"].includes(String(query.cohort))) throw new HttpError(400, "Invalid job input.");
    if (query.cohort !== undefined && query.cohort !== "all") throw new HttpError(503, "Job cohorts are unavailable in this runtime.");
    delete query.cohort;
    return service.listJobs(token, query);
  });
}
