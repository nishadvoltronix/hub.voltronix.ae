import { NextRequest } from "next/server";
import { settingsResponse, USER_SETTINGS_PERMISSIONS } from "@/server/settings-http";
export const runtime = "nodejs";
type Route = { params: Promise<{ id: string }> };
export function PUT(request: NextRequest, context: Route) {
  return settingsResponse(request, USER_SETTINGS_PERMISSIONS, async ({ service, token, body }) => service.assignDepartment(token, (await context.params).id, body), true);
}

