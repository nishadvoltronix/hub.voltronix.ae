import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { parseBackendEnvironment } from "../src/environment.js";
import { assertPrivateAccess } from "../src/runtime/private-profile.js";

// PMCRM endpoints confirmed by the owner's registered callback and US response.
export const accountsOrigin = "https://accounts.zoho.com";
export const apiOrigin = "https://www.zohoapis.com";
export const redirectUri = "https://crm.voltronix.ae/crm/pm/index.php/zoho/callback";
// Fresh consent must also allow the verified client's organization binding and
// explicit current-user mapping. Merely refreshing an older grant does NOT add
// scopes. These read scopes do not enable runtime writes or synchronization.
// https://www.zoho.com/crm/developer/docs/api/v8/get-org-data.html
// https://www.zoho.com/crm/developer/docs/api/v8/get-users.html
const scopes = "ZohoCRM.modules.ALL,ZohoCRM.settings.fields.READ,ZohoSearch.securesearch.READ,ZohoCRM.org.READ,ZohoCRM.users.READ";
const tokenPattern = /^[A-Za-z0-9._~-]{1,4096}$/;
export class ZohoSetupError extends Error {}
export interface Credentials { clientId: string; clientSecret: string }
type Request = typeof fetch;

export function authorizationUrl(clientId: string, state: string): string {
  if (!tokenPattern.test(clientId) || !/^[a-f0-9]{64}$/.test(state)) throw new ZohoSetupError("Invalid client ID or setup session.");
  const url = new URL("/oauth/v2/auth", accountsOrigin);
  url.search = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri,
    scope: scopes, access_type: "offline", prompt: "consent", state }).toString();
  return url.href;
}

/** Never visit the callback URL or use its parameters as a request destination. */
export function callbackCode(input: string, state: string): string {
  try {
    const url = new URL(input.trim());
    const expected = new URL(redirectUri);
    if (input.length > 8192 || url.origin !== expected.origin || url.pathname !== expected.pathname
      || url.username || url.password || url.hash || url.searchParams.has("error")) throw new Error();
    for (const key of url.searchParams.keys()) if (url.searchParams.getAll(key).length !== 1) throw new Error();
    if (url.searchParams.get("state") !== state || !/^[a-f0-9]{64}$/.test(state)) throw new Error();
    if (url.searchParams.has("location") && url.searchParams.get("location") !== "us") throw new Error();
    if (url.searchParams.has("accounts-server") && url.searchParams.get("accounts-server") !== accountsOrigin) throw new Error();
    const code = url.searchParams.get("code");
    if (!code || !tokenPattern.test(code)) throw new Error();
    return code;
  } catch { throw new ZohoSetupError("Paste the complete callback URL from the authorization link printed by THIS run (US PMCRM client)."); }
}

const providerErrors: Record<string, string> = {
  invalid_code: "Zoho rejected the code/token (invalid, expired or already used). Run setup again and use a fresh callback URL.",
  invalid_client: "Zoho rejected the client ID or Accounts region. This helper uses the confirmed US PMCRM client.",
  invalid_client_secret: "Zoho rejected ZOHO_CLIENT_SECRET. Check it privately in server/.env.",
  invalid_redirect_uri: "Zoho rejected the registered PMCRM redirect URI.",
  access_denied: "Zoho denied the request. Check consent or wait if rate limited.",
};

