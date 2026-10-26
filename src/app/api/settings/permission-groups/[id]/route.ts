import { NextRequest } from "next/server";
import { settingsResponse, CATALOG_PERMISSIONS } from "@/server/settings-http";
export const runtime = "nodejs";
type Route = { params: Promise<{ id: string }> };
export function GET(request: NextRequest, context: Route) {
  return settingsResponse(request, CATALOG_PERMISSIONS, async ({ service, token }) => service.getGroup(token, (await context.params).id));
}
export function PATCH(request: NextRequest, context: Route) {
  return settingsResponse(request, CATALOG_PERMISSIONS, async ({ service, token, body }) => service.updateGroup(token, (await context.params).id, body), true);
}

