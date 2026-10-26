import { API_IDENTITY_PATH, API_SERVICE_ID, API_V1_PREFIX, LARGE_LOG_ATTACHMENT_LIMIT, logAttachmentLimit, type AuthUser } from "@voltronix/crm-contracts";
import { frontendBackend, type FrontendBackend } from "./config/frontend-backend";
import { parseWebConfig, type WebConfig } from "./config/web";

type ExpressTarget = Extract<FrontendBackend, { mode: "express" }>;
type Fetcher = typeof fetch;
const uploadLimit = 16_384_000 + 32_768;
const responseLimit = 20 * 1024 * 1024;
const forwardedHeaders = ["content-type", "content-encoding", "origin", "sec-fetch-site", "x-csrf-token"];
const responseHeaders = ["content-type", "content-disposition", "content-security-policy", "retry-after", "allow"];

export class ExpressReadError extends Error {
  constructor(readonly status: number) { super("The service is temporarily unavailable."); }
}

/** Fixed trusted origin plus an API-only path. User input can never select a host. */
export function expressUrl(target: ExpressTarget, input: string): string {
  if (!/^\/api\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\?[^#\\\r\n]*)?$/.test(input)
    || input.length > 8192) throw new ExpressReadError(400);
  const path = input.startsWith(`${API_V1_PREFIX}/`) ? input : `${API_V1_PREFIX}/${input.slice(5)}`;
  return target.origin + path;
}

/** Retain duplicate selected cookies so Express can reject ambiguity. */
function authCookieHeader(value: string | null, policy: WebConfig): string | null {
  if (value === null) return null;
  if (value.length > 8192 || /[\r\n\0]/.test(value)) throw new ExpressReadError(400);
  return value.split(";").map(pair => pair.trim()).filter(pair => {
    const separator = pair.indexOf("="), name = (separator < 0 ? pair : pair.slice(0, separator)).trim();
    return name === policy.sessionCookie || name === policy.csrfCookie;
  }).join("; ") || null;
}

function safeCookie(value: string, policy: WebConfig): boolean {
  const parts = value.split(";").map(part => part.trim());
  const [name, token, extra] = (parts[0] ?? "").split("=");
  if ((name !== policy.sessionCookie && name !== policy.csrfCookie) || extra !== undefined
    || token === undefined || !/^[A-Za-z0-9_-]*$/.test(token)) return false;
  const attributes = new Map<string, string>();
  for (const part of parts.slice(1)) {
    if (!/^(?:HttpOnly|Secure|Path=\/|SameSite=Lax|Max-Age=\d+|Expires=[\w ,:-]+)$/i.test(part)) return false;
    const key = part.split("=", 1)[0]!.toLowerCase();
    if (attributes.has(key)) return false;
    attributes.set(key, part);
  }
  return attributes.has("httponly") && attributes.has("samesite") && attributes.has("path")
    && attributes.has("secure") === policy.secureCookies;
}

async function boundedBytes(response: Response, maximum = responseLimit): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new ExpressReadError(503); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function unavailable(status = 503): Response {
  const error = status === 413 ? "Request is too large." : status === 400 ? "Invalid request." : "The service is temporarily unavailable.";
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store", Vary: "Cookie" } });
}

/** Detect accidental cross-service routing before sending browser credentials or body.
 * Recheck every request; a public identity is not proof against a malicious service. */
async function verifyExpressIdentity(target: ExpressTarget, requestSignal: AbortSignal, fetcher: Fetcher): Promise<void> {
  if (target.instanceId === undefined) return; // Retained explicit local-development compatibility.
  const response = await fetcher(target.origin + API_IDENTITY_PATH, {
    method: "GET", headers: { accept: "application/json" }, credentials: "omit", redirect: "error", cache: "no-store",
    signal: AbortSignal.any([requestSignal, AbortSignal.timeout(2_000)]),
  });
  if (response.status !== 200 || response.headers.has("set-cookie")
    || response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    await response.body?.cancel(); throw new ExpressReadError(503);
  }
  const identity: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedBytes(response, 4096)));
  if (identity === null || typeof identity !== "object" || Array.isArray(identity)) throw new ExpressReadError(503);
  const fields = identity as Record<string, unknown>;
  if (Object.keys(fields).sort().join(",") !== "appOrigin,instanceId,service"
    || fields.service !== API_SERVICE_ID || fields.instanceId !== target.instanceId || fields.appOrigin !== target.appOrigin) {
    throw new ExpressReadError(503);
  }
}

