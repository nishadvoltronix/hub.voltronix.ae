import "server-only";
import { NextRequest } from "next/server";
import { requirePermission } from "./auth/service";
import { getDatabase } from "./db";
import { createJobsService, JobsError } from "./jobs/service";
import { authService, errorResponse, jsonResponse, webConfig } from "./web-auth";
import { HttpError, readJson, rejectCrossOriginRead, requireCsrf, requireSameOrigin, validToken } from "./http-security";

type Context = { token: string; body: unknown; service: ReturnType<typeof createJobsService> };
export async function jobsResponse(request: NextRequest, action: (context: Context) => unknown | Promise<unknown>, write = false) {
  try {
    const config = webConfig();
    if (write) requireSameOrigin(request, config); else rejectCrossOriginRead(request, config);
    const token = request.cookies.get(config.sessionCookie)?.value;
    if (!validToken(token)) throw new HttpError(401, "Sign in required.");
    const auth = authService();
    const user = await auth.authenticate(token);
    if (!user) throw new HttpError(401, "Sign in required.");
    requirePermission(user, "dashboard.view");
    if (write) {
      const csrf = requireCsrf(request, request.cookies.get(config.csrfCookie)?.value);
      if (!await auth.verifySessionCsrf(token, csrf)) throw new HttpError(403, "Request not permitted.");
    }
    const body = write ? await readJson(request) : undefined;
    return jsonResponse(await action({ token, body, service: createJobsService(getDatabase()) }));
  } catch (error) {
    return error instanceof JobsError ? jsonResponse({ error: error.message }, error.status) : errorResponse(error);
  }
}
