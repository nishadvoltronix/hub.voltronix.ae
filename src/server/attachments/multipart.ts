import type { NextRequest } from "next/server";
import { AttachmentError, MAX_ATTACHMENT_BYTES } from "./service";

/** Bounded streaming read; never trusts multipart Content-Length alone. */
export async function readBoundedMultipart(request: NextRequest, metadataBytes = 8192, fileLimit = MAX_ATTACHMENT_BYTES): Promise<FormData> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data;\s*boundary=/i.test(type) || type.length > 200) throw new AttachmentError(415);
  const maximum = fileLimit + metadataBytes;
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new AttachmentError(413);
  const reader = request.body?.getReader(); if (!reader) throw new AttachmentError(400);
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength;
      if (length > maximum) { await reader.cancel(); throw new AttachmentError(413); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  try { return await new Response(Buffer.concat(chunks), { headers: { "Content-Type": type } }).formData(); }
  catch { throw new AttachmentError(400); }
}
