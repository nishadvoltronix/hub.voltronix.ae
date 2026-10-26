import assert from "node:assert/strict";
import test from "node:test";
import { inspectZohoMetadata, ZohoInspectionError } from "../scripts/zoho-inspect/inspection.js";
import { runZohoInspectionCommand } from "../scripts/zoho-inspect/command.js";
import { zohoFieldRequirements } from "../src/integrations/zoho/readiness.js";

const credentials = { clientId: "1000.synthetic-client-marker", clientSecret: "synthetic-secret-marker", refreshToken: "synthetic-refresh-marker" };
const grant = { access_token: "synthetic-access-marker", api_domain: "https://www.zohoapis.com", token_type: "Bearer", expires_in: 3600 };
const org = { org: [{ id: "999888777666555444", type: "production", company_name: "synthetic-company-marker" }] };
const modules = ["Accounts", "Contacts", "Deals", "Products", "Quotes"];
interface Reply { body: unknown; status?: number; contentType?: string; contentLength?: string }
function metadata(module: string) {
  return { fields: zohoFieldRequirements.find(value => value.module === module)!.fields.filter(field => !field.nested).map(field => ({
    api_name: field.field, read_only: false, field_read_only: false, operation_type: { api_create: true, api_update: true },
    data_type: field.picklistValues ? "picklist" : "text", pick_list_values: field.picklistValues?.map(actual_value => ({ actual_value })),
  })) };
}
function replies(identity: Reply = { body: org }): Reply[] {
  return [{ body: grant }, identity, ...modules.map(module => ({ body: metadata(module) }))];
}
function fake(queue: Reply[] = replies()) {
  const calls: { url: string; init: RequestInit }[] = [];
  const request: typeof fetch = async (url, init) => {
    assert.ok(init); calls.push({ url: String(url), init });
    const reply = queue.shift(); assert.ok(reply, "No retries or extra requests");
    return new Response(reply.status === 204 ? null : JSON.stringify(reply.body), { status: reply.status ?? 200,
      headers: { "Content-Type": reply.contentType ?? "application/json", ...(reply.contentLength ? { "Content-Length": reply.contentLength } : {}) } });
  };
  return { request, calls };
}
function noSecrets(value: unknown) {
  assert.doesNotMatch(typeof value === "string" ? value : JSON.stringify(value), /synthetic-(?:access|refresh|secret|client|company|provider)-marker|999888777666555444/);
}
function errorCode(code: ZohoInspectionError["code"]) {
  return (error: unknown) => {
    assert.ok(error instanceof ZohoInspectionError); assert.equal(error.code, code); assert.equal(error.cause, undefined);
    noSecrets(error.message); noSecrets(error); return true;
  };
}
function loadEnvironment(target: Record<string, string | undefined>) {
  Object.assign(target, { ZOHO_ENABLED: "false", ZOHO_CLIENT_ID: credentials.clientId,
    ZOHO_CLIENT_SECRET: credentials.clientSecret, ZOHO_REFRESH_TOKEN: credentials.refreshToken });
}

test("inspection is offline by default and rejects invalid configuration before I/O", async () => {
  const mock = fake();
  await assert.rejects(inspectZohoMetadata(credentials, { fetch: mock.request }), errorCode("NETWORK_DISABLED"));
  for (const invalid of [{ ...credentials, clientSecret: "invalid\nsecret" }, { ...credentials, apiOrigin: "https://elsewhere.invalid" },
    { ...credentials, refreshToken: "" }]) {
    await assert.rejects(inspectZohoMetadata(invalid, { fetch: mock.request, networkEnabled: true }), errorCode("CONFIGURATION_INVALID"));
  }
  for (const timeoutMs of [0, -1, 20_001, Number.NaN, 1.2]) {
    await assert.rejects(inspectZohoMetadata(credentials, { fetch: mock.request, networkEnabled: true, timeoutMs }), errorCode("CONFIGURATION_INVALID"));
  }
  assert.equal(mock.calls.length, 0);
});

