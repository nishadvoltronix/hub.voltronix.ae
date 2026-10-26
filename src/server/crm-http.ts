import "server-only";
import { NextRequest } from "next/server";
import { authService, errorResponse, jsonResponse, webConfig } from "./web-auth";
import { HttpError, rejectCrossOriginRead, validToken } from "./http-security";
import { DashboardError } from "./dashboard/service";
import { LeadsError } from "./leads/service";

export async function crmRead(request: NextRequest, action: (token: string) => unknown | Promise<unknown>) {
  try {
    const config = webConfig();
    rejectCrossOriginRead(request, config);
    const token = request.cookies.get(config.sessionCookie)?.value;
    if (!validToken(token) || !await authService().authenticate(token)) throw new HttpError(401, "Sign in required.");
    return jsonResponse(await action(token));
  } catch (error) {
    if (error instanceof DashboardError || error instanceof LeadsError) return jsonResponse({ error: error.message }, error.status);
    return errorResponse(error);
  }
}
export function crmQuery(request: NextRequest, textKeys: readonly string[], numberKeys: readonly string[]) {
  const result: Record<string, string | number> = {};
  for (const [key, value] of request.nextUrl.searchParams) {
    if (request.nextUrl.searchParams.getAll(key).length !== 1) throw new HttpError(400, "Invalid query.");
    if (textKeys.includes(key)) result[key] = value;
    else if (numberKeys.includes(key) && /^[1-9][0-9]{0,6}$/.test(value)) result[key] = Number(value);
    else throw new HttpError(400, "Invalid query.");
  }
  return result;
}

