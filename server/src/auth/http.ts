import { timingSafeEqual } from "node:crypto";
import { Router, type CookieOptions, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { API_V1_PREFIX, type CsrfResponse, type LoginResponse, type LogoutResponse, type MeResponse } from "@voltronix/crm-contracts";
import { AuthError, authFailure } from "./errors.js";
import type { PermissionKey } from "./permissions.js";
import { SESSION_LIFETIME_MS, type AuthService } from "./service.js";
import { newToken, validToken } from "./tokens.js";

const credentials = z.object({ email: z.string().max(254), password: z.string().max(1024) }).strict();
const MAXIMUM_JSON_BYTES = 8192;

/** Trusted server configuration only. HTTP tests of this policy do not prove TLS. */
export function authCookiePolicy(origin: string) {
  let url: URL;
  try { url = new URL(origin); } catch { throw new AuthError("unavailable"); }
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) throw new AuthError("unavailable");
  const secure = url.protocol === "https:";
  if (!secure && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new AuthError("unavailable");
  const options = { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: SESSION_LIFETIME_MS } satisfies CookieOptions;
  return { origin, sessionCookie: secure ? "__Host-crm_session" : "crm_session",
    csrfCookie: secure ? "__Host-crm_csrf" : "crm_csrf", options };
}
type CookiePolicy = ReturnType<typeof authCookiePolicy>;

/** Reject ambiguous selected auth cookies rather than picking first/last values.
 * Malformed unrelated cookies have no authority and are ignored. A decoded but
 * invalid token keeps the route's normal authentication/CSRF failure semantics.
 */
function authCookies(request: Request, policy: CookiePolicy) {
  const values = new Map<string, string>();
  for (const pair of (request.headers.cookie ?? "").split(";")) {
    const separator = pair.indexOf("=");
    const name = (separator < 0 ? pair : pair.slice(0, separator)).trim();
    if (name !== policy.sessionCookie && name !== policy.csrfCookie) continue;
    if (separator < 0 || values.has(name)) throw new AuthError("invalidRequest");
    try { values.set(name, decodeURIComponent(pair.slice(separator + 1))); }
    catch { throw new AuthError("invalidRequest"); }
  }
  return { session: values.get(policy.sessionCookie), csrf: values.get(policy.csrfCookie) };
}

function requireSameOrigin(request: Request, policy: CookiePolicy): void {
  if (request.get("origin") !== policy.origin || request.get("sec-fetch-site") === "cross-site") throw new AuthError("csrf");
}
function rejectCrossOriginRead(request: Request, policy: CookiePolicy): void {
  const origin = request.get("origin"), site = request.get("sec-fetch-site");
  if ((origin !== undefined && origin !== policy.origin)
    || (site !== undefined && site !== "same-origin" && site !== "none")) throw new AuthError("csrf");
}
function requireCsrf(request: Request, cookie: unknown): string {
  const header = request.get("x-csrf-token");
  if (!validToken(cookie) || !validToken(header)
    || !timingSafeEqual(Buffer.from(cookie), Buffer.from(header))) throw new AuthError("csrf");
  return header;
}

function absorbLateRequestErrors(request: Request): void {
  // An aborted IncomingMessage can emit error after aborted. Never leave that
  // subsequent event unhandled when the bounded reader removes its listeners.
  const ignore = () => {};
  request.on("error", ignore);
  request.once("close", () => request.off("error", ignore));
}
function closeUnreadRequest(request: Request, response: Response): void {
  // Bound rejected uploads without draining arbitrary bytes or destroying the
  // socket before the safe HTTP error can be sent.
  response.setHeader("Connection", "close");
  absorbLateRequestErrors(request);
  response.once("finish", () => request.destroy());
  request.pause();
}
async function readJson(request: Request, response: Response): Promise<unknown> {
  if (request.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new AuthError("contentType");
  }
  const encoding = request.get("content-encoding");
  if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") throw new AuthError("contentType");
  const declaredLength = request.get("content-length");
  if (declaredLength !== undefined && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAXIMUM_JSON_BYTES)) {
    closeUnreadRequest(request, response);
    throw new AuthError("tooLarge");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    function cleanup() {
      request.off("data", data); request.off("end", end);
      request.off("error", failed); request.off("aborted", failed);
    }
    function failed() { cleanup(); absorbLateRequestErrors(request); reject(new AuthError("invalidRequest")); }
    function data(chunk: Buffer) {
      size += chunk.byteLength;
      if (size > MAXIMUM_JSON_BYTES) {
        cleanup(); closeUnreadRequest(request, response); reject(new AuthError("tooLarge"));
      } else chunks.push(chunk);
    }
    function end() {
      cleanup();
      try { resolve(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { reject(new AuthError("invalidRequest")); }
    }
    request.on("data", data); request.once("end", end);
    request.once("error", failed); request.once("aborted", failed);
  });
}

function privateResponse(response: Response): void {
  response.setHeader("Cache-Control", "no-store");
  response.vary("Cookie");
}
function failure(request: Request, response: Response, error: unknown): void {
  if (response.headersSent || response.destroyed || response.writableEnded) return;
  const safe = authFailure(error);
  if (!request.complete) closeUnreadRequest(request, response);
  if (safe.status === 429) response.setHeader("Retry-After", "900");
  response.status(safe.status).json({ error: safe.message });
}
function available(service: AuthService | undefined): AuthService {
  if (!service) throw new AuthError("unavailable");
  return service;
}

/** No runtime store or environment fallback: an uninjected service fails closed. */
export function createAuthRouter(origin: string, service?: AuthService): Router {
  const policy = authCookiePolicy(origin), router = Router({ caseSensitive: true, strict: true });
  function route(name: string, methods: readonly string[], operation: (request: Request, response: Response, auth: AuthService) => Promise<void>) {
    router.all(`${API_V1_PREFIX}/auth/${name}`, async (request, response) => {
      privateResponse(response);
      try {
        const auth = available(service);
        if (!methods.includes(request.method)) {
          response.setHeader("Allow", methods.join(", "));
          throw new AuthError("method");
        }
        await operation(request, response, auth);
      } catch (error) { failure(request, response, error); }
    });
  }
  // HEAD must not invoke this GET's session-CSRF rotation.
  route("csrf", ["GET"], async (request, response, auth) => {
    rejectCrossOriginRead(request, policy);
    const cookies = authCookies(request, policy), csrfToken = newToken();
    if (validToken(cookies.session)) await auth.setSessionCsrf(cookies.session, csrfToken);
    response.cookie(policy.csrfCookie, csrfToken, policy.options);
    response.json({ csrfToken } satisfies CsrfResponse);
  });
  route("login", ["POST"], async (request, response, auth) => {
    requireSameOrigin(request, policy);
    const cookies = authCookies(request, policy);
    requireCsrf(request, cookies.csrf);
    const input = credentials.safeParse(await readJson(request, response));
    if (!input.success) throw new AuthError("invalidRequest");
    const login = await auth.login(input.data.email, input.data.password, cookies.session);
    response.cookie(policy.sessionCookie, login.sessionToken, policy.options);
    response.cookie(policy.csrfCookie, login.csrfToken, policy.options);
    response.json({ user: login.user, csrfToken: login.csrfToken } satisfies LoginResponse);
  });
  route("logout", ["POST"], async (request, response, auth) => {
    requireSameOrigin(request, policy);
    const cookies = authCookies(request, policy), csrf = requireCsrf(request, cookies.csrf);
    if (validToken(cookies.session)) {
      if (await auth.authenticate(cookies.session) && !await auth.verifySessionCsrf(cookies.session, csrf)) throw new AuthError("csrf");
      await auth.logout(cookies.session);
    }
    response.cookie(policy.sessionCookie, "", { ...policy.options, maxAge: 0 });
    response.cookie(policy.csrfCookie, "", { ...policy.options, maxAge: 0 });
    response.json({ signedOut: true } satisfies LogoutResponse);
  });
  route("me", ["GET", "HEAD"], async (request, response, auth) => {
    // Preserve the source read-origin asymmetry; origin is not an identity proof.
    const user = await auth.authenticate(authCookies(request, policy).session);
    if (!user) throw new AuthError("authentication");
    response.json({ user } satisfies MeResponse);
  });
  return router;
}

/** Future protected routes must still load parent/record scope in their own
 * authorized transaction. These helpers do not certify any CRM workflow.
 */
export function requireAuthenticated(service: AuthService | undefined, origin: string): RequestHandler {
  const policy = authCookiePolicy(origin);
  return async (request, response, next) => {
    privateResponse(response);
    try {
      const auth = available(service), user = await auth.authenticate(authCookies(request, policy).session);
      if (!user) throw new AuthError("authentication");
      response.locals.authUser = user;
      next();
    } catch (error) { failure(request, response, error); }
  };
}
export function requirePermissions(service: AuthService | undefined, keys: readonly PermissionKey[], origin: string): RequestHandler {
  const policy = authCookiePolicy(origin);
  return async (request, response, next) => {
    privateResponse(response);
    try {
      const auth = available(service);
      response.locals.authUser = await auth.authorize(authCookies(request, policy).session, keys);
      next();
    } catch (error) { failure(request, response, error); }
  };
}
export function requireSessionMutation(service: AuthService | undefined, origin: string): RequestHandler {
  const policy = authCookiePolicy(origin);
  return async (request, response, next) => {
    privateResponse(response);
    try {
      const auth = available(service);
      requireSameOrigin(request, policy);
      const cookies = authCookies(request, policy), csrf = requireCsrf(request, cookies.csrf);
      const user = await auth.authenticate(cookies.session);
      if (!user) throw new AuthError("authentication");
      if (!await auth.verifySessionCsrf(cookies.session, csrf)) throw new AuthError("csrf");
      response.locals.authUser = user;
      next();
    } catch (error) { failure(request, response, error); }
  };
}
