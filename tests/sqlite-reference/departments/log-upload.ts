import { logAttachmentLimit } from "@voltronix/crm-contracts";
import type { NextRequest } from "next/server";
import { AttachmentError } from "../attachments/service";
import { readBoundedMultipart } from "../attachments/multipart";

export interface LogMultipart { payload: unknown; file?: { name: string; mediaType: string; content: Buffer } }
export async function readLogMultipart(request: NextRequest, department = "Project_Manager"): Promise<LogMultipart> {
  const form = await readBoundedMultipart(request, 32768, logAttachmentLimit(department));
  if ([...form.keys()].some((key) => !["payload", "file"].includes(key)) || form.getAll("payload").length !== 1 || form.getAll("file").length > 1) throw new AttachmentError(400);
  const payload = form.get("payload"), file = form.get("file");
  if (typeof payload !== "string" || Buffer.byteLength(payload, "utf8") > 30000) throw new AttachmentError(400);
  let parsed: unknown;
  try { parsed = JSON.parse(payload) as unknown; } catch { throw new AttachmentError(400); }
  if (file === null) return { payload: parsed };
  if (!(file instanceof File)) throw new AttachmentError(400);
  if (file.size > logAttachmentLimit(department)) throw new AttachmentError(413);
  // Empty file parts are rejected; a text-only submission must omit the file.
  if (file.size === 0) throw new AttachmentError(400);
  return { payload: parsed, file: { name: file.name, mediaType: file.type, content: Buffer.from(await file.arrayBuffer()) } };
}
