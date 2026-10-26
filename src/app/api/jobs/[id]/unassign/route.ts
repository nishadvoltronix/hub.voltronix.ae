import { NextRequest } from "next/server";
import { departmentResponse } from "@/server/departments/http";
import { crmQuery } from "@/server/crm-http";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export function POST(request: NextRequest, context: Context) {
  return departmentResponse(request, async ({ service, token, body }) => {
    const { id } = await context.params;
    crmQuery(request, [], []);
    return service.unassign(token, id, body);
  }, true);
}

