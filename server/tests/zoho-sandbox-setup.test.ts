import assert from "node:assert/strict";
import test from "node:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authorizeSandbox, SandboxAuthorizationError, sandboxAuthorizationUrl, sandboxOrigin, sandboxScopes } from "../scripts/zoho-sandbox/oauth.js";
import { assertNewSandboxProfile, readSandboxProfile, SandboxSetupError, sandboxProfilePath, validateSandboxProfile } from "../scripts/zoho-sandbox/profile.js";
import { accountsOrigin, redirectUri } from "../scripts/zoho-oauth.js";

const state = "a".repeat(64), credentials = { clientId: "1000.synthetic-client", clientSecret: "synthetic-secret-marker" };
const grant = { access_token: "synthetic-access-marker", refresh_token: "synthetic-refresh-marker", api_domain: "https://www.zohoapis.com" };
function callback() {
  const url = new URL(redirectUri);
  url.search = new URLSearchParams({ code: "synthetic-code-marker", state, location: "us", "accounts-server": accountsOrigin }).toString();
  return url.href;
}
function fake(replies: { body: unknown; status?: number }[] = [{ body: grant }, { body: { org: [{ id: "12345", type: "sandbox" }] } }]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const request: typeof fetch = async (url, init) => {
    assert.ok(init); calls.push({ url: String(url), init });
    const response = replies.shift(); assert.ok(response, "No implicit retry or extra request");
    return new Response(JSON.stringify(response.body), { status: response.status ?? 200, headers: { "Content-Type": "application/json" } });
  };
  return { calls, request };
}
function redacted(error: unknown): boolean {
  assert.ok(error instanceof SandboxSetupError);
  assert.doesNotMatch(error.message, /synthetic-(?:access|refresh|code|secret|provider)-marker/);
  assert.equal(error.cause, undefined);
  return true;
}
function diagnostic(stage: SandboxAuthorizationError["stage"], code: SandboxAuthorizationError["code"], status?: number) {
  return (error: unknown): boolean => {
    redacted(error);
    assert.ok(error instanceof SandboxAuthorizationError);
    assert.equal(error.stage, stage); assert.equal(error.code, code); assert.equal(error.httpStatus, status);
    assert.match(error.message, /existing \.env unchanged/);
    assert.doesNotMatch(JSON.stringify(error), /synthetic-(?:access|refresh|code|secret|provider)-marker/);
    return true;
  };
}

test("sandbox diagnostics identify local validation failure without consuming an OAuth code", async () => {
  const mock = fake();
  await assert.rejects(authorizeSandbox(credentials, callback(), "b".repeat(64), mock.request), diagnostic("CALLBACK", "INVALID_INPUT"));
  await assert.rejects(authorizeSandbox({ ...credentials, clientSecret: "invalid\nsecret" }, callback(), state, mock.request), diagnostic("CONFIGURATION", "INVALID_INPUT"));
  assert.equal(mock.calls.length, 0);
});

test("sandbox diagnostics distinguish only allowlisted token errors, including HTTP 200 error responses", async () => {
  const known = { invalid_code: "INVALID_CODE", invalid_client: "INVALID_CLIENT", invalid_client_secret: "INVALID_CLIENT_SECRET",
    invalid_redirect_uri: "INVALID_REDIRECT_URI", access_denied: "ACCESS_DENIED", invalid_scope: "INVALID_SCOPE" } as const;
  for (const [provider, code] of Object.entries(known)) for (const status of [200, 400]) {
    const mock = fake([{ body: { error: provider, message: "synthetic-provider-marker", access_token: grant.access_token }, status }]);
    await assert.rejects(authorizeSandbox(credentials, callback(), state, mock.request), diagnostic("TOKEN_EXCHANGE", code, status));
    assert.equal(mock.calls.length, 1);
  }
  for (const error of ["synthetic-provider-marker", "toString", "hasOwnProperty"]) {
    const mock = fake([{ body: { error, message: grant.refresh_token } }]);
    await assert.rejects(authorizeSandbox(credentials, callback(), state, mock.request), diagnostic("TOKEN_EXCHANGE", "HTTP_REJECTED", 200));
    assert.equal(mock.calls.length, 1);
  }
});

test("sandbox diagnostics distinguish missing offline token, incomplete reply and unsupported region", async () => {
  const replies = [
    { body: { ...grant, refresh_token: undefined }, code: "REFRESH_TOKEN_MISSING" },
    { body: { ...grant, access_token: undefined }, code: "RESPONSE_INVALID" },
    { body: { ...grant, api_domain: "https://sandbox.zohoapis.eu" }, code: "UNSUPPORTED_API_REGION" },
    { body: { ...grant, api_domain: "https://synthetic-provider-marker.invalid" }, code: "UNSUPPORTED_API_REGION" },
  ] as const;
  for (const item of replies) {
    const mock = fake([{ body: item.body }]);
    await assert.rejects(authorizeSandbox(credentials, callback(), state, mock.request), diagnostic("TOKEN_EXCHANGE", item.code, 200));
    assert.equal(mock.calls.length, 1);
  }
});

