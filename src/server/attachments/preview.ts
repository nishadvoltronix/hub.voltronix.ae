import { LARGE_LOG_ATTACHMENT_LIMIT, TASK_ATTACHMENT_LIMIT } from "@voltronix/crm-contracts";
import { NextResponse } from "next/server";
import { HttpError } from "../http-security";
import { validateContent } from "./service";

/** Accept only a file returned by the normal authenticated download service.
 * Content is checked again for inline rendering; original bytes are not changed. */
export function privateAttachmentPreview(file: { name: string; mediaType: string; size: number; content: Buffer }, source: "task" | "log" = "task") {
  if (!["image/gif", "image/png", "image/jpeg", "text/csv", ...(source === "task" ? ["text/plain"] : [])].includes(file.mediaType))
    throw new HttpError(415, "Inline preview supports static images and text files only. Use Download for this file.");
  const type = validateContent(file.name, file.mediaType, file.content, source === "log" ? LARGE_LOG_ATTACHMENT_LIMIT : TASK_ATTACHMENT_LIMIT);
  const name = encodeURIComponent(file.name).replace(/[!'()*]/g, (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase());
  return new NextResponse(new Uint8Array(file.content), { headers: {
    "Content-Type": type.startsWith("text/") ? "text/plain; charset=utf-8" : type,
    "Content-Length": String(file.size), "Content-Disposition": `inline; filename="preview"; filename*=UTF-8''${name}`,
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'", "Cache-Control": "private, no-store", Vary: "Cookie",
  } });
}