async function tokenRequest(fields: Record<string, string>, request: Request): Promise<Record<string, unknown>> {
  try {
    const response = await request(`${accountsOrigin}/oauth/v2/token`, { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields),
      redirect: "error", signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    let payload: Record<string, unknown>;
    try {
      if (text.length > 131_072) throw new Error();
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      payload = parsed as Record<string, unknown>;
    } catch { throw new ZohoSetupError(`Zoho returned an unexpected response (HTTP ${response.status}); credentials were not saved.`); }
    if (!response.ok || payload.error || typeof payload.access_token !== "string" || !tokenPattern.test(payload.access_token)) {
      const error = typeof payload.error === "string" && Object.hasOwn(providerErrors, payload.error) ? providerErrors[payload.error] : undefined;
      throw new ZohoSetupError(error ?? `Zoho token request failed (HTTP ${response.status}); credentials were not saved.`);
    }
    if (payload.api_domain !== apiOrigin) throw new ZohoSetupError("Unexpected Zoho API region; this helper is configured for the US PMCRM client.");
    return payload;
  } catch (error) {
    if (error instanceof ZohoSetupError) throw error;
    throw new ZohoSetupError("Zoho request failed or timed out. No response or credential values were logged.");
  }
}

export async function exchangeCode(credentials: Credentials, code: string, request: Request = fetch) {
  if (!tokenPattern.test(code)) throw new ZohoSetupError("Invalid authorization code format.");
  const result = await tokenRequest({ client_id: credentials.clientId, client_secret: credentials.clientSecret,
    grant_type: "authorization_code", redirect_uri: redirectUri, code }, request);
  if (typeof result.refresh_token !== "string" || !tokenPattern.test(result.refresh_token)) {
    throw new ZohoSetupError("Zoho did not return a refresh token. Rerun setup and approve offline access using its new link.");
  }
  return { accessToken: result.access_token as string, refreshToken: result.refresh_token };
}

export async function refreshAccess(credentials: Credentials, refreshToken: string, request: Request = fetch): Promise<string> {
  if (!tokenPattern.test(refreshToken)) throw new ZohoSetupError("ZOHO_REFRESH_TOKEN contains invalid characters. Run zoho:setup to exchange a callback code.");
  const result = await tokenRequest({ client_id: credentials.clientId, client_secret: credentials.clientSecret,
    grant_type: "refresh_token", refresh_token: refreshToken }, request);
  return result.access_token as string;
}

export async function checkMetadata(accessToken: string, request: Request = fetch): Promise<boolean> {
  try {
    const response = await request(`${apiOrigin}/crm/v8/settings/fields?module=Deals`, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }, redirect: "error", signal: AbortSignal.timeout(20_000) });
    const data: unknown = await response.json();
    return response.ok && typeof data === "object" && data !== null && "fields" in data && Array.isArray(data.fields);
  } catch { return false; }
}

export function withRefreshToken(source: string, token: string): string {
  if (!tokenPattern.test(token)) throw new ZohoSetupError("Invalid refresh token response; file unchanged.");
  parseBackendEnvironment(source);
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = source.slice(bom.length);
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const line = /^[\t ]*(?:export[\t ]+)?ZOHO_REFRESH_TOKEN[\t ]*=[^\r\n]*/m;
  const next = bom + (line.test(body) ? body.replace(line, `ZOHO_REFRESH_TOKEN=${token}`)
    : `${body}${body.length === 0 || body.endsWith("\n") ? "" : newline}ZOHO_REFRESH_TOKEN=${token}${newline}`);
  parseBackendEnvironment(next);
  return next;
}

/** Preserve the existing inode/Windows ACL; refuse edits made while awaiting consent. */
export function saveRefreshToken(file: string, original: string, token: string): void {
  const next = withRefreshToken(original, token);
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 16_384
    || readFileSync(file, "utf8") !== original) throw new ZohoSetupError("server/.env changed during setup; it was not overwritten. Rerun setup.");
  assertPrivateAccess(file);
  const descriptor = openSync(file, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  const write = (source: string) => {
    const bytes = Buffer.from(source, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error();
      offset += count;
    }
    ftruncateSync(descriptor, bytes.length); fsyncSync(descriptor);
  };
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || readFileSync(descriptor, "utf8") !== original) {
      throw new ZohoSetupError("server/.env changed during setup; it was not overwritten. Rerun setup.");
    }
    try { write(next); }
    catch {
      try { write(original); } catch { throw new ZohoSetupError("Saving failed and the original file could not be restored. Inspect server/.env privately."); }
      throw new ZohoSetupError("Saving failed; original server/.env contents restored.");
    }
  } finally { closeSync(descriptor); }
}
