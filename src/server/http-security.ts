import { timingSafeEqual } from "node:crypto";
import type { WebConfig } from "./config/web";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function requireSameOrigin(request: Request, config: WebConfig): void {
  if (request.headers.get("origin") !== config.origin || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new HttpError(403, "Request not permitted.");
  }
}

export function rejectCrossOriginRead(request: Request, config: WebConfig): void {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if ((origin !== null && origin !== config.origin) || (site !== null && site !== "same-origin" && site !== "none")) {
    throw new HttpError(403, "Request not permitted.");
  }
}

export function validToken(value: string | undefined | null): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function requireCsrf(request: Request, cookie: string | undefined): string {
  const header = request.headers.get("x-csrf-token");
  if (!validToken(cookie) || !validToken(header) || !timingSafeEqual(Buffer.from(cookie), Buffer.from(header))) {
    throw new HttpError(403, "Request not permitted.");
  }
  return header;
}

export function cookieOptions(config: WebConfig, maxAge: number) {
  return { httpOnly: true, secure: config.secureCookies, sameSite: "lax" as const, path: "/", maxAge };
}

export async function readJson(request: Request, maximumBytes = 8192): Promise<unknown> {
  // Chosen only by server route code. Existing routes retain their 8 KiB limit.
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 262_144) throw new HttpError(500, "Invalid request configuration.");
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "Use an application/json request.");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumBytes)) {
    throw new HttpError(413, "Request is too large.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Invalid request.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) { await reader.cancel(); throw new HttpError(413, "Request is too large."); }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid request.");
  } finally { reader.releaseLock(); }
}
