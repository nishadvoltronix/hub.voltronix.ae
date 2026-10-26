import assert from "node:assert/strict";
import test from "node:test";
import { openZohoSession, type ZohoSessionConfiguration } from "../src/integrations/zoho/session.js";
import { ZohoClientError } from "../src/integrations/zoho/client.js";

const config: ZohoSessionConfiguration = { credentials: { clientId: "synthetic-client", clientSecret: "synthetic-secret", refreshToken: "synthetic-refresh" },
  environment: "production", organizationId: "123", mode: "read-only", dealPayloadProfile: "legacy-conversion-fields-v1",
  stagePayloadProfile: "voltronix-stage-labels-v1" };
function fixture(type = "production", id = "123") {
  const paths: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); paths.push(url.pathname + url.search);
    if (url.pathname === "/oauth/v2/token") return Response.json({ access_token: "synthetic-access", expires_in: 3600, api_domain: "https://www.zohoapis.com", token_type: "Bearer" });
    assert.equal(url.origin, type === "sandbox" ? "https://sandbox.zohoapis.com" : "https://www.zohoapis.com");
    if (url.pathname === "/crm/v8/org") return Response.json({ org: [{ id, type }] });
    assert.equal(init?.method, "GET");
    return new Response(null, { status: 204 });
  };
  return { paths, request };
}
const code = (value: string) => (error: unknown) => error instanceof ZohoClientError && error.code === value;

test("opening a session is explicit, offline by default and never learns its target identity from the provider", async () => {
  const f = fixture();
  await assert.rejects(openZohoSession(config, { fetch: f.request }), code("NETWORK_DISABLED"));
  assert.deepEqual(f.paths, []);
  const wrong = fixture("production", "456");
  await assert.rejects(openZohoSession(config, { fetch: wrong.request, networkEnabled: true }), code("ORGANIZATION_MISMATCH"));
  assert.equal(wrong.paths.length, 2);
});

test("verified production session exposes explicit reads but never write integration or credentials", async t => {
  const f = fixture(), session = await openZohoSession(config, { fetch: f.request, networkEnabled: true });
  t.after(() => session.close());
  assert.deepEqual(session.organization, { id: "123", environment: "production" });
  assert.equal(session.crmIntegration, undefined);
  assert.equal(Object.isFrozen(session), true);
  assert.equal(Object.isFrozen(session.organization), true);
  assert.doesNotMatch(JSON.stringify(session), /synthetic-(secret|refresh|access)/);
  assert.equal(f.paths.length, 2, "opening must not preload records");
  const products = await session.readRecords({ module: "Products" }, { pageSize: 1, maxPages: 1, maxRecords: 1 });
  assert.deepEqual(products.records, []);
  assert.equal(products.snapshotConsistent, false);
  assert.equal(f.paths.length, 3);
  session.close();
  await assert.rejects(session.readRecords({ module: "Products" }, { pageSize: 1, maxPages: 1, maxRecords: 1 }));
  assert.equal(f.paths.length, 3);
});

test("session rejects unsupported modes/profiles/identity and production-write requests before networking", async () => {
  const f = fixture();
  for (const input of [
    { ...config, mode: "sandbox-write", accountOwnerId: "456" },
    { ...config, mode: "production-write" }, { ...config, organizationId: "" },
    { ...config, environment: "sandbox", mode: "sandbox-write" },
    { ...config, stagePayloadProfile: "automatic" }, { ...config, dealPayloadProfile: "automatic" },
    { ...config, accountPayloadProfile: "automatic" }, { ...config, accountPayloadProfile: null },
    { ...config, dealPipeline: "" }, { ...config, dealPipeline: " invalid " }, { ...config, dealPipeline: null },
    { ...config, credentials: { ...config.credentials, endpoint: "https://elsewhere.invalid" } },
  ]) await assert.rejects(openZohoSession(input as ZohoSessionConfiguration, { fetch: f.request, networkEnabled: true }), code("CONFIG_INVALID"));
  assert.deepEqual(f.paths, []);
});

test("explicit verified sandbox session forwards both profiles and chosen owner to CRM composition", async t => {
  const f = fixture("sandbox"), session = await openZohoSession({ ...config, environment: "sandbox", mode: "sandbox-write", accountOwnerId: "456" },
    { fetch: f.request, networkEnabled: true });
  t.after(() => session.close());
  assert.ok(session.crmIntegration);
  assert.equal(session.crmIntegration.accountOwnerId, "456");
  assert.equal(session.crmIntegration.dealPayloadProfile, config.dealPayloadProfile);
  assert.equal(session.crmIntegration.stagePayloadProfile, config.stagePayloadProfile);
  assert.equal(Object.isFrozen(session.crmIntegration), true);
  assert.equal(f.paths.length, 2);
});

test("session metadata inspection follows its selected payload profiles without enabling writes", async t => {
  const f = fixture(), session = await openZohoSession(config, { fetch: f.request, networkEnabled: true });
  t.after(() => session.close());
  const report = await session.inspectMetadata();
  assert.deepEqual(report.selectedProfiles, { dealPayloadProfile: config.dealPayloadProfile, stagePayloadProfile: config.stagePayloadProfile });
  const deals = report.modules.find(module => module.module === "Deals")!;
  assert.ok(deals.fields.some(field => field.field === "Assign_Department1"));
  assert.ok(deals.fields.some(field => field.field === "P_BOX"));
  assert.ok(!deals.fields.some(field => field.field === "Department"));
  assert.equal(session.crmIntegration, undefined); assert.equal(report.runtimeIntegrationVerified, false);
  assert.equal(f.paths.length, 7);
});

test("an explicit account profile reaches sandbox composition and metadata while production stays read-only", async t => {
  for (const mode of ["read-only", "sandbox-write"] as const) {
    const f = fixture(mode === "read-only" ? "production" : "sandbox");
    const session = await openZohoSession({ ...config, mode, environment: mode === "read-only" ? "production" : "sandbox",
      accountOwnerId: "456", accountPayloadProfile: "standard-account-contact-email-v1", dealPipeline: "Synthetic pipeline" }, { fetch: f.request, networkEnabled: true });
    t.after(() => session.close());
    const report = await session.inspectMetadata();
    assert.equal(report.selectedProfiles?.accountPayloadProfile, "standard-account-contact-email-v1");
    assert.equal(report.selectedProfiles?.dealPipeline, "Synthetic pipeline");
    assert.ok(report.modules.find(module => module.module === "Deals")!.fields.some(field => field.field === "Pipeline"));
    assert.equal(report.modules.find(module => module.module === "Accounts")!.fields.some(field => field.field === "Email"), false);
    if (mode === "read-only") assert.equal(session.crmIntegration, undefined);
    else { assert.equal(session.crmIntegration?.accountPayloadProfile, "standard-account-contact-email-v1");
      assert.equal(session.crmIntegration?.dealPipeline, "Synthetic pipeline"); }
    assert.equal(f.paths.length, 7);
  }
});

test("configuration getter errors are redacted before any network access", async () => {
  const f = fixture();
  const bad = { ...config, get credentials(): ZohoSessionConfiguration["credentials"] { throw new Error("private-secret-marker"); } };
  await assert.rejects(openZohoSession(bad, { fetch: f.request, networkEnabled: true }), error => {
    assert.ok(error instanceof ZohoClientError); assert.equal(error.code, "CONFIG_INVALID");
    assert.doesNotMatch(String(error.stack), /private-secret-marker/); return true;
  });
  assert.equal(f.paths.length, 0);
});
