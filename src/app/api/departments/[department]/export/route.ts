import { NextRequest } from "next/server";
import { exportResponse } from "@/server/exports/http";
export const runtime = "nodejs";
export async function GET(request: NextRequest, context: { params: Promise<{ department: string }> }) { return exportResponse(request, (await context.params).department); }
