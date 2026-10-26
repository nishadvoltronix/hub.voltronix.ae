import { NextResponse, type NextRequest } from "next/server";
import { frontendBackend } from "./server/config/frontend-backend";
import { forwardToExpress } from "./server/express-bridge";

/** Explicit API selection. All Express API paths use one backend; failures never enter old handlers. */
export async function proxy(request: NextRequest) {
  try {
    if (frontendBackend(process.env).mode === "nextjs") return NextResponse.next();
    return forwardToExpress(request, process.env);
  } catch {
    return NextResponse.json({ error: "The service is temporarily unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store", Vary: "Cookie" } });
  }
}

export const config = { matcher: "/api/:path*" };
