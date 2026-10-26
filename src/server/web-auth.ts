import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getDatabase } from "./db";
import { AuthError, createAuthService } from "./auth/service";
import { parseWebConfig } from "./config/web";
import { HttpError, validToken } from "./http-security";

export function authService() { return createAuthService(getDatabase()); }
export function webConfig() { return parseWebConfig(process.env); }

export async function currentUser() {
  const token = (await cookies()).get(webConfig().sessionCookie)?.value;
  if (!validToken(token)) return null;
  return authService().authenticate(token);
}

export function jsonResponse(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { "Cache-Control": "no-store", Vary: "Cookie" } });
}

export function errorResponse(error: unknown) {
  if (error instanceof HttpError || error instanceof AuthError) {
    const response = jsonResponse({ error: error.message }, error.status);
    if (error.status === 429) response.headers.set("Retry-After", "900");
    return response;
  }
  // Never serialize a database, configuration, hash or driver error to the browser.
  return jsonResponse({ error: "The service is temporarily unavailable." }, 503);
}
