import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getDatabase } from "../db";
import { authService, errorResponse, jsonResponse, webConfig } from "../web-auth";
import { HttpError, rejectCrossOriginRead, requireCsrf, requireSameOrigin, validToken } from "../http-security";
import { AttachmentError, createAttachmentsService, MAX_ATTACHMENT_BYTES } from "./service";
import { readBoundedMultipart } from "./multipart";
export async function attachmentResponse(request: NextRequest, action: (token: string) => unknown | Promise<unknown>, write = false) {
  try {
    const config = webConfig();
    if (write) requireSameOrigin(request, config); else rejectCrossOriginRead(request, config);
    const token = request.cookies.get(config.sessionCookie)?.value;
    if (!validToken(token) || !await authService().authenticate(token)) throw new HttpError(401, "Sign in required.");
    if (write) {
      const csrf = requireCsrf(request, request.cookies.get(config.csrfCookie)?.value);
      if (!await authService().verifySessionCsrf(token, csrf)) throw new HttpError(403, "Request not permitted.");
    }
    const result = await action(token);
    return result instanceof NextResponse ? result : jsonResponse(result);
  } catch (error) { return error instanceof AttachmentError ? jsonResponse({ error: error.message }, error.status) : errorResponse(error); }
}
export async function readAttachment(request: NextRequest, token: string, taskId: string) {
  await createAttachmentsService(getDatabase()).authorizeUpload(token, taskId);
  const form = await readBoundedMultipart(request);
  if ([...form.keys()].some((key) => !["file", "expectedVersion"].includes(key)) || form.getAll("file").length !== 1 || form.getAll("expectedVersion").length !== 1) throw new AttachmentError(400);
  const file = form.get("file"), version = form.get("expectedVersion");
  if (!(file instanceof File) || typeof version !== "string" || !/^[1-9][0-9]{0,15}$/.test(version)) throw new AttachmentError(400);
  if (file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentError(413);
  return createAttachmentsService(getDatabase()).upload(token, taskId, { expectedVersion: Number(version), name: file.name, mediaType: file.type }, Buffer.from(await file.arrayBuffer()));
}
