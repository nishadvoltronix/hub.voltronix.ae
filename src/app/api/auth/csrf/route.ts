import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { authService, errorResponse, jsonResponse, webConfig } from "@/server/web-auth";
import { cookieOptions, rejectCrossOriginRead, validToken } from "@/server/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const config = webConfig();
    rejectCrossOriginRead(request, config);
    const csrfToken = randomBytes(32).toString("base64url");
    const session = request.cookies.get(config.sessionCookie)?.value;
    if (validToken(session)) await authService().setSessionCsrf(session, csrfToken);
    const response = jsonResponse({ csrfToken });
    response.cookies.set(config.csrfCookie, csrfToken, cookieOptions(config, 7200));
    return response;
  } catch (error) { return errorResponse(error); }
}
