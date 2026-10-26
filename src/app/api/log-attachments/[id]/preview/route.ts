import { NextRequest } from "next/server";
import { departmentResponse } from "@/server/departments/http";
import { crmQuery } from "@/server/crm-http";
import { privateAttachmentPreview } from "@/server/attachments/preview";
export const runtime = "nodejs";
export function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return departmentResponse(request, async ({ token, service }) => {
    crmQuery(request, [], []);
    // Current grant/assignment and BLOB digest checks are identical to download.
    const file = await service.downloadLogAttachment(token, (await context.params).id);
    return privateAttachmentPreview(file, "log");
  });
}
