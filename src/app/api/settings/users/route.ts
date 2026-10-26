import { NextRequest } from "next/server";
import { settingsResponse, settingsQuery, USER_SETTINGS_PERMISSIONS } from "@/server/settings-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: NextRequest) {
  return settingsResponse(request, USER_SETTINGS_PERMISSIONS, ({ service, token }) => service.listUsers(token, settingsQuery(request)));
}
export function POST(request: NextRequest) {
  return settingsResponse(request, USER_SETTINGS_PERMISSIONS, ({ service, token, body }) => service.createUser(token, body), true, 201);
}

