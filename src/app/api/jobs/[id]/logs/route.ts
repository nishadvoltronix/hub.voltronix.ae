import { NextRequest } from "next/server";
import { departmentResponse } from "@/server/departments/http";
import { crmQuery } from "@/server/crm-http";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export function GET(request: NextRequest, context: Context) {
  return departmentResponse(request, async ({ service, token }) => {
    const { id } = await context.params;
    const query = crmQuery(request, ["department"], ["page", "pageSize"]);
    return service.listJobLogs(token, id, query.department, { page: query.page, pageSize: query.pageSize });
  });
}

