import "server-only";
import { NextRequest } from "next/server";
import { createSettingsService, SettingsError } from "./settings/service";
import { getDatabase } from "./db";
import { requirePermission, type AuthUser } from "./auth/service";
import type { PermissionKey } from "./auth/permissions";
import { authService, errorResponse, jsonResponse, webConfig } from "./web-auth";
import { HttpError, readJson, requireCsrf, requireSameOrigin, validToken } from "./http-security";

export const USER_SETTINGS_PERMISSIONS = ["users.write", "permissions.manage"] as const;
export const CATALOG_PERMISSIONS = ["permissions.manage"] as const;
type Context = { service: ReturnType<typeof createSettingsService>; token: string; body: unknown; user: AuthUser };
export async function settingsResponse(
  request: NextRequest,
  permissions: readonly PermissionKey[],
  action: (context: Context) => unknown | Promise<unknown>,
  write = false,
  status = 200,
) {
  try {
    const config = webConfig();
    if (write) requireSameOrigin(request, config);
    const token = request.cookies.get(config.sessionCookie)?.value;
    if (!validToken(token)) throw new HttpError(401, "Sign in required.");
    const auth = authService();
    const user = await auth.authenticate(token);
    if (!user) throw new HttpError(401, "Sign in required.");
    for (const permission of permissions) requirePermission(user, permission);
    if (write) {
      const csrf = requireCsrf(request, request.cookies.get(config.csrfCookie)?.value);
      if (!await auth.verifySessionCsrf(token, csrf)) throw new HttpError(403, "Request not permitted.");
    }
    const body = write ? await readJson(request) : undefined;
    return jsonResponse(await action({ service: createSettingsService(getDatabase()), token, body, user }), status);
  } catch (error) {
    return error instanceof SettingsError ? jsonResponse({ error: error.message }, error.status) : errorResponse(error);
  }
}

export function settingsQuery(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  for (const key of params.keys()) {
    if (!["query", "page", "pageSize"].includes(key) || params.getAll(key).length !== 1) {
      throw new HttpError(400, "Invalid search parameters.");
    }
  }
  function integer(key: string) {
    const value = params.get(key);
    if (value === null) return undefined;
    if (!/^[1-9][0-9]{0,6}$/.test(value)) throw new HttpError(400, "Invalid search parameters.");
    return Number(value);
  }
  return { query: params.get("query") ?? undefined, page: integer("page"), pageSize: integer("pageSize") };
}

