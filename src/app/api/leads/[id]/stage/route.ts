import { NextRequest } from "next/server";
import { leadMutationResponse } from "@/server/lead-mutations/http";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export function PATCH(request: NextRequest, context: Context) {
  return leadMutationResponse(request, async ({ service, token, body }) => service.changeStage(token, (await context.params).id, body), "lead");
}
