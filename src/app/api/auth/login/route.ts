import { NextRequest } from "next/server";
import { z } from "zod";
import { authService, errorResponse, jsonResponse, webConfig } from "@/server/web-auth";
import { cookieOptions, HttpError, readJson, requireCsrf, requireSameOrigin, validToken } from "@/server/http-security";

export const runtime = "nodejs";
const credentials = z.object({ email: z.string().max(254), password: z.string().max(1024) }).strict();

export async function POST(request: NextRequest) {
  try {
    const config = webConfig();
    requireSameOrigin(request, config);
    requireCsrf(request, request.cookies.get(config.csrfCookie)?.value);
    const input = credentials.safeParse(await readJson(request));
    if (!input.success) throw new HttpError(400, "Invalid request.");
    const service = authService();
    const login = await service.login(input.data.email, input.data.password, "web");
    const previousSession = request.cookies.get(config.sessionCookie)?.value;
    if (validToken(previousSession)) await service.logout(previousSession);
    const response = jsonResponse({ user: login.user, csrfToken: login.csrfToken });
    response.cookies.set(config.sessionCookie, login.sessionToken, cookieOptions(config, 7200));
    response.cookies.set(config.csrfCookie, login.csrfToken, cookieOptions(config, 7200));
    return response;
  } catch (error) { return errorResponse(error); }
}
