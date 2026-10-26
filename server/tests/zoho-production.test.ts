import assert from "node:assert/strict";
import test from "node:test";
import { openProductionZohoIntegration, validateProductionZohoConfiguration, type ProductionZohoConfiguration } from "../src/integrations/zoho/production.js";
import { assertProductionZohoAuthority, ProductionZohoProfileError, productionZohoLayoutId,
  revokeProductionZohoAuthority, verifyProductionZohoProfile } from "../src/integrations/zoho/production-policy.js";
import { createZohoClient, ZohoClientError } from "../src/integrations/zoho/client.js";
import type { VerifiedZohoRequestPort } from "../src/integrations/zoho/transports.js";

import { syntheticProductionZohoConfiguration, syntheticProductionZohoMetadata, type SyntheticMetadataBody } from "./helpers/production-zoho.js";

const config = syntheticProductionZohoConfiguration();
type Body = SyntheticMetadataBody;
function metadata(bodies: Map<string, Body>, module: string, name: string): Body {
  return (bodies.get(`/settings/fields?module=${module}`)!.fields as Body[]).find(field => field.api_name === name)!;
}
function provider(bodies = syntheticProductionZohoMetadata(config)) {
  const requests: { method: string; path: string; body?: string }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET", path = `${url.pathname}${url.search}`;
    requests.push({ method, path, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (url.pathname === "/oauth/v2/token") return Response.json({ access_token: "synthetic-access", expires_in: 3600,
      api_domain: "https://www.zohoapis.com", token_type: "Bearer" });
    assert.equal(url.origin, "https://www.zohoapis.com");
    if (method === "GET") {
      const body = bodies.get(path.replace(/^\/crm\/v8/, ""));
      assert.ok(body, `Unexpected synthetic request ${path}`); return Response.json(body);
    }
    return Response.json({ data: [{ code: "SUCCESS", status: "success", details: { id: "789" } }] }, { status: 201 });
  };
  const port: VerifiedZohoRequestPort = { async request(input) {
    assert.equal(input.method, "GET"); assert.equal(input.apiVersion, "v8");
    return { status: 200, body: bodies.get(input.path) };
  } };
  return { bodies, requests, fetcher, port };
}

test("named production configuration rejects ambiguous settings and redacts getters before any network", async () => {
  const f = provider();
  for (const patch of [{ organizationId: "" }, { accountOwnerId: "0" }, { profile: "automatic" }, { automationPolicy: "enabled" },
    { dealPipeline: " bad " }, { dealPipeline: "bad\tvalue" }, { endpoint: "https://elsewhere.invalid" },
    { credentials: { ...config.credentials, clientSecret: "bad\nsecret" } }]) {
    await assert.rejects(openProductionZohoIntegration({ ...config, ...patch } as ProductionZohoConfiguration,
      { fetch: f.fetcher, networkEnabled: true }), ProductionZohoProfileError);
  }
  const input = { ...config, get credentials(): ProductionZohoConfiguration["credentials"] { throw new Error("private-marker"); } };
  assert.throws(() => validateProductionZohoConfiguration(input), error => error instanceof ProductionZohoProfileError && !String(error.stack).includes("private-marker"));
  assert.deepEqual(f.requests, []);
});

test("production authority is granted only after the complete pinned read-only profile and cannot be cloned or reused for another org", async () => {
  const f = provider(), authority = await verifyProductionZohoProfile(f.port, config);
  assertProductionZohoAuthority(authority, "123");
  assert.equal(productionZohoLayoutId(authority, "123"), "6001");
  assert.equal(Object.isFrozen(authority), true);
  assert.throws(() => assertProductionZohoAuthority({ ...authority }, "123"), ProductionZohoProfileError);
  assert.throws(() => assertProductionZohoAuthority(authority, "999"), ProductionZohoProfileError);
  revokeProductionZohoAuthority(authority);
  assert.throws(() => assertProductionZohoAuthority(authority, "123"), ProductionZohoProfileError);
  assert.throws(() => productionZohoLayoutId(authority, "123"), ProductionZohoProfileError);
});

test("pipeline preflight binds the active layout, exact wire labels and matching Stage option IDs before writer construction", async () => {
  const layout = (b: Map<string, Body>) => (b.get("/settings/layouts?module=Deals")!.layouts as Body[])[0]!;
  const layoutStage = (b: Map<string, Body>) => ((layout(b).sections as Body[])[0]!.fields as Body[]).find(field => field.api_name === "Stage")!;
  const pipeline = (b: Map<string, Body>) => (b.get("/settings/pipeline?layout_id=6001")!.pipeline as Body[])[0]!;
  const changes: ((b: Map<string, Body>) => void)[] = [
    b => { layout(b).visible = false; }, b => { layout(b).status = "inactive"; }, b => { layout(b).api_name = "Other__s"; },
    b => { (b.get("/settings/layouts?module=Deals")!.layouts as Body[]).push({ ...layout(b), id: "6002" }); },
    b => { pipeline(b).default = false; }, b => { pipeline(b).display_value = "Other"; },
    b => { const maps = pipeline(b).maps as Body[]; maps[1]!.display_value = "Needs Analysis"; },
    b => { const maps = pipeline(b).maps as Body[]; maps[1]!.id = "7999"; },
    b => { const maps = pipeline(b).maps as Body[]; maps.splice(1, 1); },
    b => { const options = layoutStage(b).pick_list_values as Body[]; options[1]!.id = "7999"; },
    b => { const options = layoutStage(b).pick_list_values as Body[]; options[1]!.reference_value = "Needs Analysis"; },
    b => { const options = metadata(b, "Deals", "Stage").pick_list_values as Body[]; options[1]!.display_value = "Needs Analysis"; },
    b => { const options = metadata(b, "Deals", "VZ_App_Status").pick_list_values as Body[]; options[1]!.display_value = "Other"; },
  ];
  for (const change of changes) {
    const f = provider(); change(f.bodies);
    await assert.rejects(openProductionZohoIntegration(config, { fetch: f.fetcher, networkEnabled: true }), ProductionZohoProfileError);
    assert.equal(f.requests.filter(request => request.path.includes("/oauth/")).length, 1);
    assert.equal(f.requests.some(request => request.method !== "GET" && !request.path.includes("/oauth/")), false);
  }
});

test("production preflight refuses incorrect org, inactive owner, tax policy, field contracts and unknown required inputs", async () => {
  const changes: ((b: Map<string, Body>) => void)[] = [
    b => b.set("/org", { org: [{ id: "999", type: "production" }] }),
    b => b.set("/org", { org: [{ id: "123", type: "sandbox" }] }),
    b => b.set("/users?type=CurrentUser", { users: [{ id: "456", status: "inactive" }] }),
    b => b.set("/users?type=CurrentUser", { users: [{ id: "999", status: "active" }] }),
    b => { (b.get("/org/taxes")!.org_taxes as Body).taxes = [{ name: "Vat", value: "0" }]; },
    b => { metadata(b, "Accounts", "Owner").read_only = true; },
    b => { metadata(b, "Contacts", "First_Name").length = "39"; },
    b => { metadata(b, "Contacts", "Mailing_Street").length = "249"; },
    b => { metadata(b, "Deals", "Email").length = "99"; },
    b => { metadata(b, "Deals", "Deal_Name").length = "119"; },
    b => { metadata(b, "Deals", "Pipeline").pick_list_values = [{ actual_value: "Other", type: "used" }]; },
    b => { metadata(b, "Deals", "VZ_App_Status").pick_list_values = []; },
    b => { metadata(b, "Deals", "LostDealNumber").length = "99"; },
    b => { metadata(b, "Quotes", "Quoted_Items").associated_module = { module: "Other" }; },
    b => { metadata(b, "Quotes", "General_Exclusion").length = "9999"; },
    b => { metadata(b, "Quoted_Items", "Product_Name").lookup = { module: { api_name: "Accounts" } }; },
    b => { metadata(b, "Quoted_Items", "Quantity").decimal_place = "8"; },
    b => { metadata(b, "Quoted_Items", "ItemDiscount").operation_type = { api_create: true, api_update: false }; },
    b => { (b.get("/settings/fields?module=Products")!.fields as Body[]).push({ api_name: "Unexpected", data_type: "text",
      system_mandatory: true, operation_type: { api_create: true } }); },
    b => { (b.get("/settings/fields?module=Accounts")!.fields as Body[]).push({ ...metadata(b, "Accounts", "Owner"), api_name: "owner" }); },
    b => { b.get("/settings/fields?module=Contacts")!.fields = []; },
  ];
  for (const change of changes) {
    const f = provider(); change(f.bodies);
    await assert.rejects(openProductionZohoIntegration(config, { fetch: f.fetcher, networkEnabled: true }),
      error => error instanceof ProductionZohoProfileError || (error instanceof ZohoClientError && error.code === "ORGANIZATION_MISMATCH"));
    assert.equal(f.requests.filter(request => request.method !== "GET" && !request.path.includes("/oauth/")).length, 0);
    assert.equal(f.requests.filter(request => request.path.includes("/oauth/")).length, 1, "failed preflight must not open a writer");
  }
});

test("layout-specific required fields must be explicit supported inputs before authority or any business request", async () => {
  const fields = (b: Map<string, Body>) => {
    const layout = (b.get("/settings/layouts?module=Deals")!.layouts as Body[])[0]!;
    return (layout.sections as Body[])[0]!.fields as Body[];
  };
  const field = (b: Map<string, Body>, name: string) => fields(b).find(candidate => candidate.api_name === name)!;
  const changes: ((b: Map<string, Body>) => void)[] = [
    b => { field(b, "Closing_Date").data_type = "text"; },
    b => { field(b, "Closing_Date").read_only = true; },
    b => { field(b, "Closing_Date").operation_type = { api_create: false, api_update: true }; },
    b => { delete field(b, "Closing_Date").required; },
    b => { field(b, "Closing_Date").required = "true"; },
    b => { field(b, "Account_Name").required = false; },
    b => { field(b, "Description").required = true; },
    b => { field(b, "Address").system_mandatory = true; },
    b => { fields(b).push({ api_name: "Unexpected", data_type: "text", system_mandatory: false,
      required: true, operation_type: { api_create: false } }); },
  ];
  for (const change of changes) {
    const f = provider(); change(f.bodies);
    await assert.rejects(openProductionZohoIntegration(config, { fetch: f.fetcher, networkEnabled: true }), ProductionZohoProfileError);
    assert.equal(f.requests.filter(request => request.path.includes("/oauth/")).length, 1);
    assert.equal(f.requests.some(request => request.method !== "GET" && !request.path.includes("/oauth/")), false);
  }
});

test("verified opener exposes fixed mappings and suppresses production automation; close stops future writes and readiness", async () => {
  const f = provider(), session = await openProductionZohoIntegration(config, { fetch: f.fetcher, networkEnabled: true });
  assert.equal(session.crmIntegration.production?.organizationId, "123");
  assert.equal(session.crmIntegration.accountPayloadProfile, "standard-account-contact-email-v1");
  assert.equal(session.crmIntegration.dealPipeline, config.dealPipeline);
  assert.equal(session.crmIntegration.production?.dealLayoutId, "6001");
  assert.equal(session.crmIntegration.stagePayloadProfile, "voltronix-stage-reference-values-v1");
  assert.doesNotMatch(JSON.stringify(session), /synthetic-(secret|refresh|access)/);
  assert.equal(f.requests.filter(request => request.method !== "GET" && !request.path.includes("/oauth/")).length, 0);
  const result = await session.crmIntegration.commercial.request({ apiVersion: "v8", method: "POST", path: "/Products", body: { data: [{ Product_Name: "Synthetic product" }] } });
  assert.equal(result.status, 201);
  const sent = JSON.parse(f.requests.at(-1)!.body!);
  assert.deepEqual(sent.trigger, []); assert.deepEqual(sent.skip_feature_execution, [{ name: "cadences" }]);
  await session.readiness();
  const count = f.requests.length;
  session.close(); session.close();
  await assert.rejects(session.readiness());
  await assert.rejects(session.crmIntegration.commercial.request({ apiVersion: "v8", method: "POST", path: "/Products", body: { data: [{ Product_Name: "Synthetic" }] } }));
  assert.equal(f.requests.length, count);
});

test("production is offline by default and raw production clients cannot use structural authority", async () => {
  const f = provider();
  await assert.rejects(openProductionZohoIntegration(config, { fetch: f.fetcher }), error => error instanceof ZohoClientError && error.code === "NETWORK_DISABLED");
  const client = createZohoClient({ ...config.credentials, environment: "production", organizationId: "123", allowWrites: true },
    { fetch: f.fetcher, networkEnabled: true, productionAuthority: { organizationId: "123", profile: config.profile, automationPolicy: "suppressed" } });
  await assert.rejects(client.request({ apiVersion: "v8", method: "POST", path: "/Products", body: { data: [{ Product_Name: "Synthetic" }] } }),
    error => error instanceof ZohoClientError && error.code === "WRITE_DISABLED");
  client.close(); assert.equal(f.requests.length, 0);
});

test("live readiness detects lost organization binding after startup without making business writes", async () => {
  const f = provider(), session = await openProductionZohoIntegration(config, { fetch: f.fetcher, networkEnabled: true });
  try {
    f.bodies.set("/org", { org: [{ id: "999", type: "production" }] });
    await assert.rejects(session.readiness(), ProductionZohoProfileError);
    assert.equal(f.requests.filter(request => request.method !== "GET" && !request.path.includes("/oauth/")).length, 0);
  } finally { session.close(); }
});
