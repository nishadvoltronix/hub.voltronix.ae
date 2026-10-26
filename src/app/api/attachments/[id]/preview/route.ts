import { NextRequest } from "next/server";
import { getDatabase } from "@/server/db";
import { crmQuery } from "@/server/crm-http";
import { createAttachmentsService } from "@/server/attachments/service";
import { attachmentResponse } from "@/server/attachments/http";
import { privateAttachmentPreview } from "@/server/attachments/preview";
export const runtime = "nodejs";
export function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return attachmentResponse(request, async (token) => {
    crmQuery(request, [], []);
    // Ordinary download authorization and digest checks run for every preview.
    const file = await createAttachmentsService(getDatabase()).download(token, (await context.params).id);
    return privateAttachmentPreview(file);
  });
}
