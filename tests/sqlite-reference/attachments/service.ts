import { validateClassicPdf } from "./pdf";
import { hasSpreadsheetFormula } from "./csv";
import { createHash, randomUUID } from "node:crypto";
import { crc32 } from "node:zlib";
import type { Database } from "better-sqlite3";
import { z } from "zod";
import { createAuthService, type AuthUser } from "../auth/service";
import { DEPARTMENT_PERMISSIONS } from "../auth/permissions";
import { validateStaticGif } from "./gif";
import { TASK_ATTACHMENT_LIMIT } from "@voltronix/crm-contracts";
import { validateBmp, validateWebp, validateZip, validateCompoundOffice, validateRar, validateSevenZip } from "./binary-formats";
export const MAX_ATTACHMENT_BYTES = TASK_ATTACHMENT_LIMIT;
export interface Attachment { id: string; name: string; mediaType: string; size: number; createdAt: string }
export class AttachmentError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 503) {
    super(({ 400: "Invalid attachment request.", 401: "Sign in required.", 403: "Access denied.", 404: "Attachment or record not found.",
      409: "The record changed. Reload it and try again.", 413: "The attachment is too large.", 415: "The file type or content is not supported.", 503: "Attachments are temporarily unavailable." })[status]);
  }
}
const identifier = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n);
const page = z.object({ page: z.number().int().min(1).max(1_000_000).default(1), pageSize: z.number().int().min(1).max(100).default(25) }).strict();
const meta = z.object({ expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), name: z.string().min(1).max(120), mediaType: z.string().max(120) }).strict();
const projection = "id,file_name AS name,media_type AS mediaType,file_size AS size,created_at AS createdAt";
function validatePng(bytes: Buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(signature)) throw new AttachmentError(415);
  let offset = 8, chunks = 0, dataSeen = false, dataEnded = false;
  while (offset + 12 <= bytes.length) {
    if (++chunks > 10_000) throw new AttachmentError(415);
    const length = bytes.readUInt32BE(offset), type = bytes.toString("latin1", offset + 4, offset + 8);
    const end = offset + length + 12;
    if (end > bytes.length || !/^[A-Za-z]{4}$/.test(type)
      || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new AttachmentError(415);
    if (chunks === 1) {
      if (type !== "IHDR" || length !== 13) throw new AttachmentError(415);
      const width = bytes.readUInt32BE(offset + 8), height = bytes.readUInt32BE(offset + 12);
      const bitDepth = bytes[offset + 16]!, color = bytes[offset + 17]!;
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width * height > 40_000_000 || !depths[color]?.includes(bitDepth)
        || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || ![0, 1].includes(bytes[offset + 20]!)) throw new AttachmentError(415);
    } else if (type === "IHDR") throw new AttachmentError(415);
    if (type === "IDAT") { if (dataEnded || length === 0) throw new AttachmentError(415); dataSeen = true; }
    else if (dataSeen) dataEnded = true;
    if (type === "IEND") {
      if (length !== 0 || end !== bytes.length || !dataSeen) throw new AttachmentError(415);
      return;
    }
    // Unknown critical chunks and animation/extensions need a reviewed decoder path.
    if (!["IHDR", "PLTE", "IDAT", "IEND"].includes(type) && type[0] === type[0]?.toUpperCase()) throw new AttachmentError(415);
    if (["acTL", "fcTL", "fdAT"].includes(type)) throw new AttachmentError(415);
    offset = end;
  }
  throw new AttachmentError(415);
}
function validateJpeg(bytes: Buffer) {
  if (bytes.length < 20 || bytes[0] !== 255 || bytes[1] !== 216) throw new AttachmentError(415);
  let offset = 2, frame = false, scan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 255) throw new AttachmentError(415);
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 217) { if (offset === bytes.length && frame && scan) return; throw new AttachmentError(415); }
    if (marker === undefined || marker === 0 || marker === 216 || (marker >= 208 && marker <= 215) || offset + 2 > bytes.length) throw new AttachmentError(415);
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw new AttachmentError(415);
    if ([192, 193, 194].includes(marker)) {
      if (frame || length < 11) throw new AttachmentError(415);
      const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5), components = bytes[offset + 7]!;
      if (bytes[offset + 2] !== 8 || !width || !height || width * height > 40_000_000 || components < 1 || components > 4
        || length !== 8 + components * 3) throw new AttachmentError(415);
      frame = true;
    }
    offset += length;
    if (marker === 218) {
      if (!frame || length < 6) throw new AttachmentError(415);
      scan = true;
      while (offset < bytes.length) {
        if (bytes[offset] !== 255) { offset++; continue; }
        const next = bytes[offset + 1];
        if (next === 0 || (next !== undefined && next >= 208 && next <= 215)) { offset += 2; continue; }
        break;
      }
    }
  }
  throw new AttachmentError(415);
}
/** Source-listed formats; active document/archive types remain download-only. */
export function validateContent(name: string, declared: string, bytes: Buffer, maximum = MAX_ATTACHMENT_BYTES): string {
  if (!bytes.length) throw new AttachmentError(400);
  if (bytes.length > maximum) throw new AttachmentError(413);
  if (name === "." || name === ".." || !name.isWellFormed() || /[<>:"/\\|?*\u202A-\u202E\u2066-\u2069]/.test(name) || name.endsWith(".") || name.trim() !== name ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ||
      [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new AttachmentError(400);
  const extension = name.split(".").at(-1)?.toLowerCase();
  const types: Record<string, string> = { gif: "image/gif", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", pdf: "application/pdf", txt: "text/plain", csv: "text/csv", webp: "image/webp", bmp: "image/bmp", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", zip: "application/zip", rar: "application/vnd.rar", "7z": "application/x-7z-compressed" };
  const type = types[extension ?? ""];
  const aliases: Record<string, string[]> = { csv: ["application/vnd.ms-excel"], bmp: ["image/x-ms-bmp"], zip: ["application/x-zip-compressed"], rar: ["application/x-rar-compressed", "application/x-rar"] };
  const binary = ["webp", "bmp", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip", "rar", "7z"].includes(extension ?? "");
  if (!type || (declared !== type && !aliases[extension ?? ""]?.includes(declared) && !(binary && ["", "application/octet-stream"].includes(declared)))) throw new AttachmentError(415);
  if (binary) {
    try {
      if (extension === "webp") validateWebp(bytes);
      else if (extension === "bmp") validateBmp(bytes);
      else if (extension === "zip") validateZip(bytes);
      else if (extension === "docx" || extension === "xlsx" || extension === "pptx") validateZip(bytes, extension);
      else if (extension === "doc" || extension === "xls" || extension === "ppt") validateCompoundOffice(bytes, extension);
      else if (extension === "rar") validateRar(bytes);
      else if (extension === "7z") validateSevenZip(bytes);
    } catch { throw new AttachmentError(415); }
    return type;
  }
  if (type === "image/gif") {
    try { validateStaticGif(bytes); } catch { throw new AttachmentError(415); }
  } else if (type === "image/png") {
    validatePng(bytes);
  } else if (type === "image/jpeg") {
    validateJpeg(bytes);
  } else if (type === "application/pdf") {
    const text = bytes.toString("latin1");
    const decodedNames = text.replace(/#[0-9a-f]{2}/gi, (escape) => String.fromCharCode(parseInt(escape.slice(1), 16)));
    if (!/^%PDF-1\.[0-7][\r\n]/.test(text) || !/%%EOF\s*$/.test(text) || !/\bstartxref\s+\d+\s+%%EOF\s*$/.test(text)
      || !/\/Type\s*\/Catalog\b/.test(decodedNames) || !/\/Type\s*\/Pages\b/.test(decodedNames)
      // Reject action entry points as well as known action types: a denylist of
      // JavaScript/Launch alone admits named actions and future action subtypes.
      // PDF names are case-sensitive (/A and /a differ); hex escapes are decoded.
      // Legacy accepts retain this lexical profile; former refusals must pass a
      // bounded classic-xref grammar. Neither profile certifies malware-free content.
      || /\/(A|AA|Action|OpenAction|PA|JavaScript|JS|Launch|GoTo|GoToR|GoToE|GoTo3DView|Named|ResetForm|SubmitForm|ImportData|URI|Rendition|Movie|Sound|Screen|Hide|SetOCGState|Thread|Trans|EmbeddedFile|EmbeddedFiles|Filespec|FileAttachment|EF|AF|Collection|RichMedia|3D|AcroForm|XFA|Encrypt|ObjStm)\b/.test(decodedNames)) {
      try { validateClassicPdf(bytes); } catch { throw new AttachmentError(415); }
    }
  } else {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new AttachmentError(415); }
    for (const character of text) if (character.charCodeAt(0) < 32 && ![9, 10, 13].includes(character.charCodeAt(0))) throw new AttachmentError(415);
    // Imported CSV is downloaded as an attachment; do not admit cells that spreadsheet
    // applications may execute as formulas. Conservative rejection, never data rewriting.
    if (type === "text/csv" && hasSpreadsheetFormula(text)) throw new AttachmentError(415);
  }
  return type;
}
export function createAttachmentsService(db: Database, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const auth = createAuthService(db, { now });
  function actor(token: string | null | undefined) { const user = auth.authenticate(token); if (!user) throw new AttachmentError(401); return user; }
  function parent(user: AuthUser, taskId: string, write = false) {
    if (!identifier.safeParse(taskId).success) throw new AttachmentError(404);
    const task = db.prepare("SELECT status,version FROM tasks WHERE id=?").get(taskId) as { status: string; version: number } | undefined;
    if (!task) throw new AttachmentError(404);
    const manager = user.permissions.includes("dashboard.view") && ["Close to Won", "Closed Won"].includes(task.status);
    const accessible = manager || auth.canAccessTask(user, taskId);
    if (!accessible) throw new AttachmentError(404);
    if (write && !manager && !user.permissions.some((key) => ["leads.manage", "leads.manage.agents"].includes(key)) &&
      !Object.entries(DEPARTMENT_PERMISSIONS).some(([department, key]) => user.permissions.includes(key) && !!db.prepare(`SELECT 1 FROM departments_assign a
        WHERE a.task_id=? AND a.department=? AND a.user_id=? AND a.id=(SELECT MAX(b.id) FROM departments_assign b WHERE b.task_id=a.task_id AND b.department=a.department)`)
        .get(taskId, department, user.localUserId))) throw new AttachmentError(403);
    return task;
  }
  function safe<T>(operation: () => T): T { try { return operation(); } catch (error) { if (error instanceof AttachmentError) throw error; throw new AttachmentError(503); } }
  function authorizeUpload(token: string | null | undefined, taskId: string) { return safe(() => db.transaction(() => { parent(actor(token), taskId, true); })()); }
  function list(token: string | null | undefined, taskId: string, input: unknown = {}) {
    return safe(() => db.transaction(() => {
      const user = actor(token); const task = parent(user, taskId);
      const parsed = page.safeParse(input); if (!parsed.success) throw new AttachmentError(400);
      const { page: current, pageSize } = parsed.data;
      const total = (db.prepare("SELECT COUNT(*) AS n FROM task_attachment WHERE task_id=?").get(taskId) as { n: number }).n;
      const items = db.prepare(`SELECT ${projection} FROM task_attachment WHERE task_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?`).all(taskId, pageSize, (current - 1) * pageSize) as Attachment[];
      let canUpload = true;
      try { parent(user, taskId, true); } catch (error) { if (error instanceof AttachmentError && error.status === 403) canUpload = false; else throw error; }
      return { items, total, page: current, pageSize, version: task.version, canUpload };
    })());
  }
  function upload(token: string | null | undefined, taskId: string, input: unknown, bytes: Buffer) {
    return safe(() => db.transaction(() => {
      const user = actor(token); const task = parent(user, taskId, true);
      const parsed = meta.safeParse(input); if (!parsed.success) throw new AttachmentError(400);
      if (!Buffer.isBuffer(bytes)) throw new AttachmentError(400);
      const value = parsed.data; const mediaType = validateContent(value.name, value.mediaType, bytes);
      if (!Number.isSafeInteger(task.version) || task.version >= Number.MAX_SAFE_INTEGER || task.version !== value.expectedVersion) throw new AttachmentError(409);
      const id = randomUUID(), at = new Date(now()).toISOString();
      db.prepare("INSERT INTO task_attachment(id,task_id,user_id,uploaded_by,file_name,media_type,file_size,content_sha256,content,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(id, taskId, user.externalUserId, user.localUserId, value.name, mediaType, bytes.length, createHash("sha256").update(bytes).digest("hex"), bytes, at);
      db.prepare("UPDATE tasks SET version=version+1,updated_at=? WHERE id=?").run(at, taskId);
      db.prepare("INSERT INTO crm_attachment_audit_events(actor_user_id,task_id,attachment_id,action,occurred_at) VALUES(?,?,?,'attachments.create',?)").run(user.localUserId, taskId, id, at);
      return { id, version: task.version + 1 };
    }).immediate());
  }
  function download(token: string | null | undefined, id: string) {
    return safe(() => db.transaction(() => {
      const user = actor(token); if (!z.uuid().safeParse(id).success) throw new AttachmentError(404);
      const row = db.prepare("SELECT CAST(task_id AS TEXT) AS taskId FROM task_attachment WHERE id=?").get(id) as { taskId: string } | undefined;
      if (!row) throw new AttachmentError(404); parent(user, row.taskId);
      const record = db.prepare(`SELECT ${projection},content,content_sha256 AS digest FROM task_attachment WHERE id=?`).get(id) as Attachment & { content: Buffer; digest: string };
      if (record.content.length !== record.size || createHash("sha256").update(record.content).digest("hex") !== record.digest) throw new AttachmentError(503);
      return { id: record.id, name: record.name, mediaType: record.mediaType, size: record.size, content: record.content };
    })());
  }
  return { authorizeUpload, list, upload, download };
}
