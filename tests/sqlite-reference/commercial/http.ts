import "server-only";
import { NextRequest } from "next/server";
import { createCommercialService, CommercialPersistenceError } from "./service";
import { getDatabase } from "../db";
import { authService, errorResponse, jsonResponse, webConfig } from "../web-auth";
import { HttpError, readJson, rejectCrossOriginRead, requireCsrf, requireSameOrigin, validToken } from "../http-security";
type Context = { token: string; body: unknown; service: ReturnType<typeof createCommercialService> };
export async function commercialResponse(request: NextRequest, action: (context: Context) => unknown | Promise<unknown>, write: false | "product" | "quotation" = false) {
  try {
    const config = webConfig();
    if (write) requireSameOrigin(request, config); else rejectCrossOriginRead(request, config);
    const token = request.cookies.get(config.sessionCookie)?.value;
    if (!validToken(token)) throw new HttpError(401, "Sign in required.");
    const auth = authService(), user = auth.authenticate(token);
    if (!user) throw new HttpError(401, "Sign in required.");
    if (write) {
      if (write === "product" ? !user.permissions.includes("items.write") : !user.permissions.some((key) => key === "leads.manage" || key === "leads.manage.agents")) throw new HttpError(403, "Access denied.");
      if (!auth.verifySessionCsrf(token, requireCsrf(request, request.cookies.get(config.csrfCookie)?.value))) throw new HttpError(403, "Request not permitted.");
    }
    const body = write ? await readJson(request, write === "quotation" ? 262_144 : 65_536) : undefined;
    // No adapter, credential lookup or runtime mock-success switch is supplied.
    return jsonResponse(await action({ token, body, service: createCommercialService(getDatabase()) }));
  } catch (error) { return error instanceof CommercialPersistenceError ? jsonResponse({ error: error.message }, error.status) : errorResponse(error); }
}
