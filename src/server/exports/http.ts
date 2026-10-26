import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createExportsService, ExportsError } from "./service";
import { getDatabase } from "../db";
import { crmQuery } from "../crm-http";
import { authService, errorResponse, jsonResponse, webConfig } from "../web-auth";
import { HttpError, rejectCrossOriginRead, validToken } from "../http-security";
export async function exportResponse(request: NextRequest, department?: string) {
  try {
    const config = webConfig(); rejectCrossOriginRead(request, config);
    const token = request.cookies.get(config.sessionCookie)?.value;
    if (!validToken(token) || !await authService().authenticate(token)) throw new HttpError(401, "Sign in required.");
    const query = crmQuery(request, ["query", "jobStatus"], []);
    const service = createExportsService(getDatabase());
    const result = department === undefined ? await service.exportJobs(token, query) : await service.exportDepartmentJobs(token, department, query);
    return new NextResponse(new Uint8Array(result.bytes), { headers: {
      "Content-Type": result.contentType, "Content-Disposition": `attachment; filename="${result.filename}"`,
      "Cache-Control": "private, no-store", "Vary": "Cookie", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'", "Content-Length": String(result.bytes.length),
    } });
  } catch (error) { return error instanceof ExportsError ? jsonResponse({ error: error.message }, error.status) : errorResponse(error); }
}
