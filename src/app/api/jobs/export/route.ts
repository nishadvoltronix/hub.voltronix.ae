import { NextRequest } from "next/server";
import { exportResponse } from "@/server/exports/http";
export const runtime = "nodejs";
export function GET(request: NextRequest) { return exportResponse(request); }
