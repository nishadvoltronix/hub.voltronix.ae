import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createCommercialService, CommercialPersistenceError } from "../commercial/service";
import { getDatabase } from "../db";
import { crmQuery } from "../crm-http";
import { authService, errorResponse, jsonResponse, webConfig } from "../web-auth";
import { HttpError, rejectCrossOriginRead, validToken } from "../http-security";
import { QuotationPdfError } from "./render";
import { createQuotationPdfService } from "./service";

export async function quotationPdfResponse(request: NextRequest, taskId: string) {
  try {
    const config = webConfig(); rejectCrossOriginRead(request, config);
    const token = request.cookies.get(config.sessionCookie)?.value;
    if (!validToken(token) || !authService().authenticate(token)) throw new HttpError(401, "Sign in required.");
    crmQuery(request, [], []);
    const service = createQuotationPdfService(createCommercialService(getDatabase()));
    const result = await service.download(token, taskId);
    return new NextResponse(new Uint8Array(result.bytes), { headers: {
      "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${result.filename}"`,
      "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'", "Content-Length": String(result.bytes.length),
    } });
  } catch (error) {
    return error instanceof QuotationPdfError || error instanceof CommercialPersistenceError
      ? jsonResponse({ error: error.message }, error.status) : errorResponse(error);
  }
}
