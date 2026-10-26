import { NextRequest } from "next/server";
import { authService, errorResponse, jsonResponse, webConfig } from "@/server/web-auth";
import { HttpError, validToken } from "@/server/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const session = request.cookies.get(webConfig().sessionCookie)?.value;
    if (!validToken(session)) throw new HttpError(401, "Authentication required.");
    const user = await authService().authenticate(session);
    if (!user) throw new HttpError(401, "Authentication required.");
    return jsonResponse({ user });
  } catch (error) { return errorResponse(error); }
}
