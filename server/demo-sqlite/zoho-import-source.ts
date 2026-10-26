import { z } from "zod";
import { createZohoClient, readBoundedZohoJson, ZohoClientError } from "../src/integrations/zoho/client.js";
import { readZohoInboundSnapshot, safeZohoInboundDiagnostic, ZohoInboundReadError,
  type ZohoInboundDiagnostic } from "../src/integrations/zoho/inbound-snapshot.js";

const secret = z.string().regex(/^[A-Za-z0-9._~-]{1,4096}$/);
const credentialsSchema = z.object({ clientId: secret, clientSecret: secret, refreshToken: secret }).strict();
const sourceCodes = ["CREDENTIALS_INVALID", "TOKEN_INVALID", "ORGANIZATION_MISMATCH", "HTTP_FAILED", "RESPONSE_INVALID", "RESPONSE_TOO_LARGE",
  "TIMEOUT", "REQUEST_FAILED", "CLIENT_FAILED", "UNAVAILABLE", "INBOUND_INPUT_INVALID", "INBOUND_REQUEST_FAILED", "INBOUND_ACCESS_DENIED",
  "INBOUND_RATE_LIMITED", "INBOUND_RESPONSE_INVALID", "INBOUND_PAGINATION_INVALID", "INBOUND_DUPLICATE_RECORD", "INBOUND_PARENT_MISMATCH",
  "INBOUND_LIMIT_EXCEEDED", "INBOUND_SNAPSHOT_INVALID"] as const;
export type LocalZohoSourceCode = typeof sourceCodes[number];
export class LocalZohoSourceError extends Error {
  readonly code: LocalZohoSourceCode;
  readonly diagnostic?: ZohoInboundDiagnostic;
  constructor(code: LocalZohoSourceCode = "UNAVAILABLE", diagnostic?: ZohoInboundDiagnostic) {
    const safeCode = sourceCodes.includes(code) ? code : "UNAVAILABLE";
    super(`Local import source ${safeCode}. No source records were changed.`);
    this.name = "LocalZohoSourceError"; this.code = safeCode;
    const safe = safeZohoInboundDiagnostic(diagnostic); if (safe) this.diagnostic = Object.freeze(safe);
  }
}
function redacted(error: unknown): LocalZohoSourceError {
  try {
    if (error instanceof LocalZohoSourceError) return new LocalZohoSourceError(error.code, error.diagnostic);
    if (error instanceof ZohoInboundReadError) return new LocalZohoSourceError(`INBOUND_${error.code}` as LocalZohoSourceCode, error.diagnostic);
    if (error instanceof ZohoClientError) {
      const code = error.code === "TOKEN_REJECTED" ? "TOKEN_INVALID" : error.code;
      return new LocalZohoSourceError(sourceCodes.includes(code as LocalZohoSourceCode) ? code as LocalZohoSourceCode : "CLIENT_FAILED");
    }
  } catch { /* Never reflect properties of a hostile thrown object. */ }
  return new LocalZohoSourceError("REQUEST_FAILED");
}
function cleanEnvelope(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && ["code", "error", "errors", "status", "message"].every(key => (value as Record<string, unknown>)[key] === undefined);
}
/** Explicit first-use binding to the owner's selected VOLTRONIX production grant.
 * This is not an independently verified production runtime deployment approval.
 * The saved snapshot and SQLite extension pin the observed org for later runs. */
export async function captureLocalZohoSource(input: z.infer<typeof credentialsSchema>, request: typeof fetch = fetch) {
  let client: ReturnType<typeof createZohoClient> | undefined;
  try {
    let credentials: z.infer<typeof credentialsSchema>;
    try { const parsed = credentialsSchema.safeParse(input); if (!parsed.success || typeof request !== "function") throw new Error(); credentials = parsed.data; }
    catch { throw new LocalZohoSourceError("CREDENTIALS_INVALID"); }
    async function http(url: string, init: RequestInit, limit: number, lossless: boolean) {
      const controller = new AbortController(), { signal } = controller;
      const expired = new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new LocalZohoSourceError("TIMEOUT")), { once: true }));
      const timer = setTimeout(() => controller.abort(), 20_000);
      const cancel = (response: Response) => { try { void response.body?.cancel().catch(() => {}); } catch { /* redacted cleanup */ } };
      try {
        return await Promise.race([expired, (async () => {
          const response = await request(url, { ...init, redirect: "error", cache: "no-store", credentials: "omit", signal });
          if (signal.aborted) { cancel(response); throw new LocalZohoSourceError("TIMEOUT"); }
          if (!response.ok || response.redirected) { cancel(response); throw new LocalZohoSourceError("HTTP_FAILED"); }
          return readBoundedZohoJson(response, limit, lossless, signal);
        })()]);
      } finally { clearTimeout(timer); }
    }
    const tokenBody = await http("https://accounts.zoho.com/oauth/v2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret,
          refresh_token: credentials.refreshToken, grant_type: "refresh_token" }) }, 65_536, false);
    const tokenResult = z.object({ access_token: secret, api_domain: z.literal("https://www.zohoapis.com"),
      token_type: z.literal("Bearer"), expires_in: z.number().int().min(1).max(3600) }).safeParse(tokenBody);
    if (!cleanEnvelope(tokenBody) || !tokenResult.success) throw new LocalZohoSourceError("TOKEN_INVALID");
    const token = tokenResult.data;
    const orgBody = await http("https://www.zohoapis.com/crm/v8/org", { method: "GET", headers: { Authorization: `Zoho-oauthtoken ${token.access_token}` } }, 262_144, true);
    const organizationResult = z.object({ org: z.array(z.object({ id: z.string().regex(/^[1-9][0-9]{0,29}$/),
      type: z.literal("production"), company_name: z.literal("VOLTRONIX") })).length(1) }).safeParse(orgBody);
    if (!cleanEnvelope(orgBody) || !organizationResult.success || !cleanEnvelope((orgBody as { org: unknown[] }).org[0])) throw new LocalZohoSourceError("ORGANIZATION_MISMATCH");
    const organization = organizationResult.data.org[0]!;
    // The verified client independently checks the same organization on each token refresh.
    client = createZohoClient({ ...credentials, organizationId: organization.id, environment: "production", allowWrites: false },
      { fetch: request, networkEnabled: true });
    await client.verifyOrganization();
    return await readZohoInboundSnapshot(client, { organizationId: organization.id, capturedAt: new Date().toISOString(),
      limits: { pageSize: 200, maxPages: 100, maxProducts: 20_000, maxDeals: 20_000, maxNotes: 20_000, maxRequests: 300 } });
  } catch (error) { throw redacted(error); }
  finally { client?.close(); }
}
