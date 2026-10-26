import { NextRequest } from "next/server";
import { jobsResponse } from "@/server/jobs-http";
import { crmQuery } from "@/server/crm-http";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export function PATCH(request: NextRequest, context: Context) {
  return jobsResponse(request, async ({ service, token, body }) => {
    crmQuery(request, [], []);
    return service.updateRemarks(token, (await context.params).id, body);
  }, true);
}
