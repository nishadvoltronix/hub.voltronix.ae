import { z } from "zod";
import { readBoundedZohoJson } from "../../src/integrations/zoho/client.js";
import { accountsOrigin, callbackCode, redirectUri } from "../zoho-oauth.js";
import { SandboxSetupError, validateSandboxProfile, type SandboxProfile } from "./profile.js";

export const sandboxOrigin = "https://sandbox.zohoapis.com";
export const sandboxScopes = "ZohoCRM.modules.ALL,ZohoCRM.settings.fields.READ,ZohoSearch.securesearch.READ,ZohoCRM.org.READ,ZohoCRM.users.READ";
const token = z.string().regex(/^[A-Za-z0-9._~-]{1,4096}$/);
const credentialsSchema = z.object({ clientId: token, clientSecret: token }).strict();
type Credentials = z.infer<typeof credentialsSchema>;
type AuthorizationStage = "CONFIGURATION" | "CALLBACK" | "TOKEN_EXCHANGE" | "SANDBOX_IDENTITY";
const failureHints = {
  INVALID_INPUT: "Check the client settings privately, or paste the full callback URL from THIS setup run. Old links, altered state and unsupported regions are refused.",
  INVALID_CODE: "Zoho rejected the code: it may be expired, already used or invalid. Run setup again and paste the new callback immediately.",
  INVALID_CLIENT: "Zoho rejected the client or regional client secret. Check the US PMCRM registration privately.",
  INVALID_CLIENT_SECRET: "Zoho rejected the client secret. Check ZOHO_CLIENT_SECRET privately; do not paste it in chat.",
  INVALID_REDIRECT_URI: "Zoho rejected the callback URI. Check the registered PMCRM redirect URI.",
  ACCESS_DENIED: "Zoho denied authorization. Check the intended account's consent/access before starting a fresh setup.",
  INVALID_SCOPE: "Zoho rejected a requested scope. Review the requested scopes before starting a fresh setup.",
  REFRESH_TOKEN_MISSING: "Zoho returned no valid refresh token. Use fresh offline consent; no access-token-only profile is saved.",
  UNSUPPORTED_API_REGION: "Zoho returned an unsupported API region/environment. This helper supports the US sandbox only.",
  ORG_SCOPE_MISMATCH: "Zoho rejected the organization-read scope. Fresh sandbox consent must include ZohoCRM.org.READ.",
  ORG_PERMISSION_DENIED: "The selected user cannot read organization identity. Verify that user's access to the intended sandbox.",
  ORG_TOKEN_REJECTED: "The grant did not authenticate at the US sandbox endpoint. Verify the selected Sandbox environment/account; this does not prove which environment was selected.",
  WRONG_ENVIRONMENT: "Zoho returned a non-sandbox organization. No production/developer grant is accepted; select the intended Sandbox.",
  IDENTITY_INVALID: "Zoho did not return exactly one valid sandbox organization identity. Identity verification was not bypassed.",
  HTTP_REJECTED: "Zoho rejected this request. Review the reported stage/status; no automatic retry was made.",
  RESPONSE_INVALID: "Zoho returned an invalid or incomplete response. Raw provider data was not logged.",
  REQUEST_FAILED: "The request or bounded response read failed or timed out. Check connectivity; no automatic retry was made.",
} as const;
type AuthorizationFailure = keyof typeof failureHints;

/** Only fixed categories and a numeric HTTP status may reach the terminal.
 * Provider messages, callback/code, organization IDs and underlying causes never do. */
export class SandboxAuthorizationError extends SandboxSetupError {
  readonly httpStatus?: number;
  constructor(readonly stage: AuthorizationStage, readonly code: AuthorizationFailure, status?: number) {
    const safeStatus = Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : undefined;
    super(`[${stage}/${code}${safeStatus === undefined ? "" : ` HTTP ${safeStatus}`}] ${failureHints[code]} No sandbox profile saved; existing .env unchanged.`);
    this.name = "SandboxAuthorizationError";
    if (safeStatus !== undefined) this.httpStatus = safeStatus;
  }
}
const tokenFailures: Readonly<Record<string, AuthorizationFailure>> = {
  invalid_code: "INVALID_CODE", invalid_client: "INVALID_CLIENT", invalid_client_secret: "INVALID_CLIENT_SECRET",
  invalid_redirect_uri: "INVALID_REDIRECT_URI", access_denied: "ACCESS_DENIED", invalid_scope: "INVALID_SCOPE",
};
const organizationFailures: Readonly<Record<string, AuthorizationFailure>> = {
  OAUTH_SCOPE_MISMATCH: "ORG_SCOPE_MISMATCH", NO_PERMISSION: "ORG_PERMISSION_DENIED", AUTHORIZATION_FAILED: "ORG_PERMISSION_DENIED",
  INVALID_TOKEN: "ORG_TOKEN_REJECTED", INVALID_OAUTHTOKEN: "ORG_TOKEN_REJECTED", AUTHENTICATION_FAILURE: "ORG_TOKEN_REJECTED",
};
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function knownFailure(value: unknown, allowed: Readonly<Record<string, AuthorizationFailure>>): AuthorizationFailure | undefined {
  return typeof value === "string" && Object.hasOwn(allowed, value) ? allowed[value] : undefined;
}
export function sandboxAuthorizationUrl(clientId: string, state: string): string {
  try {
    token.parse(clientId);
    if (!/^[a-f0-9]{64}$/.test(state)) throw new Error();
    const url = new URL("/oauth/v2/auth", accountsOrigin);
    url.search = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri,
      scope: sandboxScopes, access_type: "offline", prompt: "consent", state }).toString();
    return url.href;
  } catch { throw new SandboxSetupError(); }
}