/** No fallback on any error. Injected fetch is for offline tests, never a runtime mock store. */
export async function forwardToExpress(request: Request, environment: Record<string, string | undefined>, fetcher: Fetcher = fetch): Promise<Response> {
  let tooLarge = false;
  try {
    const target = frontendBackend(environment);
    if (target.mode !== "express") throw new ExpressReadError(503);
    const policy = parseWebConfig({ APP_ORIGIN: target.appOrigin });
    const url = new URL(request.url);
    const destination = expressUrl(target, url.pathname + url.search);
    await verifyExpressIdentity(target, request.signal, fetcher);
    const logUpload = /^\/api\/(?:v1\/)?departments\/([^/]+)\/jobs\/[^/]+\/logs$/.exec(url.pathname);
    const requestLimit = logUpload ? logAttachmentLimit(logUpload[1]!) + 32_768 : uploadLimit;
    const privateLogFile = /^\/api\/(?:v1\/)?log-attachments\/[^/]+(?:\/preview)?$/.test(url.pathname);
    const headers = new Headers();
    for (const name of forwardedHeaders) {
      const value = request.headers.get(name); if (value !== null) headers.set(name, value);
    }
    const cookie = authCookieHeader(request.headers.get("cookie"), policy); if (cookie !== null) headers.set("cookie", cookie);
    const length = request.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > requestLimit)) return unavailable(413);
    let body: ReadableStream<Uint8Array> | undefined;
    if (request.body !== null) {
      let size = 0;
      body = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > requestLimit) { tooLarge = true; throw new ExpressReadError(413); }
        controller.enqueue(chunk);
      } }));
    }
    // Preserve actual browser Origin/CSRF; no spoofed forwarded-host/IP headers.
    // Stream through to backend authorization instead of buffering uploads first.
    const init: RequestInit & { duplex?: "half" } = { method: request.method, headers,
      cache: "no-store", redirect: "manual", signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]) };
    if (body) { init.body = body; init.duplex = "half"; }
    const response = await fetcher(destination, init);
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return unavailable(); }
    const resultHeaders = new Headers({ "Cache-Control": "no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" });
    if (response.headers.get("cache-control")?.split(",").some(value => value.trim() === "private")) resultHeaders.set("Cache-Control", "private, no-store");
    for (const name of responseHeaders) {
      const value = response.headers.get(name); if (value !== null) resultHeaders.set(name, value);
    }
    for (const value of response.headers.getSetCookie()) {
      if (!safeCookie(value, policy)) { await response.body?.cancel(); return unavailable(); }
      resultHeaders.append("set-cookie", value);
    }
    const bytes = await boundedBytes(response, privateLogFile ? LARGE_LOG_ATTACHMENT_LIMIT : responseLimit);
    return new Response(request.method === "HEAD" || [204, 205, 304].includes(response.status) ? null : bytes,
      { status: response.status, headers: resultHeaders });
  } catch (error) {
    return unavailable(tooLarge ? 413 : error instanceof ExpressReadError ? error.status : 503);
  }
}

/** SSR performs only reads; cookies are forwarded but never logged or persisted here. */
export async function readExpress<T>(path: string, cookie: string, environment: Record<string, string | undefined>, fetcher: Fetcher = fetch): Promise<T> {
  const target = frontendBackend(environment);
  if (target.mode !== "express") throw new ExpressReadError(503);
  const response = await forwardToExpress(new Request(target.appOrigin + path, { headers: { cookie, origin: target.appOrigin } }), environment, fetcher);
  if (!response.ok) throw new ExpressReadError(response.status);
  if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new ExpressReadError(503);
  try { return await response.json() as T; } catch { throw new ExpressReadError(503); }
}

export function isAuthUser(value: unknown): value is AuthUser {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const user = value as Record<string, unknown>;
  return typeof user.localUserId === "string" && /^[1-9][0-9]{0,18}$/.test(user.localUserId)
    && (user.externalUserId === null || typeof user.externalUserId === "string")
    && typeof user.username === "string" && typeof user.email === "string"
    && Array.isArray(user.permissions) && user.permissions.every(key => typeof key === "string")
    && Object.keys(user).sort().join(",") === "email,externalUserId,localUserId,permissions,username";
}