test("invalid profile selection refuses before private environment access or token refresh", async () => {
  const mock = fake(); let loads = 0;
  for (const profiles of [null, {}, { dealPayloadProfile: "unknown", stagePayloadProfile: "legacy-stage-v1" },
    { dealPayloadProfile: "legacy-create-v1", stagePayloadProfile: "legacy-stage-v1", endpoint: "https://elsewhere.invalid" }]) {
    const options = { fetch: mock.request, networkEnabled: true,
      profiles: profiles as unknown as import("../src/integrations/zoho/readiness.js").ZohoReadinessProfiles };
    await assert.rejects(inspectZohoMetadata(credentials, options), errorCode("CONFIGURATION_INVALID"));
    const result = await runZohoInspectionCommand([], {}, [], { ...options, loadEnvironment: () => { loads++; } });
    assert.equal(result.exitCode, 1); assert.match(result.stderr, /CONFIGURATION_INVALID/); noSecrets(result);
  }
  assert.equal(loads, 0); assert.equal(mock.calls.length, 0);
});

test("existing grant inspection makes one refresh, one identity probe and only five fixed metadata GETs", async () => {
  const mock = fake(), report = await inspectZohoMetadata(credentials, { fetch: mock.request, networkEnabled: true });
  assert.deepEqual(mock.calls.map(call => call.url), ["https://accounts.zoho.com/oauth/v2/token", "https://www.zohoapis.com/crm/v8/org",
    ...modules.map(module => `https://www.zohoapis.com/crm/v8/settings/fields?module=${module}`)]);
  const refresh = mock.calls[0]!;
  assert.equal(refresh.init.method, "POST"); assert.ok(refresh.init.body instanceof URLSearchParams);
  assert.deepEqual(Object.fromEntries(refresh.init.body), { client_id: credentials.clientId, client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken, grant_type: "refresh_token" });
  for (const call of mock.calls) {
    assert.equal(call.init.redirect, "error"); assert.equal(call.init.cache, "no-store"); assert.equal(call.init.credentials, "omit");
    assert.ok(call.init.signal instanceof AbortSignal); noSecrets(call.url);
  }
  for (const call of mock.calls.slice(1)) {
    assert.equal(call.init.method, "GET"); assert.equal(call.init.body, undefined);
    assert.deepEqual(call.init.headers, { Authorization: `Zoho-oauthtoken ${grant.access_token}` });
  }
  assert.deepEqual(report.organizationProbe, { status: "OBSERVED", reason: "PRODUCTION_ENVIRONMENT_OBSERVED", environment: "production" });
  assert.equal(report.organizationIdentityVerified, false); assert.equal(report.targetOrganizationVerified, false);
  assert.equal(report.runtimeIntegrationVerified, false); assert.equal(report.businessRecordsRead, false);
  assert.equal(report.businessRecordsWritten, false); assert.equal(report.filesChanged, false);
  assert.equal(report.metadata.summary.requestedModules, 5); assert.equal(report.metadata.summary.observedModules, 5);
  assert.equal(report.metadata.quotationMappingVerified, false); noSecrets(report);
});

test("missing organization scope continues only fixed metadata and never claims org binding or runtime readiness", async () => {
  for (const status of [401, 403]) {
    const mock = fake(replies({ status, body: { code: "OAUTH_SCOPE_MISMATCH", message: "synthetic-provider-marker" } }));
    const report = await inspectZohoMetadata(credentials, { fetch: mock.request, networkEnabled: true });
    assert.deepEqual(report.organizationProbe, { status: "NOT_VERIFIED", reason: "ORG_SCOPE_MISSING", environment: null });
    assert.equal(report.organizationIdentityVerified, false); assert.equal(report.targetOrganizationVerified, false);
    assert.equal(report.metadata.summary.observedModules, 5); assert.equal(mock.calls.length, 7); noSecrets(report);
  }
});

test("wrong observed organization environment refuses metadata without selecting another host", async () => {
  for (const environment of ["sandbox", "developer", "bigin", "synthetic-provider-marker"]) {
    const mock = fake(replies({ body: { org: [{ id: org.org[0]!.id, type: environment }] } }));
    await assert.rejects(inspectZohoMetadata(credentials, { fetch: mock.request, networkEnabled: true }), errorCode("WRONG_ENVIRONMENT"));
    assert.equal(mock.calls.length, 2);
  }
});

test("ambiguous, incomplete or provider-error organization replies remain unverified and redacted", async () => {
  for (const body of [{ org: [] }, { org: [...org.org, ...org.org] }, { org: [{ id: "0", type: "production" }] },
    { org: [{ id: "1".repeat(40), type: "production" }] }, { org: [{ type: "production" }] },
    { ...org, code: "synthetic-provider-marker" }, { ...org, error: "synthetic-provider-marker" }]) {
    const mock = fake(replies({ body })), report = await inspectZohoMetadata(credentials, { fetch: mock.request, networkEnabled: true });
    assert.equal(report.organizationProbe.reason, "ORG_RESPONSE_INVALID"); assert.equal(report.organizationProbe.environment, null);
    assert.equal(report.targetOrganizationVerified, false); assert.equal(mock.calls.length, 7); noSecrets(report);
  }
});

