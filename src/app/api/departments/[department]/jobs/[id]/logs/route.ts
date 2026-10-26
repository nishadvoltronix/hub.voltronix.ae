import { NextRequest } from "next/server";
import { departmentResponse } from "@/server/departments/http";
import { crmQuery } from "@/server/crm-http";
import { readLogMultipart, type LogMultipart } from "@/server/departments/log-upload";
export const runtime = "nodejs";
type Context = { params: Promise<{ department: string; id: string }> };
export function GET(request: NextRequest, context: Context) {
  return departmentResponse(request, async ({ service, token }) => {
    const { department, id } = await context.params;
    const query = crmQuery(request, [], ["page", "pageSize"]);
    return service.listLogs(token, department, id, query);
  });
}
export function POST(request: NextRequest, context: Context) {
  if ((request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    return departmentResponse(request, async ({ service, token, body }) => {
      const { department, id } = await context.params;
      const form = body as LogMultipart;
      return service.addLog(token, department, id, form.payload, form.file);
    }, true, async ({ service, token }) => {
      const { department, id } = await context.params;
      crmQuery(request, [], []);
      await service.authorizeLog(token, department, id);
      return readLogMultipart(request, department);
    });
  }
  return departmentResponse(request, async ({ service, token, body }) => {
    const { department, id } = await context.params;
    crmQuery(request, [], []);
    return service.addLog(token, department, id, body);
  }, true);
}

