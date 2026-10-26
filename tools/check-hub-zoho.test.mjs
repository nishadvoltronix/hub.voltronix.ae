import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { runHubZohoCheck } from "./check-hub-zoho.mjs";

const credentials = { ZOHO_ENABLED: "false", ZOHO_CLIENT_ID: "synthetic-client-marker",
  ZOHO_CLIENT_SECRET: "synthetic-secret-marker", ZOHO_REFRESH_TOKEN: "synthetic-refresh-marker" };
const grant = { access_token: "synthetic-access-marker", api_domain: "https://www.zohoapis.com", token_type: "Bearer", expires_in: 3600 };
const org = { org: [{ id: "999888777666555444", type: "production", company_name: "synthetic-company-marker" }] };
const modules = ["Accounts", "Contacts", "Deals", "Products", "Quotes"];
const selected = ["--data-center=us"];
function fake(replies = [{ body: grant }, { body: org }, ...modules.map(() => ({ body: { fields: [{ api_name: "id" }] } }))]) {
  const calls = [];
  return { calls, fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    const reply = replies.shift(); assert.ok(reply, "No retries or extra requests");
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "Content-Type": "application/json" } });
  } };
}
function noSecrets(output) {
  assert.doesNotMatch(JSON.stringify(output), /synthetic-(?:client|secret|refresh|access|company|provider)-marker|999888777666555444|unselected-process/);
}
const loadEnvironment = () => ({ ...credentials, CRM_MYSQL_PASSWORD: "synthetic-database-marker", CRM_DATABASE_MODE: "mysql-native" });

test("help, missing or unsupported data center and extra arguments do not read credentials or make requests", async () => {
  let loads = 0;
  const mock = fake(), dependencies = { fetch: mock.fetch, loadEnvironment: () => { loads++; return credentials; } };
  const help = await runHubZohoCheck(["--help"], {}, [], dependencies);
  assert.equal(help.exitCode, 0); assert.match(help.stdout, /root \.env/); assert.match(help.stdout, /Exit 2/);
  for (const args of [[], ["--data-center=eu"], ["--data-center=US"], ["--help", ...selected],
    [...selected, "--token=synthetic-refresh-marker"], ["https://synthetic-provider-marker.invalid"],
    [...selected, "--account-profile=unknown"], [...selected, "--data-center=us"],
    [...selected, "--stage-profile=legacy-stage-v1", "--stage-profile=voltronix-stage-labels-v1"],
    [...selected, "--deal-profile=legacy-conversion-fields-v1=extra"]]) {
    const result = await runHubZohoCheck(args, {}, [], dependencies);
    assert.equal(result.exitCode, 1); noSecrets(result);
  }
  assert.equal(loads, 0); assert.equal(mock.calls.length, 0);
});

test("explicit mapping flags reach metadata checks without changing endpoints or enabling writes", async () => {
  const mock = fake();
  const result = await runHubZohoCheck([...selected, "--account-profile=standard-account-contact-email-v1",
    "--deal-profile=legacy-conversion-fields-v1", "--stage-profile=voltronix-stage-labels-v1"], {}, [], { fetch: mock.fetch, loadEnvironment });
  assert.equal(result.exitCode, 2); noSecrets(result);
  const report = JSON.parse(result.stdout.slice(0, result.stdout.lastIndexOf("\nMetadata inspection completed.")));
  assert.deepEqual(report.metadata.selectedProfiles, { accountPayloadProfile: "standard-account-contact-email-v1",
    dealPayloadProfile: "legacy-conversion-fields-v1", stagePayloadProfile: "voltronix-stage-labels-v1" });
  assert.ok(!report.metadata.modules.find(value => value.module === "Accounts").fields.some(value => value.field === "Email"));
  const deals = report.metadata.modules.find(value => value.module === "Deals").fields;
  assert.ok(deals.some(value => value.field === "Assign_Department1"));
  assert.ok(deals.some(value => value.field === "P_BOX"));
  assert.ok(!deals.some(value => value.field === "Department" || value.field === "P_Box"));
  assert.equal(report.businessRecordsWritten, false); assert.equal(mock.calls.length, 7);
});

test("debug and network vetoes remain ahead of root environment access", async () => {
  let loads = 0;
  const mock = fake(), dependencies = { fetch: mock.fetch, loadEnvironment: () => { loads++; return credentials; } };
  for (const key of ["DEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_OPTIONS", "PWDEBUG"]) {
    const result = await runHubZohoCheck(selected, { [key]: "synthetic-secret-marker" }, [], dependencies);
    assert.equal(result.exitCode, 1); noSecrets(result);
  }
  for (const execArgs of [["--inspect"], ["--inspect-brk=9229"]]) {
    assert.equal((await runHubZohoCheck(selected, {}, execArgs, dependencies)).exitCode, 1);
  }
  assert.equal((await runHubZohoCheck(selected, { ZOHO_NETWORK_DISABLED: "1" }, [], dependencies)).exitCode, 1);
  assert.equal(loads, 0); assert.equal(mock.calls.length, 0);
});

