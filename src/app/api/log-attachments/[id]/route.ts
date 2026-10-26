import { NextRequest, NextResponse } from "next/server";
import { departmentResponse } from "@/server/departments/http";
import { crmQuery } from "@/server/crm-http";
export const runtime = "nodejs";
export function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return departmentResponse(request, async ({ token, service }) => {
    crmQuery(request, [], []);
    const file = await service.downloadLogAttachment(token, (await context.params).id);
    const name = encodeURIComponent(file.name).replace(/[!'()*]/g, (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase());
    return new NextResponse(new Uint8Array(file.content), { headers: {
      "Content-Type": file.mediaType, "Content-Length": String(file.size), "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${name}`,
      "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'", "Cache-Control": "private, no-store", Vary: "Cookie",
    } });
  });
}
