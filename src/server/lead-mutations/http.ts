import "server-only";
import { NextRequest } from "next/server";
import { getDatabase } from "../db";
import { crmQuery } from "../crm-http";
import { authService, errorResponse, jsonResponse, webConfig } from "../web-auth";
import { HttpError, readJson, rejectCrossOriginRead, requireCsrf, requireSameOrigin, validToken } from "../http-security";
import { createLeadMutationsService, LeadMutationError } from "./service";

type Context = { token: string; body: unknown; service: ReturnType<typeof createLeadMutationsService> };
export async function leadMutationResponse(request: NextRequest,
  action: (context: Context) => unknown | Promise<unknown>, write: false | "lead" | "deal" = false) {
  try {
    const config = webConfig();
    if (write) requireSameOrigin(request, config); else rejectCrossOriginRead(request, config);
    const token = request.cookies.get(config.sessionCookie)?.value;
    if (!validToken(token)) throw new HttpError(401, "Sign in required.");
    const auth = authService(), user = await auth.authenticate(token);
    if (!user) throw new HttpError(401, "Sign in required.");
    if (write) {
      if (write === "deal" ? !user.permissions.includes("deals.manage")
        : !user.permissions.some((p) => p === "leads.manage" || p === "leads.manage.agents")) throw new LeadMutationError(403);
      const csrf = requireCsrf(request, request.cookies.get(config.csrfCookie)?.value);
      if (!await auth.verifySessionCsrf(token, csrf)) throw new HttpError(403, "Request not permitted.");
    }
    crmQuery(request, [], []);
    const body = write ? await readJson(request) : undefined;
    // There is no configured transport or mock-mode environment toggle. Prepared integration writes fail closed.
    return jsonResponse(await action({ token, body, service: createLeadMutationsService(getDatabase()) }));
  } catch (error) {
    return error instanceof LeadMutationError ? jsonResponse({ error: error.message }, error.status) : errorResponse(error);
  }
}
