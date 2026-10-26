import { NextRequest } from "next/server";
import { jobsResponse } from "@/server/jobs-http";
import { crmQuery } from "@/server/crm-http";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export function GET(request: NextRequest, context: Context) {
  return jobsResponse(request, async ({ service, token }) => {
    const job = await service.getJob(token, (await context.params).id);
    crmQuery(request, [], []);
    return job;
  });
}
