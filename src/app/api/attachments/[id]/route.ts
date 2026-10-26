import { NextRequest, NextResponse } from "next/server";
import { getDatabase } from "@/server/db";
import { crmQuery } from "@/server/crm-http";
import { createAttachmentsService } from "@/server/attachments/service";
import { attachmentResponse } from "@/server/attachments/http";
export const runtime = "nodejs";
export function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return attachmentResponse(request, async (token) => {
    crmQuery(request, [], []);
    const file = await createAttachmentsService(getDatabase()).download(token, (await context.params).id);
    const name = encodeURIComponent(file.name).replace(/[!'()*]/g, (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase());
    return new NextResponse(new Uint8Array(file.content), { headers: {
      "Content-Type": file.mediaType, "Content-Length": String(file.size), "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${name}`,
      "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'", "Cache-Control": "private, no-store", Vary: "Cookie",
    } });
  });
}
