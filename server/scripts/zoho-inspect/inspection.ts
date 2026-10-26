import { z } from "zod";
import { readBoundedZohoJson } from "../../src/integrations/zoho/client.js";
import { checkZohoReadiness, type ZohoReadinessProfiles, type ZohoReadinessReport } from "../../src/integrations/zoho/readiness.js";
import { ACCOUNT_PAYLOAD_PROFILES, DEAL_PAYLOAD_PROFILES, dealPipelineSchema } from "../../src/crm/commercial/deals.js";
import { STAGE_PAYLOAD_PROFILES } from "../../src/crm/lead-mutations/stage-profile.js";

const accountsOrigin = "https://accounts.zoho.com";
const apiOrigin = "https://www.zohoapis.com";
const token = z.string().regex(/^[A-Za-z0-9._~-]{1,4096}$/);
const credentialsSchema = z.object({ clientId: token, clientSecret: token, refreshToken: token }).strict();
export type ZohoInspectionCredentials = z.infer<typeof credentialsSchema>;
export interface ZohoInspectionDependencies { fetch?: typeof fetch; networkEnabled?: boolean; timeoutMs?: number; profiles?: ZohoReadinessProfiles }
const profilesSchema = z.object({ accountPayloadProfile: z.enum(ACCOUNT_PAYLOAD_PROFILES).optional(),
  dealPayloadProfile: z.enum(DEAL_PAYLOAD_PROFILES), stagePayloadProfile: z.enum(STAGE_PAYLOAD_PROFILES), dealPipeline: dealPipelineSchema.optional() }).strict();

/** Validate and detach the selected mapping before credentials or networking. */
export function parseInspectionProfiles(input: unknown): ZohoReadinessProfiles | undefined {
  if (input === undefined) return undefined;
  const parsed = profilesSchema.safeParse(input);
  if (!parsed.success) throw new ZohoInspectionError("CONFIGURATION_INVALID");
  return { dealPayloadProfile: parsed.data.dealPayloadProfile, stagePayloadProfile: parsed.data.stagePayloadProfile,
    ...(parsed.data.accountPayloadProfile === undefined ? {} : { accountPayloadProfile: parsed.data.accountPayloadProfile }),
    ...(parsed.data.dealPipeline === undefined ? {} : { dealPipeline: parsed.data.dealPipeline }) };
}
export type ZohoInspectionFailure = "CONFIGURATION_INVALID" | "NETWORK_DISABLED" | "REQUEST_FAILED" | "TIMEOUT"
  | "TOKEN_REJECTED" | "UNSUPPORTED_API_REGION" | "RESPONSE_INVALID" | "WRONG_ENVIRONMENT";

/** Fixed diagnostic codes only. No underlying exceptions, token, organization
 * identifier or provider body may escape this inspection boundary. */
export class ZohoInspectionError extends Error {
  constructor(readonly code: ZohoInspectionFailure) {
    super(`Zoho read-only inspection ${code}. Existing .env unchanged; no business records written.`);
    this.name = "ZohoInspectionError";
  }
}
type ProbeReason = "PRODUCTION_ENVIRONMENT_OBSERVED" | "ORG_SCOPE_MISSING" | "ORG_ACCESS_DENIED"
  | "ORG_RATE_LIMITED" | "ORG_RESPONSE_INVALID" | "ORG_REQUEST_FAILED";
