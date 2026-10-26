import { LARGE_LOG_ATTACHMENT_LIMIT } from "@voltronix/crm-contracts";
import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { authCookiePolicy } from "../auth/http.js";
import { validToken } from "../auth/tokens.js";
import { AttachmentError, MAX_ATTACHMENT_BYTES, validateContent } from "./attachments/service.js";

export class CrmHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export type CookiePolicy = ReturnType<typeof authCookiePolicy>;
export function selectedCookies(request: Request, policy: CookiePolicy) {
  const selected = new Map<string, string>();
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("="), name = (separator < 0 ? part : part.slice(0, separator)).trim();
    if (name !== policy.sessionCookie && name !== policy.csrfCookie) continue;
    if (separator < 0 || selected.has(name)) throw new CrmHttpError(400, "Invalid request.");
    try { selected.set(name, decodeURIComponent(part.slice(separator + 1))); }
    catch { throw new CrmHttpError(400, "Invalid request."); }
  }
  return { token: selected.get(policy.sessionCookie), csrf: selected.get(policy.csrfCookie) };
}
export function originCheck(request: Request, origin: string, write: boolean) {
  const supplied = request.get("origin"), site = request.get("sec-fetch-site");
  if (write ? supplied !== origin || site === "cross-site" :
    (supplied !== undefined && supplied !== origin) || (site !== undefined && !["same-origin", "none"].includes(site))) {
    throw new CrmHttpError(403, "Request not permitted.");
  }
}
export function csrfChallenge(request: Request, cookie: unknown): string {
  const header = request.get("x-csrf-token");
  if (!validToken(cookie) || !validToken(header) || !timingSafeEqual(Buffer.from(cookie), Buffer.from(header))) {
    throw new CrmHttpError(403, "Request not permitted.");
  }
  return header;
}
export function crmQuery(request: Request, text: readonly string[], numeric: readonly string[]) {
  const params = new URL(request.originalUrl, "http://127.0.0.1").searchParams;
  const result: Record<string, string | number> = {};
  for (const [key, value] of params) {
    if (params.getAll(key).length !== 1) throw new CrmHttpError(400, "Invalid query.");
    if (text.includes(key)) result[key] = value;
    else if (numeric.includes(key) && /^[1-9][0-9]{0,6}$/.test(value)) result[key] = Number(value);
    else throw new CrmHttpError(400, "Invalid query.");
  }
  return result;
}
function absorbLateErrors(request: Request) {
  const ignore = () => {};
  request.on("error", ignore); request.once("close", () => request.off("error", ignore));
}
export function closeUnreadRequest(request: Request, response: Response) {
  if (request.complete) return;
  response.setHeader("Connection", "close");
  absorbLateErrors(request); request.pause();
  response.once("finish", () => request.destroy());
}
export async function readBoundedBody(request: Request, response: Response, maximum: number): Promise<Buffer> {
  const encoding = request.get("content-encoding"), declared = request.get("content-length");
  if (encoding !== undefined && encoding.toLowerCase().trim() !== "identity") throw new CrmHttpError(415, "Unsupported content type.");
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    closeUnreadRequest(request, response); throw new CrmHttpError(413, "Request is too large.");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    function detach() { request.off("data", data); request.off("end", end); request.off("error", fail); request.off("aborted", fail); }
    function fail() { detach(); absorbLateErrors(request); reject(new CrmHttpError(400, "Invalid request.")); }
    function data(chunk: Buffer) {
      size += chunk.byteLength;
      if (size > maximum) { detach(); closeUnreadRequest(request, response); reject(new CrmHttpError(413, "Request is too large.")); }
      else chunks.push(chunk);
    }
    function end() {
      detach();
      if (declared !== undefined && Number(declared) !== size) reject(new CrmHttpError(400, "Invalid request."));
      else resolve(Buffer.concat(chunks));
    }
    request.on("data", data); request.once("end", end); request.once("error", fail); request.once("aborted", fail);
  });
}
export async function readJson(request: Request, response: Response, maximum = 8192): Promise<unknown> {
  if (request.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new CrmHttpError(415, "Use an application/json request.");
  }
  const bytes = await readBoundedBody(request, response, maximum);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new CrmHttpError(400, "Invalid request."); }
}
export async function readMultipart(request: Request, response: Response, metadataBytes = 8192, fileLimit = MAX_ATTACHMENT_BYTES): Promise<FormData> {
  const type = request.get("content-type") ?? "";
  if (!/^multipart\/form-data;\s*boundary=/i.test(type) || type.length > 200) throw new AttachmentError(415);
  const bytes = await readBoundedBody(request, response, fileLimit + metadataBytes);
  try { return await new globalThis.Response(new Uint8Array(bytes), { headers: { "Content-Type": type } }).formData(); }
  catch { throw new AttachmentError(400); }
}
export function hasUnexpectedFields(form: FormData, names: readonly string[]) {
  let unexpected = false;
  form.forEach((_value, key) => { if (!names.includes(key)) unexpected = true; });
  return unexpected;
}
export function sendPrivateFile(response: Response, bytes: Uint8Array, mediaType: string, filename: string, generatedFilename = false) {
  if (generatedFilename && !/^[A-Za-z0-9_-]+\.(?:pdf|xlsx)$/.test(filename)) throw new CrmHttpError(503, "The service is temporarily unavailable.");
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, character => "%" + character.charCodeAt(0).toString(16).toUpperCase());
  response.set({ "Content-Type": mediaType, "Content-Length": String(bytes.length),
    "Content-Disposition": generatedFilename ? `attachment; filename="${filename}"` : `attachment; filename="download"; filename*=UTF-8''${encoded}`,
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'",
    "Cache-Control": "private, no-store", Vary: "Cookie" });
  response.send(Buffer.from(bytes));
}

/** Called only after the ordinary download service rechecks current parent scope
 * and stored size/digest. Revalidate saved content before opting into inline mode;
 * PDFs keep the existing download-only policy because their check is lexical. */
export function sendPrivatePreview(response: Response, file: { name: string; mediaType: string; content: Buffer }, source: "task" | "log" = "task") {
  if (!["image/gif", "image/png", "image/jpeg", "text/csv", ...(source === "task" ? ["text/plain"] : [])].includes(file.mediaType))
    throw new CrmHttpError(415, "Inline preview supports static images and text files only. Use Download for this file.");
  const type = validateContent(file.name, file.mediaType, file.content, source === "log" ? LARGE_LOG_ATTACHMENT_LIMIT : MAX_ATTACHMENT_BYTES);
  const encoded = encodeURIComponent(file.name).replace(/[!'()*]/g, character => "%" + character.charCodeAt(0).toString(16).toUpperCase());
  response.set({ "Content-Type": type.startsWith("text/") ? "text/plain; charset=utf-8" : type,
    "Content-Length": String(file.content.length), "Content-Disposition": `inline; filename="preview"; filename*=UTF-8''${encoded}`,
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'",
    "Cache-Control": "private, no-store", Vary: "Cookie" });
  response.send(file.content);
}