/** Fresh consent must select Sandbox. Token/organization responses are never
 * printed; no business mutation, fallback to production, or write retry. */
export async function authorizeSandbox(credentials: Credentials, callback: string, state: string,
  request: typeof fetch = fetch, now: () => number = Date.now): Promise<SandboxProfile> {
  let stage: AuthorizationStage = "CONFIGURATION", status: number | undefined;
  try {
    const value = credentialsSchema.parse(credentials);
    stage = "CALLBACK";
    const code = callbackCode(callback, state);
    stage = "TOKEN_EXCHANGE";
    const tokenDeadline = AbortSignal.timeout(20_000);
    const response = await request(`${accountsOrigin}/oauth/v2/token`, { method: "POST", redirect: "error",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: tokenDeadline,
      body: new URLSearchParams({ client_id: value.clientId, client_secret: value.clientSecret,
        grant_type: "authorization_code", redirect_uri: redirectUri, code }) });
    status = response.status;
    const payload = await readBoundedZohoJson(response, 131_072, false, tokenDeadline);
    const tokenFailure = object(payload) ? knownFailure(payload.error, tokenFailures) : undefined;
    if (tokenFailure) throw new SandboxAuthorizationError(stage, tokenFailure, status);
    if (!response.ok || (object(payload) && payload.error !== undefined)) throw new SandboxAuthorizationError(stage, "HTTP_REJECTED", status);
    if (!object(payload) || !token.safeParse(payload.access_token).success) throw new SandboxAuthorizationError(stage, "RESPONSE_INVALID", status);
    if (!token.safeParse(payload.refresh_token).success) throw new SandboxAuthorizationError(stage, "REFRESH_TOKEN_MISSING", status);
    if (payload.api_domain !== "https://www.zohoapis.com" && payload.api_domain !== sandboxOrigin) throw new SandboxAuthorizationError(stage, "UNSUPPORTED_API_REGION", status);
    const result = z.object({ access_token: token, refresh_token: token }).parse(payload);
    stage = "SANDBOX_IDENTITY"; status = undefined;
    const orgDeadline = AbortSignal.timeout(20_000);
    const orgResponse = await request(`${sandboxOrigin}/crm/v8/org`, { method: "GET", redirect: "error",
      headers: { Authorization: `Zoho-oauthtoken ${result.access_token}` }, signal: orgDeadline });
    status = orgResponse.status;
    const identity = await readBoundedZohoJson(orgResponse, 262_144, true, orgDeadline);
    const identityFailure = object(identity) ? knownFailure(identity.code, organizationFailures) : undefined;
    if (identityFailure) throw new SandboxAuthorizationError(stage, identityFailure, status);
    if (!orgResponse.ok || (object(identity) && (identity.code !== undefined || identity.error !== undefined))) {
      throw new SandboxAuthorizationError(stage, "HTTP_REJECTED", status);
    }
    if (object(identity) && Array.isArray(identity.org) && identity.org.length === 1
      && object(identity.org[0]) && ["production", "developer", "bigin"].includes(String(identity.org[0].type))) {
      throw new SandboxAuthorizationError(stage, "WRONG_ENVIRONMENT", status);
    }
    const organization = z.object({ org: z.tuple([z.object({ id: z.string().regex(/^[1-9][0-9]{0,29}$/), type: z.literal("sandbox") })]) }).safeParse(identity);
    if (!organization.success) throw new SandboxAuthorizationError(stage, "IDENTITY_INVALID", status);
    return validateSandboxProfile({ version: 1, environment: "sandbox", ...value,
      refreshToken: result.refresh_token, organizationId: organization.data.org[0].id, createdAt: new Date(now()).toISOString() });
  } catch (error) {
    if (error instanceof SandboxAuthorizationError) throw error;
    throw new SandboxAuthorizationError(stage, stage === "CONFIGURATION" || stage === "CALLBACK" ? "INVALID_INPUT" : "REQUEST_FAILED", status);
  }
}
