import { NextRequest } from "next/server";
import { settingsResponse, settingsQuery, CATALOG_PERMISSIONS } from "@/server/settings-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: NextRequest) {
  return settingsResponse(request, CATALOG_PERMISSIONS, ({ service, token }) => service.listGroups(token, settingsQuery(request)));
}
export function POST(request: NextRequest) {
  return settingsResponse(request, CATALOG_PERMISSIONS, ({ service, token, body }) => service.createGroup(token, body), true, 201);
}

