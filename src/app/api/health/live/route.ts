export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Process liveness only. This is not database readiness or CRM feature availability.
export function GET() {
  return Response.json({ status: "running" }, {
    headers: { "Cache-Control": "no-store" },
  });
}
