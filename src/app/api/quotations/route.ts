import { NextRequest } from "next/server";
import { commercialResponse } from "@/server/commercial/http";
import { crmQuery } from "@/server/crm-http";
import { HttpError } from "@/server/http-security";
export const runtime = "nodejs";
export function GET(request: NextRequest) {
  return commercialResponse(request, ({ service, token }) => {
    const query = crmQuery(request, ["query", "sort", "direction"], ["page","pageSize"]);
    return service.listQuotations(token, query);
  });
}
export function POST(request: NextRequest) {
  return commercialResponse(request, ({ service, token, body }) => {
    crmQuery(request, [], []);
    if (typeof body !== "object" || body === null || Array.isArray(body) || !("taskId" in body) || typeof body.taskId !== "string") throw new HttpError(400, "Invalid quotation request.");
    const { taskId, ...input } = body;
    return service.createQuotation(token, taskId, input);
  }, "quotation");
}