test("sandbox diagnostics identify organization scope, permission, token and environment refusals without exposing identity", async () => {
  const replies = [
    { body: { code: "OAUTH_SCOPE_MISMATCH" }, status: 401, code: "ORG_SCOPE_MISMATCH" },
    { body: { code: "NO_PERMISSION" }, status: 403, code: "ORG_PERMISSION_DENIED" },
    { body: { code: "AUTHORIZATION_FAILED" }, status: 400, code: "ORG_PERMISSION_DENIED" },
    ...["INVALID_TOKEN", "INVALID_OAUTHTOKEN", "AUTHENTICATION_FAILURE"].map(code => ({ body: { code }, status: 401, code: "ORG_TOKEN_REJECTED" as const })),
    { body: { code: "synthetic-provider-marker" }, status: 503, code: "HTTP_REJECTED" },
    { body: { code: "synthetic-provider-marker", org: [{ id: "12345", type: "sandbox" }] }, status: 200, code: "HTTP_REJECTED" },
    { body: { org: [{ id: "12345", type: "production", company_name: "synthetic-provider-marker" }] }, status: 200, code: "WRONG_ENVIRONMENT" },
    { body: { org: [{ id: "12345", type: "developer" }] }, status: 200, code: "WRONG_ENVIRONMENT" },
    { body: { org: [{ id: "12345" }] }, status: 200, code: "IDENTITY_INVALID" },
    { body: { org: [] }, status: 200, code: "IDENTITY_INVALID" },
  ] as const;
  for (const item of replies) {
    const mock = fake([{ body: grant }, { body: { ...item.body, message: "synthetic-provider-marker" }, status: item.status }]);
    await assert.rejects(authorizeSandbox(credentials, callback(), state, mock.request), diagnostic("SANDBOX_IDENTITY", item.code, item.status));
    assert.equal(mock.calls.length, 2);
  }
});

test("sandbox request and bounded-response failures report their stage without retaining errors or retrying", async () => {
  for (const failedStage of ["TOKEN_EXCHANGE", "SANDBOX_IDENTITY"] as const) for (const malformed of [false, true]) {
    let calls = 0;
    const request: typeof fetch = async () => {
      calls++;
      if (failedStage === "SANDBOX_IDENTITY" && calls === 1) return new Response(JSON.stringify(grant), { headers: { "Content-Type": "application/json" } });
      if (malformed) return new Response("synthetic-provider-marker", { status: 502, headers: { "Content-Type": "application/json" } });
      throw new Error("synthetic-secret-marker");
    };
    await assert.rejects(authorizeSandbox(credentials, callback(), state, request), diagnostic(failedStage, "REQUEST_FAILED", malformed ? 502 : undefined));
    assert.equal(calls, failedStage === "TOKEN_EXCHANGE" ? 1 : 2);
  }
});

test("documented US sandbox API-domain response still requires matching sandbox identity", async () => {
  const mock = fake([{ body: { ...grant, api_domain: sandboxOrigin } }, { body: { org: [{ id: "12345", type: "sandbox" }] } }]);
  const result = await authorizeSandbox(credentials, callback(), state, mock.request);
  assert.equal(result.environment, "sandbox"); assert.equal(result.organizationId, "12345");
  assert.equal(mock.calls.length, 2);
});

test("sandbox consent uses fresh offline state and organization identity scope without reusing production refresh token", () => {
  const url = new URL(sandboxAuthorizationUrl(credentials.clientId, state));
  assert.equal(url.origin, accountsOrigin);
  assert.equal(url.searchParams.get("scope"), sandboxScopes);
  assert.ok(sandboxScopes.split(",").includes("ZohoCRM.org.READ"));
  assert.equal(url.searchParams.get("state"), state);
  assert.equal(url.searchParams.get("redirect_uri"), redirectUri);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.has("refresh_token"), false);
  assert.equal(url.searchParams.has("client_secret"), false);
});

test("sandbox authorization verifies sandbox endpoint AND returned type before producing a private profile", async () => {
  const mock = fake();
  const result = await authorizeSandbox(credentials, callback(), state, mock.request, () => 1_792_000_000_000);
  assert.deepEqual({ environment: result.environment, organizationId: result.organizationId }, { environment: "sandbox", organizationId: "12345" });
  assert.equal(result.refreshToken, grant.refresh_token);
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[0]!.url, `${accountsOrigin}/oauth/v2/token`);
  assert.equal(mock.calls[1]!.url, `${sandboxOrigin}/crm/v8/org`);
  for (const call of mock.calls) {
    assert.equal(call.init.redirect, "error");
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.doesNotMatch(call.url, /synthetic-(?:code|secret|refresh|access)-marker/);
  }
  assert.equal(mock.calls[0]!.init.method, "POST");
  assert.equal(mock.calls[1]!.init.method, "GET");
  const form = mock.calls[0]!.init.body as URLSearchParams;
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.has("refresh_token"), false);
});

