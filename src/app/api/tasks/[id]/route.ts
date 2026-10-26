import { NextRequest } from "next/server";
import { authService, errorResponse, jsonResponse, webConfig } from "@/server/web-auth";
import { HttpError, validToken } from "@/server/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const session = request.cookies.get(webConfig().sessionCookie)?.value;
    if (!validToken(session)) throw new HttpError(401, "Authentication required.");
    const { id } = await context.params;
    return jsonResponse({ task: await authService().getAuthorizedTask(session, id) });
  } catch (error) { return errorResponse(error); }
}
