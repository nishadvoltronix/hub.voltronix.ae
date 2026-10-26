import { z } from "zod";
import { createZohoClient, type ZohoClientDependencies } from "./client.js";
import { readZohoInboundChanges } from "./inbound-sync-reader.js";
import { ZohoInboundSyncError, zohoInboundReadInputSchema, type ZohoInboundChangesInput, type ZohoInboundChangeSet } from "./inbound-sync-contracts.js";

const secret = z.string().regex(/^[A-Za-z0-9._~-]{1,4096}$/);
const configuration = z.object({ credentials: z.object({ clientId: secret, clientSecret: secret, refreshToken: secret }).strict(),
  organizationId: z.string().regex(/^[1-9][0-9]{0,29}$/) }).strict();
export type ZohoInboundSourceConfiguration = z.infer<typeof configuration>;
export interface ZohoInboundSource {
  readChanges(input: ZohoInboundChangesInput, signal?: AbortSignal): Promise<ZohoInboundChangeSet>;
  readiness(): Promise<void>;
  close(): void;
}
/** Separate production read-only client. No environment loading, writer
 * authority, imports, DB mutation, timer or notification registration. */
export async function openZohoInboundSource(input: ZohoInboundSourceConfiguration,
  dependencies: ZohoClientDependencies = {}): Promise<ZohoInboundSource> {
  const parsedConfig = configuration.safeParse(input); if (!parsedConfig.success) throw new ZohoInboundSyncError("INPUT_INVALID");
  const config = parsedConfig.data;
  let closed = false, reading = false, passSignal: AbortSignal | undefined;
  const lifetime = new AbortController(), send = dependencies.fetch ?? fetch;
  const { productionAuthority: _unused, ...readDependencies } = dependencies; void _unused;
  const client = createZohoClient({ ...config.credentials, organizationId: config.organizationId, environment: "production", allowWrites: false },
    { ...readDependencies, fetch: (url, init) => send(url, { ...init,
      signal: AbortSignal.any([lifetime.signal, ...(init?.signal ? [init.signal] : []), ...(passSignal ? [passSignal] : [])]) }) });
  function close() { if (closed) return; closed = true; lifetime.abort(); client.close(); }
  async function readiness() {
    if (closed) throw new ZohoInboundSyncError("ABORTED");
    try {
      const reply = await client.request({ apiVersion: "v8", method: "GET", path: "/org" });
      const parsed = z.object({ org: z.tuple([z.object({ id: z.literal(config.organizationId), type: z.literal("production") })]),
        error: z.never().optional(), code: z.never().optional() }).safeParse(reply.body);
      if (reply.status !== 200 || !parsed.success) throw new ZohoInboundSyncError("ORGANIZATION_MISMATCH");
    } catch (error) { throw error instanceof ZohoInboundSyncError ? error : new ZohoInboundSyncError("REQUEST_FAILED"); }
  }
  try { await readiness(); } catch (error) { close(); throw error; }
  return Object.freeze({ readiness, close, async readChanges(value: ZohoInboundChangesInput, signal?: AbortSignal) {
    if (closed || signal?.aborted) throw new ZohoInboundSyncError("ABORTED");
    const selected = zohoInboundReadInputSchema.safeParse(value);
    if (reading || !selected.success || selected.data.organizationId !== config.organizationId || signal !== undefined && !(signal instanceof AbortSignal)) throw new ZohoInboundSyncError("INPUT_INVALID");
    reading = true; passSignal = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
    try { return await readZohoInboundChanges(client, value, passSignal); }
    finally { reading = false; passSignal = undefined; }
  } });
}