test("sandbox setup never accepts production, developer, ambiguous or unverified organization identity", async () => {
  for (const org of [[{ id: "12345", type: "production" }], [{ id: "12345", type: "developer" }], [],
    [{ id: "12345", type: "sandbox" }, { id: "54321", type: "sandbox" }], [{ id: "0", type: "sandbox" }],
    [{ id: "1".repeat(40), type: "sandbox" }], [{ id: "12345" }]]) {
    const mock = fake([{ body: grant }, { body: { org } }]);
    await assert.rejects(authorizeSandbox(credentials, callback(), state, mock.request), redacted);
    assert.equal(mock.calls.length, 2);
  }
});

test("sandbox setup refuses callback mismatch before sending code or credentials", async () => {
  const mock = fake();
  await assert.rejects(authorizeSandbox(credentials, callback(), "b".repeat(64), mock.request), redacted);
  assert.equal(mock.calls.length, 0);
  await assert.rejects(authorizeSandbox({ ...credentials, clientSecret: "bad\nsecret" }, callback(), state, mock.request), redacted);
  assert.equal(mock.calls.length, 0);
});

test("sandbox setup rejects wrong region, incomplete tokens, provider errors and non-success statuses without retry", async () => {
  for (const body of [{ ...grant, api_domain: "https://www.zohoapis.eu" }, { ...grant, refresh_token: "" },
    { ...grant, error: "synthetic-provider-marker" }, { error: "invalid_code" }]) {
    const mock = fake([{ body }]);
    await assert.rejects(authorizeSandbox(credentials, callback(), state, mock.request), redacted);
    assert.equal(mock.calls.length, 1);
  }
  const forbidden = fake([{ body: grant }, { body: { org: [{ id: "12345", type: "sandbox" }] }, status: 403 }]);
  await assert.rejects(authorizeSandbox(credentials, callback(), state, forbidden.request), redacted);
  const unavailable = fake([{ body: grant, status: 503 }]);
  await assert.rejects(authorizeSandbox(credentials, callback(), state, unavailable.request), redacted);
  assert.equal(unavailable.calls.length, 1);
});

test("private sandbox profile cannot select production, arbitrary endpoints or runtime enablement", () => {
  const value = { version: 1, environment: "sandbox", ...credentials, refreshToken: grant.refresh_token,
    organizationId: "12345", createdAt: "2026-10-15T00:00:00.000Z" };
  assert.deepEqual(validateSandboxProfile(value), value);
  for (const invalid of [{ ...value, environment: "production" }, { ...value, apiOrigin: "https://elsewhere.invalid" },
    { ...value, allowWrites: true }, { ...value, enabled: true }, { ...value, organizationId: "1".repeat(40) }]) {
    assert.throws(() => validateSandboxProfile(invalid), redacted);
  }
});

test("private sandbox reader validates canonical file/ancestors without touching production dotenv", t => {
  const root = mkdtempSync(join(tmpdir(), "crm-sandbox-profile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".local-data/operators"), { recursive: true });
  const path = join(root, sandboxProfilePath), env = join(root, ".env");
  const value = { version: 1, environment: "sandbox", ...credentials, refreshToken: grant.refresh_token,
    organizationId: "12345", createdAt: "2026-10-15T00:00:00.000Z" };
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
  writeFileSync(env, "ZOHO_REFRESH_TOKEN=synthetic-production-marker\n");
  const inspections: string[] = [];
  assert.deepEqual(readSandboxProfile(root, item => { inspections.push(item); }), value);
  assert.deepEqual(inspections, [join(root, ".local-data"), join(root, ".local-data/operators"), path]);
  assert.equal(readFileSync(env, "utf8"), "ZOHO_REFRESH_TOKEN=synthetic-production-marker\n");
  assert.throws(() => assertNewSandboxProfile(root), redacted);
  assert.throws(() => readSandboxProfile(root, () => { throw new Error("synthetic-secret-marker"); }), redacted);
});

test("sandbox reader refuses duplicates, malformed/oversized data and hard links", t => {
  const root = mkdtempSync(join(tmpdir(), "crm-sandbox-profile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".local-data/operators"), { recursive: true });
  const path = join(root, sandboxProfilePath);
  for (const value of ["", "synthetic-secret-marker", '{\n  "version": 1,\n  "version": 2\n}', '{"version":1}', "{}\n"]) {
    writeFileSync(path, value);
    assert.throws(() => readSandboxProfile(root, () => {}), redacted);
  }
  truncateSync(path, 16_385);
  assert.throws(() => readSandboxProfile(root, () => {}), redacted);
  writeFileSync(path, "{}\n"); linkSync(path, join(root, "second-link.json"));
  assert.throws(() => readSandboxProfile(root, () => {}), redacted);
});
