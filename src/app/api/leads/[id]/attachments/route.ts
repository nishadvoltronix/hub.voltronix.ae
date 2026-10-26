import { NextRequest } from "next/server";
import { getDatabase } from "@/server/db";
import { crmQuery } from "@/server/crm-http";
import { createAttachmentsService } from "@/server/attachments/service";
import { attachmentResponse, readAttachment } from "@/server/attachments/http";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export function GET(request: NextRequest, context: Context) {
  return attachmentResponse(request, async (token) => createAttachmentsService(getDatabase()).list(token, (await context.params).id, crmQuery(request, [], ["page", "pageSize"])));
}
export function POST(request: NextRequest, context: Context) {
  return attachmentResponse(request, async (token) => { crmQuery(request, [], []); return readAttachment(request, token, (await context.params).id); }, true);
}
