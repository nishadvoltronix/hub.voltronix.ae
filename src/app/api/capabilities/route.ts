import type { NextRequest } from "next/server";
import type { CrmWriteCapabilities } from "@voltronix/crm-contracts";
import { crmQuery, crmRead } from "@/server/crm-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Express owns the guarded SQLite demo. The standalone Next backend never
// infers write permission or integration availability from a browser request.
export function GET(request: NextRequest) {
  return crmRead(request, () => {
    crmQuery(request, [], []);
    return { persistence: "unavailable", productCreate: false, leadNotes: false, localWorkflow: false, dealCreate: false, integrationAvailable: false } satisfies CrmWriteCapabilities;
  });
}