test("organization authorization and rate limits are fixed categories without unknown provider text", async () => {
  for (const [status, reason] of [[401, "ORG_ACCESS_DENIED"], [403, "ORG_ACCESS_DENIED"], [429, "ORG_RATE_LIMITED"], [503, "ORG_REQUEST_FAILED"]] as const) {
    const mock = fake(replies({ status, body: { code: "synthetic-provider-marker" } }));
    const report = await inspectZohoMetadata(credentials, { fetch: mock.request, networkEnabled: true });
    assert.equal(report.organizationProbe.reason, reason); assert.equal(report.organizationProbe.status, "NOT_VERIFIED");
    assert.equal(mock.calls.length, 7); noSecrets(report);
  }
});

test("rejected, malformed or cross-region token responses stop without identity or metadata calls", async () => {
  for (const body of [{ ...grant, error: "synthetic-provider-marker" }, { ...grant, access_token: undefined },
    { ...grant, access_token: "bad\nvalue" }, { ...grant, token_type: "Basic" }, { ...grant, expires_in: "3600" },
    { ...grant, expires_in: 0 }, { ...grant, expires_in: 3601 }]) {
    const mock = fake([{ body }]);
    await assert.rejects(inspectZohoMetadata(credentials, { fetch: mock.request, networkEnabled: true }), errorCode("TOKEN_REJECTED"));
    assert.equal(mock.calls.length, 1);
  }
  for (const api_domain of ["https://www.zohoapis.eu", "https://sandbox.zohoapis.com", "https://synthetic-provider-marker.invalid"]) {
    const mock = fake([{ body: { ...grant, api_domain } }]);
    await assert.rejects(inspectZohoMetadata(credentials, { fetch: mock.request, networkEnabled: true }), errorCode("UNSUPPORTED_API_REGION"));
    assert.equal(mock.calls.length, 1);
  }
  const rejected = fake([{ body: grant, status: 401 }]);
  await assert.rejects(inspectZohoMetadata(credentials, { fetch: rejected.request, networkEnabled: true }), errorCode("TOKEN_REJECTED"));
  assert.equal(rejected.calls.length, 1);
});

test("metadata HTTP failures and private unknown mandatory fields use sanitized readiness reporting", async () => {
  const accountFields = metadata("Accounts").fields;
  const queue: Reply[] = [{ body: grant }, { body: org },
    { body: { fields: [...accountFields, { api_name: "PrivateUnknownField", system_mandatory: true, custom_field: true, field_label: "synthetic-provider-marker" }] } },
    { body: { code: "synthetic-provider-marker" }, status: 403 }, { body: { code: "synthetic-provider-marker" }, status: 429 },
    { body: null, status: 204 }, { body: { message: "synthetic-provider-marker" }, status: 500 }];
  const mock = fake(queue), report = await inspectZohoMetadata(credentials, { fetch: mock.request, networkEnabled: true });
  assert.deepEqual(report.metadata.modules.slice(0, 5).map(module => module.checks), [
    ["FIELD_METADATA_OBSERVED", "UNKNOWN_MANDATORY_FIELDS_REVIEW", "UNKNOWN_CUSTOM_MANDATORY_FIELDS_REVIEW"],
    ["METADATA_ACCESS_DENIED"], ["METADATA_RATE_LIMITED"], ["METADATA_EMPTY"], ["METADATA_REQUEST_FAILED"],
  ]);
  assert.equal(report.metadata.modules[0]!.unknownCustomMandatoryFieldCount, 1);
  assert.doesNotMatch(JSON.stringify(report), /PrivateUnknownField/); noSecrets(report); assert.equal(mock.calls.length, 7);
});

test("bounded JSON rejects oversized/content-type failures without leaking or retrying", async () => {
  for (const reply of [{ body: grant, contentLength: "65537" }, { body: grant, contentType: "text/plain" },
    { body: { ...grant, ignored: "x".repeat(65_536) } }]) {
    const mock = fake([reply]);
    await assert.rejects(inspectZohoMetadata(credentials, { fetch: mock.request, networkEnabled: true }), errorCode("REQUEST_FAILED"));
    assert.equal(mock.calls.length, 1);
  }
  const mock = fake(replies({ body: org, contentLength: "262145" }));
  const report = await inspectZohoMetadata(credentials, { fetch: mock.request, networkEnabled: true });
  assert.equal(report.organizationProbe.reason, "ORG_REQUEST_FAILED"); assert.equal(mock.calls.length, 7); noSecrets(report);
});