test("only detached root Zoho values reach the inspector, which reads fixed metadata and never claims readiness", async () => {
  const mock = fake(), root = resolve("synthetic-root"), environment = Object.freeze({
    ZOHO_CLIENT_SECRET: "unselected-process-secret", ZOHO_REFRESH_TOKEN: "unselected-process-token" });
  let loads = 0;
  const result = await runHubZohoCheck(selected, environment, [], { root, fetch: mock.fetch, loadEnvironment: (actualRoot, ambient) => {
    loads++; assert.equal(actualRoot, root); assert.deepEqual(ambient, {}); return loadEnvironment();
  } });
  assert.equal(loads, 1); assert.equal(result.exitCode, 2); assert.equal(result.stderr, ""); noSecrets(result);
  assert.deepEqual(mock.calls.map(call => call.url), ["https://accounts.zoho.com/oauth/v2/token", "https://www.zohoapis.com/crm/v8/org",
    ...modules.map(module => `https://www.zohoapis.com/crm/v8/settings/fields?module=${module}`)]);
  assert.equal(mock.calls[0].init.method, "POST");
  assert.deepEqual(Object.fromEntries(mock.calls[0].init.body), { client_id: credentials.ZOHO_CLIENT_ID,
    client_secret: credentials.ZOHO_CLIENT_SECRET, refresh_token: credentials.ZOHO_REFRESH_TOKEN, grant_type: "refresh_token" });
  for (const call of mock.calls.slice(1)) { assert.equal(call.init.method, "GET"); assert.equal(call.init.body, undefined); }
  const report = JSON.parse(result.stdout.slice(0, result.stdout.lastIndexOf("\nMetadata inspection completed.")));
  assert.equal(report.runtimeIntegrationVerified, false); assert.equal(report.targetOrganizationVerified, false);
  assert.equal(report.businessRecordsRead, false); assert.equal(report.businessRecordsWritten, false); assert.equal(report.filesChanged, false);
  assert.equal(report.metadata.summary.observedModules, 5);
  assert.equal(environment.ZOHO_REFRESH_TOKEN, "unselected-process-token");
});

test("missing credentials, enabled runtime and root read errors refuse before networking with safe root diagnostics", async () => {
  const mock = fake();
  for (const values of [{}, { ...credentials, ZOHO_ENABLED: "true" },
    ...["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN"].map(key => ({ ...credentials, [key]: "" }))]) {
    const result = await runHubZohoCheck(selected, {}, [], { fetch: mock.fetch, loadEnvironment: () => values });
    assert.equal(result.exitCode, 1); assert.match(result.stderr, /root \.env/); noSecrets(result);
  }
  const failure = await runHubZohoCheck(selected, {}, [], { fetch: mock.fetch, loadEnvironment: () => { throw new Error("synthetic-secret-marker"); } });
  assert.equal(failure.exitCode, 1); assert.match(failure.stderr, /root \.env/); noSecrets(failure);
  assert.equal(mock.calls.length, 0);
});

test("rejected tokens, 503 responses and thrown network errors are redacted and are never retried", async () => {
  for (const reply of [{ status: 400, body: { error: "invalid_client", message: "synthetic-provider-marker" } },
    { status: 503, body: { message: "synthetic-secret-marker" } }, { status: 200, body: { ...grant, error: "synthetic-provider-marker" } }]) {
    const mock = fake([reply]), result = await runHubZohoCheck(selected, {}, [], { fetch: mock.fetch, loadEnvironment });
    assert.equal(result.exitCode, 1); assert.match(result.stderr, /TOKEN_REJECTED/); assert.equal(mock.calls.length, 1); noSecrets(result);
  }
  let calls = 0;
  const result = await runHubZohoCheck(selected, {}, [], { loadEnvironment, fetch: async () => { calls++; throw new Error("synthetic-secret-marker"); } });
  assert.equal(result.exitCode, 1); assert.match(result.stderr, /REQUEST_FAILED/); assert.equal(calls, 1); noSecrets(result);
});

test("real root loader reads only its synthetic .env and leaves the file unchanged", async () => {
  const temporary = resolve(tmpdir()), root = mkdtempSync(join(temporary, "hub-zoho-check-"));
  try {
    const source = Object.entries(credentials).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
    writeFileSync(join(root, ".env"), source);
    const mock = fake(), result = await runHubZohoCheck(selected, { ZOHO_REFRESH_TOKEN: "unselected-process-token" }, [], { root, fetch: mock.fetch });
    assert.equal(result.exitCode, 2); noSecrets(result);
    assert.equal(mock.calls[0].init.body.get("refresh_token"), credentials.ZOHO_REFRESH_TOKEN);
    assert.equal(readFileSync(join(root, ".env"), "utf8"), source); assert.deepEqual(readdirSync(root), [".env"]);
  } finally {
    // Resolve and restrict recursive cleanup to this test-created temp directory.
    assert.ok(resolve(root).startsWith(temporary + sep)); assert.match(root.slice(temporary.length + 1), /^hub-zoho-check-[^\\/]+$/);
    rmSync(root, { recursive: true });
  }
});
