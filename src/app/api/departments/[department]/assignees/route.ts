import { NextRequest } from "next/server";
import { departmentResponse } from "@/server/departments/http";
import { crmQuery } from "@/server/crm-http";
export const runtime = "nodejs";
type Context = { params: Promise<{ department: string }> };
export function GET(request: NextRequest, context: Context) {
  return departmentResponse(request, async ({ service, token }) => {
    const { department } = await context.params;
    const query = crmQuery(request, ["query"], ["page", "pageSize"]);
    return service.listAssignees(token, department, query);
  });
}