export interface ZohoInspectionReport {
  status: "READ_ONLY_METADATA_INSPECTION";
  tokenAccepted: true;
  /** Observing an org response is not matching an owner-pinned org identifier. */
  organizationIdentityVerified: false;
  targetOrganizationVerified: false;
  organizationProbe: { status: "OBSERVED" | "NOT_VERIFIED"; reason: ProbeReason; environment: "production" | null };
  runtimeIntegrationVerified: false;
  businessRecordsRead: false;
  businessRecordsWritten: false;
  filesChanged: false;
  metadata: ZohoReadinessReport;
  limitations: readonly string[];
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** A purpose-limited diagnostic, NOT the runtime client. An old production
 * grant can inspect five fixed field endpoints without org.READ, but cannot
 * select an arbitrary path, read business rows, return a token or permit writes.
 * The runtime client's pinned-organization requirement is deliberately intact. */
export async function inspectZohoMetadata(input: ZohoInspectionCredentials,
  dependencies: ZohoInspectionDependencies = {}): Promise<ZohoInspectionReport> {
  const parsed = credentialsSchema.safeParse(input);
  if (!parsed.success || !object(dependencies) || Object.keys(dependencies).some(key => !["fetch", "networkEnabled", "timeoutMs", "profiles"].includes(key))
    || (dependencies.fetch !== undefined && typeof dependencies.fetch !== "function")
    || (dependencies.networkEnabled !== undefined && typeof dependencies.networkEnabled !== "boolean")
    || (dependencies.timeoutMs !== undefined && (typeof dependencies.timeoutMs !== "number" || !Number.isInteger(dependencies.timeoutMs)
      || dependencies.timeoutMs < 1 || dependencies.timeoutMs > 20_000))) {
    throw new ZohoInspectionError("CONFIGURATION_INVALID");
  }
  const profiles = parseInspectionProfiles(dependencies.profiles);
  if (dependencies.networkEnabled !== true) throw new ZohoInspectionError("NETWORK_DISABLED");
  const credentials = parsed.data, request = dependencies.fetch ?? fetch, timeoutMs = dependencies.timeoutMs ?? 20_000;
  async function http(url: string, init: RequestInit, limit: number, lossless: boolean): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    const cancelled = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new ZohoInspectionError("TIMEOUT")), { once: true }));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await Promise.race([cancelled, (async () => {
        const response = await request(url, { ...init, signal: controller.signal, redirect: "error", cache: "no-store", credentials: "omit" });
        if (controller.signal.aborted || response.redirected || !Number.isInteger(response.status) || response.status < 200 || response.status > 599) {
          try { void response.body?.cancel().catch(() => {}); } catch { /* redacted cleanup */ }
          throw new ZohoInspectionError("RESPONSE_INVALID");
        }
        return { status: response.status, body: await readBoundedZohoJson(response, limit, lossless, controller.signal) };
      })()]);
    } catch (error) {
      if (error instanceof ZohoInspectionError) throw error;
      throw new ZohoInspectionError("REQUEST_FAILED");
    } finally { clearTimeout(timer); }
  }
  const refreshed = await http(`${accountsOrigin}/oauth/v2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken, grant_type: "refresh_token" }) }, 65_536, false);
  const grant = refreshed.body;
  if (refreshed.status !== 200 || !object(grant) || grant.error !== undefined || !token.safeParse(grant.access_token).success
    || grant.token_type !== "Bearer" || typeof grant.expires_in !== "number" || !Number.isInteger(grant.expires_in)
    || grant.expires_in < 1 || grant.expires_in > 3600) throw new ZohoInspectionError("TOKEN_REJECTED");
  if (grant.api_domain !== apiOrigin) throw new ZohoInspectionError("UNSUPPORTED_API_REGION");
  const headers = { Authorization: `Zoho-oauthtoken ${grant.access_token as string}` };
  let organizationProbe: ZohoInspectionReport["organizationProbe"] = { status: "NOT_VERIFIED", reason: "ORG_REQUEST_FAILED", environment: null };
  try {
    const organization = await http(`${apiOrigin}/crm/v8/org`, { method: "GET", headers }, 262_144, true);
    if ([401, 403].includes(organization.status) && object(organization.body) && organization.body.code === "OAUTH_SCOPE_MISMATCH") {
      organizationProbe = { status: "NOT_VERIFIED", reason: "ORG_SCOPE_MISSING", environment: null };
    } else if ([401, 403].includes(organization.status)) {
      organizationProbe = { status: "NOT_VERIFIED", reason: "ORG_ACCESS_DENIED", environment: null };
    } else if (organization.status === 429) {
      organizationProbe = { status: "NOT_VERIFIED", reason: "ORG_RATE_LIMITED", environment: null };
    } else if (organization.status === 200) {
      const identity = z.object({ org: z.tuple([z.object({ id: z.string().regex(/^[1-9][0-9]{0,29}$/), type: z.string() })]) }).safeParse(organization.body);
      if (identity.success && object(organization.body) && organization.body.code === undefined && organization.body.error === undefined) {
        if (identity.data.org[0].type !== "production") throw new ZohoInspectionError("WRONG_ENVIRONMENT");
        organizationProbe = { status: "OBSERVED", reason: "PRODUCTION_ENVIRONMENT_OBSERVED", environment: "production" };
      } else organizationProbe = { status: "NOT_VERIFIED", reason: "ORG_RESPONSE_INVALID", environment: null };
    }
  } catch (error) {
    if (error instanceof ZohoInspectionError && error.code === "WRONG_ENVIRONMENT") throw error;
    // Org scope/availability is reported, never silently treated as identity
    // verification. Continuing is restricted to metadata-only fixed GETs.
  }
  const allowedPaths = new Set(["Accounts", "Contacts", "Deals", "Products", "Quotes"].map(module => `/settings/fields?module=${module}`));
  const metadata = await checkZohoReadiness({ async request(value) {
    if (value.apiVersion !== "v8" || value.method !== "GET" || !allowedPaths.has(value.path)
      || Object.keys(value).some(key => !["apiVersion", "method", "path"].includes(key))) throw new ZohoInspectionError("CONFIGURATION_INVALID");
    return http(`${apiOrigin}/crm/v8${value.path}`, { method: "GET", headers }, 4 * 1024 * 1024, true);
  } }, profiles);
  return { status: "READ_ONLY_METADATA_INSPECTION", tokenAccepted: true, organizationIdentityVerified: false, targetOrganizationVerified: false, organizationProbe,
    runtimeIntegrationVerified: false, businessRecordsRead: false, businessRecordsWritten: false, filesChanged: false, metadata,
    limitations: ["OWNER_PINNED_ORGANIZATION_NOT_VERIFIED", "METADATA_ONLY_NOT_WORKFLOW_ACCEPTANCE", "RUNTIME_ENABLEMENT_UNCHANGED"] };
}
