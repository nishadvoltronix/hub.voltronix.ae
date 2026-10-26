import { NextRequest } from "next/server";
import { authService, errorResponse, jsonResponse, webConfig } from "@/server/web-auth";
import { cookieOptions, HttpError, requireCsrf, requireSameOrigin, validToken } from "@/server/http-security";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const config = webConfig();
    requireSameOrigin(request, config);
    const csrf = requireCsrf(request, request.cookies.get(config.csrfCookie)?.value);
    const session = request.cookies.get(config.sessionCookie)?.value;
    if (validToken(session)) {
      const service = authService();
      if (await service.authenticate(session) && !await service.verifySessionCsrf(session, csrf)) {
        throw new HttpError(403, "Request not permitted.");
      }
      // Even expired/disabled sessions must be revoked and their cookies removed.
      await service.logout(session);
    }
    const response = jsonResponse({ signedOut: true });
    response.cookies.set(config.sessionCookie, "", cookieOptions(config, 0));
    response.cookies.set(config.csrfCookie, "", cookieOptions(config, 0));
    return response;
  } catch (error) { return errorResponse(error); }
}
