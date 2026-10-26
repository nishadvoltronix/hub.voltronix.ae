import { z } from "zod";
import { CommercialError, externalIdSchema } from "./validation";

export type CommercialRequest = {
  apiVersion: "v2.1" | "v8";
  method: "GET" | "POST" | "PUT";
  path: string;
  body?: unknown;
};
// Deliberately no HTTP implementation, credential handling, or production host.
export interface CommercialTransport {
  request(request: CommercialRequest): Promise<{ status: number; body: unknown }>;
}
export async function requestContract(transport: CommercialTransport, request: CommercialRequest) {
  try {
    const response = await transport.request(request);
    if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) throw new CommercialError(502);
    return response;
  } catch { throw new CommercialError(502); }
}
const success = z.object({ data: z.tuple([z.object({ code: z.literal("SUCCESS"),
  status: z.literal("success").optional(), details: z.object({ id: externalIdSchema }), })]) });
export function parseWriteId(body: unknown) {
  const parsed = success.safeParse(body);
  if (!parsed.success) throw new CommercialError(502);
  return parsed.data.data[0].details.id;
}
export function parseRecord(body: unknown): Record<string, unknown> {
  const parsed = z.object({ data: z.tuple([z.record(z.string(), z.unknown())]) }).safeParse(body);
  if (!parsed.success) throw new CommercialError(502);
  return parsed.data.data[0];
}
