import { NextRequest } from "next/server";
import { departmentResponse } from "@/server/departments/http";
import { crmQuery } from "@/server/crm-http";
export const runtime = "nodejs";
type Context = { params: Promise<{ department: string; id: string }> };
export function PATCH(request: NextRequest, context: Context) {
  return departmentResponse(request, async ({ service, token, body }) => {
    const { department, id } = await context.params;
    crmQuery(request, [], []);
    return service.updateStatus(token, department, id, body);
  }, true);
}

