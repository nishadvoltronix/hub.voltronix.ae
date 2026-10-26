import { NextRequest } from "next/server";
import { leadMutationResponse } from "@/server/lead-mutations/http";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; noteId: string }> };
export function PATCH(request: NextRequest, context: Context) {
  return leadMutationResponse(request, async ({ service, token, body }) => {
    const { id, noteId } = await context.params;
    return service.editNote(token, id, noteId, body);
  }, "lead");
}
