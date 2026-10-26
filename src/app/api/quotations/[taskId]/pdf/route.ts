import { NextRequest } from "next/server";
import { quotationPdfResponse } from "@/server/quotation-pdf/http";
export const runtime = "nodejs";
export async function GET(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  return quotationPdfResponse(request, (await context.params).taskId);
}
