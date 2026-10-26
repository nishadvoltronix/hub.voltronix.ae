import { NextRequest } from "next/server";
import { leadMutationResponse } from "@/server/lead-mutations/http";
import { crmQuery, crmRead } from "@/server/crm-http";
import { authService } from "@/server/web-auth";
import { HttpError } from "@/server/http-security";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: NextRequest) {
  return crmRead(request, async (token) => {
    const user = await authService().authenticate(token);
    if (!user?.permissions.includes("deals.view")) throw new HttpError(403, "Access denied.");
    crmQuery(request, ["query"], ["page", "pageSize"]);
    // The explicit Express demo composition supplies the source-backed local list.
    throw new HttpError(503, "Created deals are unavailable in this runtime.");
  });
}
export function POST(request: NextRequest) {
  return leadMutationResponse(request, ({ service, token, body }) => service.createDeal(token, body), "deal");
}