test("network exceptions are redacted and a never-settling injected fetch is deadline bounded", async () => {
  let calls = 0;
  await assert.rejects(inspectZohoMetadata(credentials, { networkEnabled: true, fetch: async () => {
    calls++; throw new Error("synthetic-secret-marker");
  } }), errorCode("REQUEST_FAILED"));
  assert.equal(calls, 1);
  let signal: AbortSignal | null | undefined;
  await assert.rejects(inspectZohoMetadata(credentials, { networkEnabled: true, timeoutMs: 5, fetch: async (_url, init) => {
    calls++; signal = init?.signal; return new Promise<Response>(() => {});
  } }), errorCode("TIMEOUT"));
  assert.equal(calls, 2); assert.ok(signal?.aborted);
});

test("streaming response deadline cancels a stalled body and does not log raw data", async () => {
  let cancelled = false;
  await assert.rejects(inspectZohoMetadata(credentials, { networkEnabled: true, timeoutMs: 5, fetch: async () => new Response(
    new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { "Content-Type": "application/json" } }) }), errorCode("TIMEOUT"));
  assert.equal(cancelled, true);
});

test("command help and argument refusals perform no environment load or network", async () => {
  let loads = 0; const mock = fake(), dependencies = { loadEnvironment: () => { loads++; }, fetch: mock.request };
  const help = await runZohoInspectionCommand(["--help"], {}, [], dependencies);
  assert.equal(help.exitCode, 0); assert.match(help.stdout, /No sandbox or new consent required/);
  for (const args of [["--token=synthetic-refresh-marker"], ["--help", "extra"], ["https://elsewhere.invalid"]]) {
    const result = await runZohoInspectionCommand(args, {}, [], dependencies); assert.equal(result.exitCode, 1); noSecrets(result);
  }
  assert.equal(loads, 0); assert.equal(mock.calls.length, 0);
});

test("command refuses debug/network-disabled invocation before loading the private file", async () => {
  let loads = 0; const mock = fake(), dependencies = { loadEnvironment: () => { loads++; }, fetch: mock.request };
  for (const key of ["DEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_OPTIONS", "PWDEBUG"]) {
    const result = await runZohoInspectionCommand([], { [key]: "synthetic-secret-marker" }, [], dependencies);
    assert.equal(result.exitCode, 1); noSecrets(result);
  }
  for (const execArgs of [["--inspect"], ["--inspect-brk=9229"]]) {
    assert.equal((await runZohoInspectionCommand([], {}, execArgs, dependencies)).exitCode, 1);
  }
  assert.equal((await runZohoInspectionCommand([], { ZOHO_NETWORK_DISABLED: "1" }, [], dependencies)).exitCode, 1);
  assert.equal(loads, 0); assert.equal(mock.calls.length, 0);
});

test("command uses only detached private-file values and always returns non-acceptance exit 2 for reports", async () => {
  const mock = fake(replies({ body: { code: "OAUTH_SCOPE_MISMATCH" }, status: 401 }));
  const environment = Object.freeze({ ZOHO_REFRESH_TOKEN: "unselected-process-token", ZOHO_CLIENT_SECRET: "unselected-process-secret" });
  const result = await runZohoInspectionCommand([], environment, [], { fetch: mock.request, loadEnvironment });
  assert.equal(result.exitCode, 2); assert.equal(result.stderr, ""); assert.match(result.stdout, /ORG_SCOPE_MISSING/);
  assert.match(result.stdout, /not full CRM workflow\/production acceptance/); noSecrets(result);
  const form = mock.calls[0]!.init.body as URLSearchParams;
  assert.equal(form.get("refresh_token"), credentials.refreshToken);
  assert.equal(environment.ZOHO_REFRESH_TOKEN, "unselected-process-token");
});

test("command reports private load/runtime-setting failures without exposing values or making requests", async () => {
  const mock = fake();
  for (const loader of [() => { throw new Error("synthetic-secret-marker"); }, () => {},
    (values: Record<string, string | undefined>) => { loadEnvironment(values); values.ZOHO_ENABLED = "true"; }]) {
    const result = await runZohoInspectionCommand([], {}, [], { fetch: mock.request, loadEnvironment: loader });
    assert.equal(result.exitCode, 1); noSecrets(result);
  }
  assert.equal(mock.calls.length, 0);
});
