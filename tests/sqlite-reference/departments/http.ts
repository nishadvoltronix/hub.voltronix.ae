import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createDepartmentsService, DepartmentsError } from "./service";
import { getDatabase } from "../db";
import { authService, errorResponse, jsonResponse, webConfig } from "../web-auth";
import { HttpError, readJson, rejectCrossOriginRead, requireCsrf, requireSameOrigin, validToken } from "../http-security";
import { AttachmentError } from "../attachments/service";
type Context = { token: string; body: unknown; service: ReturnType<typeof createDepartmentsService> };
export async function departmentResponse(request: NextRequest, action: (context: Context) => unknown | Promise<unknown>, write = false,
  parseBody?: (context: Omit<Context, "body">) => Promise<unknown>) {
  try {
    const config = webConfig();
    if (write) requireSameOrigin(request, config); else rejectCrossOriginRead(request, config);
    const token = request.cookies.get(config.sessionCookie)?.value;
    if (!validToken(token)) throw new HttpError(401, "Sign in required.");
    const auth = authService();
    if (!auth.authenticate(token)) throw new HttpError(401, "Sign in required.");
    if (write && !auth.verifySessionCsrf(token, requireCsrf(request, request.cookies.get(config.csrfCookie)?.value))) throw new HttpError(403, "Request not permitted.");
    const context = { token, service: createDepartmentsService(getDatabase()) };
    const body = write ? (parseBody ? await parseBody(context) : await readJson(request)) : undefined;
    const result = await action({ ...context, body });
    return result instanceof NextResponse ? result : jsonResponse(result);
  } catch (error) {
    return error instanceof DepartmentsError || error instanceof AttachmentError ? jsonResponse({ error: error.message }, error.status) : errorResponse(error);
  }
}
