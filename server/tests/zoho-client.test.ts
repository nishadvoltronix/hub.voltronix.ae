import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createZohoClient, readBoundedZohoJson, ZohoClientError, type ZohoClientConfig,
  type ZohoClientErrorCode, type ZohoClientRequest } from "../src/integrations/zoho/client.js";

const clientId = "1000.synthetic-client", clientSecret = "synthetic-secret", refreshToken = "1000.synthetic-refresh", accessToken = "1000.synthetic-access";
const orgId = "1234567890123456789";
const config = (patch: Partial<ZohoClientConfig> = {}): ZohoClientConfig => ({ clientId, clientSecret, refreshToken,
  environment: "sandbox", organizationId: orgId, allowWrites: true, ...patch });
const read: ZohoClientRequest = { apiVersion: "v8", method: "GET", path: "/Products/123" };
const write: ZohoClientRequest = { apiVersion: "v2.1", method: "POST", path: "/Products", body: { data: [{ Product_Name: "Fixture product" }] } };
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }); }
const tokenReply = () => ({ access_token: accessToken, api_domain: "https://www.zohoapis.com", expires_in: 3600, token_type: "Bearer" });
interface Call { url: string; init: RequestInit }
function mock(options: { token?: () => Response; org?: () => Response; business?: (call: Call) => Response | Promise<Response> } = {}) {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const call = { url: String(url), init: init ?? {} }; calls.push(call);
    if (call.url === "https://accounts.zoho.com/oauth/v2/token") return options.token?.() ?? json(tokenReply());
    if (call.url.endsWith("/crm/v8/org")) return options.org?.() ?? json({ org: [{ id: orgId, type: "sandbox", company_name: "private-organization-marker" }] });
    return options.business?.(call) ?? json({ data: [{ id: "123" }] });
  };
  return { calls, fetcher };
}
function error(code: ZohoClientErrorCode, status?: number) {
  return (value: unknown): boolean => {
    assert.ok(value instanceof ZohoClientError); assert.equal(value.code, code); assert.equal(value.message, `Zoho client ${code}.`);
    if (status !== undefined) assert.equal(value.httpStatus, status);
    assert.equal(value.cause, undefined);
    for (const secret of [clientSecret, refreshToken, accessToken, "private-organization-marker", "provider-private-marker"])
      assert.ok(!(value.stack ?? "").includes(secret));
    return true;
  };
}

test("Zoho client constructs offline, requires explicit networking and never reads environment", async () => {
  const fake = mock();
  for (const dependencies of [{ fetch: fake.fetcher }, { fetch: fake.fetcher, networkEnabled: false }]) {
    const client = createZohoClient(config(), dependencies);
    assert.equal(fake.calls.length, 0);
    await assert.rejects(client.request(read), error("NETWORK_DISABLED"));
    await assert.rejects(client.verifyOrganization(), error("NETWORK_DISABLED"));
    client.close();
  }
  assert.equal(fake.calls.length, 0);
});

test("v8 inbound product/deal/note cursors are bounded opaque query values, never URLs or combined page offsets", async t => {
  const fake = mock(), client = createZohoClient(config(), { fetch: fake.fetcher, networkEnabled: true });
  t.after(() => client.close());
  for (const module of ["Products", "Deals", "Notes"]) {
    const path = `/${module}?${new URLSearchParams({ fields: "Created_Time,Modified_Time", per_page: "200", page_token: "opaque+/cursor==" })}`;
    await client.request({ apiVersion: "v8", method: "GET", path });
    assert.equal(new URL(fake.calls.at(-1)!.url).searchParams.get("page_token"), "opaque+/cursor==");
  }
  const before = fake.calls.length;
  for (const path of ["/Deals?page=1&page_token=x", "/Deals?page_token=x&page_token=y", "/Deals?page_token=",
    `/Products?page_token=${"x".repeat(4097)}`, "/Deals/123?page_token=x", "/Deals/search?criteria=(Deal_Name:equals:Example)&page_token=x",
    "/Deals/123/Notes?page_token=x", "/Contacts?page_token=x", "/users?page_token=x"]) {
    await assert.rejects(client.request({ apiVersion: "v8", method: "GET", path }), error("REQUEST_INVALID"));
  }
  await assert.rejects(client.request({ apiVersion: "v2.1", method: "GET", path: "/Deals?page_token=x" }), error("REQUEST_INVALID"));
  assert.equal(fake.calls.length, before);
});

test("inbound conditional collections, quote cursors and explicit deletion feeds remain GET-only and bounded", async t => {
  const fake = mock(), client = createZohoClient(config(), { fetch: fake.fetcher, networkEnabled: true });
  t.after(() => client.close());
  const since = "2026-10-15T00:00:00Z";
  for (const path of ["/Quotes?fields=Modified_Time&page_token=opaque%2B%2Ftoken%3D&per_page=200",
    "/VZ_app_users?fields=Name,Email,user_status,Created_Time,Modified_Time&page=1&per_page=200&sort_by=id&sort_order=asc",
    ...["Products", "Deals", "Quotes", "VZ_app_users"].map(module => `/${module}/deleted?type=all&page=1&per_page=200`)]) {
    await client.request({ apiVersion: "v8", method: "GET", path, ifModifiedSince: since });
    assert.equal(fake.calls.at(-1)!.init.method, "GET");
    assert.equal((fake.calls.at(-1)!.init.headers as Record<string, string>)["If-Modified-Since"], since);
  }
  const before = fake.calls.length;
  for (const path of ["/Notes/deleted?type=all&page=1", "/Deals/deleted?type=all&page_token=x", "/Deals/deleted?type=permanent&page=1",
    "/VZ_app_users?fields=Password", "/VZ_app_users?page=1&page_token=x", "/VZ_app_users/123?fields=Email", "/Products/123", "/org", "/users"])
    await assert.rejects(client.request({ apiVersion: "v8", method: "GET", path, ifModifiedSince: since }), error("REQUEST_INVALID"));
  await assert.rejects(client.request({ ...write, ifModifiedSince: since }), error("REQUEST_INVALID"));
  await assert.rejects(client.request({ apiVersion: "v8", method: "GET", path: "/Deals", ifModifiedSince: `${since}\r\nX-Test: bad` }), error("REQUEST_INVALID"));
  assert.equal(fake.calls.length, before);
});

test("only explicit inbound conditional requests accept empty HTTP 304", async t => {
  const fake = mock({ business: () => new Response(null, { status: 304 }) });
  const client = createZohoClient(config(), { fetch: fake.fetcher, networkEnabled: true }); t.after(() => client.close());
  assert.deepEqual(await client.request({ apiVersion: "v8", method: "GET", path: "/Deals", ifModifiedSince: "2026-10-15T00:00:00Z" }), { status: 304, body: undefined });
  await assert.rejects(client.request({ apiVersion: "v8", method: "GET", path: "/Deals" }), error("HTTP_FAILED", 304));
});

test("explicit v8 quotation serializes exact decimal numbers without rounding or mutating caller data", async t => {
  const fake = mock(), client = createZohoClient(config(), { fetch: fake.fetcher, networkEnabled: true });
  t.after(() => client.close());
  const body = { data: [{ Subject: "Fixture 0.10", Discount: "0.10", Tax: "0.005", Adjustment: "-0.01",
    Quoted_Items: [{ Product_Name: { id: "123" }, Quantity: "1.123456789", List_Price: "9007199254740993.123456789", ItemDiscount: "2.50" }] }] };
  const before = JSON.stringify(body);
  await client.request({ apiVersion: "v8", method: "POST", path: "/Quotes", body, exactDecimalSerialization: "quote-v8" });
  const wire = String(fake.calls[2]!.init.body);
  assert.ok(wire.includes('"Discount":0.10'));
  assert.ok(wire.includes('"List_Price":9007199254740993.123456789'));
  assert.ok(wire.includes('"Quantity":1.123456789'));
  assert.ok(wire.includes('"ItemDiscount":2.50'));
  assert.ok(wire.includes('"Adjustment":-0.01'));
  assert.ok(wire.includes('"id":"123"'));
  assert.equal(JSON.stringify(body), before);
});

test("conditional single v8 quote update forwards only a validated If-Unmodified-Since header", async t => {
  const fake = mock(), client = createZohoClient(config(), { fetch: fake.fetcher, networkEnabled: true });
  t.after(() => client.close());
  const stamp = "2026-10-15T12:00:00+04:00";
  await client.request({ apiVersion: "v8", method: "PUT", path: "/Quotes/123", body: { data: [{ Subject: "Fixture" }] }, ifUnmodifiedSince: stamp });
  assert.equal((fake.calls[2]!.init.headers as Record<string, string>)["If-Unmodified-Since"], stamp);
});

test("quote-specific transport options reject other routes, headers and unsafe decimal values before OAuth", async t => {
  const fake = mock(), client = createZohoClient(config(), { fetch: fake.fetcher, networkEnabled: true });
  t.after(() => client.close());
  for (const input of [
    { ...read, ifUnmodifiedSince: "2026-10-15T00:00:00Z" },
    { ...write, ifUnmodifiedSince: "2026-10-15T00:00:00Z" },
    { apiVersion: "v8", method: "PUT", path: "/Quotes", body: { data: [{ id: "123" }] }, ifUnmodifiedSince: "2026-10-15T00:00:00Z" },
    { apiVersion: "v8", method: "PUT", path: "/Quotes/123", body: { data: [{ Subject: "Fixture" }] }, ifUnmodifiedSince: "2026-10-15T00:00:00Z\r\nX-Test: bad" },
    { ...write, exactDecimalSerialization: "quote-v8" },
    { ...read, path: "/Quotes/123", exactDecimalSerialization: "quote-v8" },
    { ...write, apiVersion: "v8", path: "/Quotes", exactDecimalSerialization: "raw-json" },
  ]) await assert.rejects(client.request(input as ZohoClientRequest), error("REQUEST_INVALID"));
  for (const value of [1.1, null, "01", "1e2", "1.0000000001", "1,\"Subject\":\"Injected\"", "NaN", {}, "1000000000000000000"]) {
    await assert.rejects(client.request({ apiVersion: "v8", method: "POST", path: "/Quotes",
      body: { data: [{ Discount: value }] }, exactDecimalSerialization: "quote-v8" }), error("REQUEST_INVALID"));
  }
  assert.equal(fake.calls.length, 0);
});

test("conditional quote precondition failure is not retried or treated as a successful update", async t => {
  const fake = mock({ business: () => json({ code: "ALREADY_MODIFIED", message: "provider-private-marker" }, 412) });
  const client = createZohoClient(config(), { fetch: fake.fetcher, networkEnabled: true }); t.after(() => client.close());
  await assert.rejects(client.request({ apiVersion: "v8", method: "PUT", path: "/Quotes/123",
    body: { data: [{ Subject: "Fixture" }] }, ifUnmodifiedSince: "2026-10-15T00:00:00Z" }), error("HTTP_FAILED", 412));
  assert.equal(fake.calls.length, 3);
});

test("valid-looking organization data with an error envelope cannot bind a token", async t => {
  for (const extra of [{ code: "OAUTH_SCOPE_MISMATCH" }, { error: "provider-private-marker" }, { error: null }]) {
    const fake = mock({ org: () => json({ org: [{ id: orgId, type: "sandbox" }], ...extra }) });
    const client = createZohoClient(config(), { fetch: fake.fetcher, networkEnabled: true }); t.after(() => client.close());
    await assert.rejects(client.request(read), error("ORGANIZATION_MISMATCH"));
    assert.equal(fake.calls.length, 2);
  }
});

test("Zoho client rejects malformed or extra configuration without revealing secrets", () => {
  for (const value of [null, {}, config({ clientSecret: "synthetic-secret\n" }), config({ organizationId: "9".repeat(40) }),
    config({ organizationId: "0001" }), config({ refreshToken: "" }), { ...config(), environment: "developer" },
    { ...config(), accountsOrigin: "https://attacker.invalid" }, { ...config(), allowWrites: "true" }])
    assert.throws(() => createZohoClient(value as ZohoClientConfig), error("CONFIG_INVALID"));
});

test("Zoho client blocks production mutations even with allowWrites true and blocks read-only sandbox mutations before OAuth", async () => {
  for (const value of [config({ environment: "production", allowWrites: true }), config({ environment: "production", allowWrites: false }), config({ allowWrites: false })]) {
    const fake = mock(), client = createZohoClient(value, { fetch: fake.fetcher, networkEnabled: true });
    await assert.rejects(client.request(write), error("WRITE_DISABLED"));
    await assert.rejects(client.request({ ...write, method: "PUT", body: { data: [{ id: "123", Product_Name: "Fixture" }] } }), error("WRITE_DISABLED"));
    assert.equal(fake.calls.length, 0); client.close();
  }
});

test("Zoho client refreshes privately, binds exact sandbox organization, then permits one bounded write", async () => {
  const fake = mock(), client = createZohoClient(config(), { fetch: fake.fetcher, networkEnabled: true });
  assert.deepEqual(await client.verifyOrganization(), { id: orgId, environment: "sandbox" });
  assert.deepEqual(await client.request(write), { status: 200, body: { data: [{ id: "123" }] } });
  assert.deepEqual(fake.calls.map(call => call.url), ["https://accounts.zoho.com/oauth/v2/token", "https://sandbox.zohoapis.com/crm/v8/org", "https://sandbox.zohoapis.com/crm/v2.1/Products"]);
  const auth = fake.calls[0]!.init;
  assert.equal(auth.method, "POST"); assert.ok(auth.body instanceof URLSearchParams);
  assert.deepEqual(Object.fromEntries(auth.body), { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" });
  for (const call of fake.calls) {
    assert.equal(call.init.redirect, "error"); assert.equal(call.init.credentials, "omit"); assert.equal(call.init.cache, "no-store");
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.ok(!call.url.includes(clientSecret) && !call.url.includes(refreshToken) && !call.url.includes(accessToken));
  }
  assert.equal(new Headers(fake.calls[1]!.init.headers).get("Authorization"), `Zoho-oauthtoken ${accessToken}`);
  assert.equal(fake.calls[2]!.init.body, JSON.stringify(write.body)); client.close();
});

test("Zoho client verifies production organization only at the explicit production endpoint for reads", async () => {
  const fake = mock({ org: () => json({ org: [{ id: orgId, type: "production" }] }) });
  const client = createZohoClient(config({ environment: "production" }), { fetch: fake.fetcher, networkEnabled: true });
  await client.request(read);
  assert.ok(fake.calls.slice(1).every(call => call.url.startsWith("https://www.zohoapis.com/crm/")));
  client.close();
});

test("Zoho client fails closed on missing, mismatched, ambiguous or wrong-environment organization", async () => {
  for (const org of [undefined, [], [{ id: "999", type: "sandbox" }], [{ id: orgId, type: "production" }],
    [{ id: orgId, type: "developer" }], [{ id: orgId }], [{ id: orgId, type: "sandbox" }, { id: orgId, type: "sandbox" }]]) {
    const fake = mock({ org: () => json({ org }) }), client = createZohoClient(config(), { fetch: fake.fetcher, networkEnabled: true });
    await assert.rejects(client.request(write), error("ORGANIZATION_MISMATCH"));
    assert.equal(fake.calls.length, 2); client.close();
  }
});

test("Zoho client requires org READ scope and never substitutes metadata success for tenant binding", async () => {
  const fake = mock({ org: () => json({ code: "OAUTH_SCOPE_MISMATCH", message: "provider-private-marker" }, 401) });
  const client = createZohoClient(config(), { fetch: fake.fetcher, networkEnabled: true });
  await assert.rejects(client.request({ apiVersion: "v8", method: "GET", path: "/settings/fields?module=Deals" }), error("HTTP_FAILED", 401));
  assert.equal(fake.calls.length, 2); client.close();
});

test("layout and pipeline metadata are exact Deals-only GET paths with one bounded layout identity", async () => {
  const fake = mock(), client = createZohoClient(config(), { fetch: fake.fetcher, networkEnabled: true });
  await client.request({ apiVersion: "v8", method: "GET", path: "/settings/layouts?module=Deals" });
  await client.request({ apiVersion: "v8", method: "GET", path: "/settings/pipeline?layout_id=6001" });
  const before = fake.calls.length;
  for (const path of ["/settings/layouts", "/settings/layouts?module=Contacts", "/settings/layouts?module=Deals&page=1",
    "/settings/pipeline", "/settings/pipeline?layout_id=0", "/settings/pipeline?layout_id=6001&layout_id=6002", "/settings/pipeline/8001?layout_id=6001"]) {
    await assert.rejects(client.request({ apiVersion: "v8", method: "GET", path }), error("REQUEST_INVALID"));
  }
  for (const method of ["POST", "PUT"] as const) await assert.rejects(client.request({ apiVersion: "v8", method, path: "/settings/pipeline?layout_id=6001", body: { data: [{}] } }), error("REQUEST_INVALID"));
  assert.equal(fake.calls.length, before); client.close();
});

test("Zoho client single-flights refresh and organization verification across concurrent requests", async () => {
  const fake = mock(), client = createZohoClient(config(), { fetch: fake.fetcher, networkEnabled: true });
  const results = await Promise.all(Array.from({ length: 12 }, () => client.request(read)));
  assert.equal(results.length, 12);
  assert.equal(fake.calls.filter(call => call.url.includes("/oauth/")).length, 1);
  assert.equal(fake.calls.filter(call => call.url.endsWith("/org")).length, 1);
  await client.verifyOrganization(); assert.equal(fake.calls.length, 14); client.close();
});

test("Zoho client refreshes before expiry and rechecks organization for every newly issued token", async () => {
  let time = 1000, issued = 0, wrongOrg = false;
  const fake = mock({ token: () => json({ ...tokenReply(), access_token: `${accessToken}-${++issued}` }),
    org: () => json({ org: [{ id: wrongOrg ? "999" : orgId, type: "sandbox" }] }) });
  const client = createZohoClient(config(), { fetch: fake.fetcher, now: () => time, networkEnabled: true });
  await client.request(read); time += 3_569_000; await client.request(read);
  assert.equal(issued, 1);
  time += 2000; await client.request(read); assert.equal(issued, 2);
  assert.equal(fake.calls.filter(call => call.url.endsWith("/org")).length, 2);
  time += 3_600_000; wrongOrg = true;
  await assert.rejects(client.request(write), error("ORGANIZATION_MISMATCH"));
  assert.equal(issued, 3); assert.equal(fake.calls.filter(call => call.init.method === "POST" && !call.url.includes("oauth")).length, 0); client.close();
});

test("Zoho client rejects foreign OAuth domains, malformed tokens and invalid expiry", async () => {
  for (const patch of [{ api_domain: "https://www.zohoapis.eu" }, { api_domain: "https://www.zohoapis.com.attacker.invalid" },
    { api_domain: "http://www.zohoapis.com" }, { api_domain: "https://developer.zohoapis.com" }, { access_token: "synthetic-secret\r\n" },
    { expires_in: undefined }, { expires_in: "3600" }, { expires_in: 0 }, { expires_in: 3601 }, { token_type: "Other" },
    { error: "provider-private-marker" }]) {
    const fake = mock({ token: () => json({ ...tokenReply(), ...patch }) }), client = createZohoClient(config(), { fetch: fake.fetcher, networkEnabled: true });
    await assert.rejects(client.request(read), error("TOKEN_REJECTED")); assert.equal(fake.calls.length, 1); client.close();
  }
});

test("Zoho client permits an explicit US sandbox api_domain but still derives the endpoint from configured environment", async () => {
  const fake = mock({ token: () => json({ ...tokenReply(), api_domain: "https://sandbox.zohoapis.com" }) });
  const client = createZohoClient(config(), { fetch: fake.fetcher, networkEnabled: true });
  await client.request(read); assert.ok(fake.calls[2]!.url.startsWith("https://sandbox.zohoapis.com/")); client.close();
});

test("Zoho client refuses invalid destinations, methods, paths and query keys before networking", async () => {
  const fake = mock(), client = createZohoClient(config(), { fetch: fake.fetcher, networkEnabled: true });
  for (const path of ["https://attacker.invalid/Products", "//attacker.invalid/Products", "/Products/../org", "/Products/%2e%2e/org", "/Products%2f123", "/Products\\123", "/Products#secret", "/Products/", "/Products/0001", `/Products/${"9".repeat(31)}`,
    "/Products?url=https%3A%2F%2Fattacker.invalid", "/Products?page=1&page=2", "/Products?per_page=201", "/Products?page=0", "/Products?fields=id%0Asecret", "/Products?sort_order=bad", "/Products?fields=id,", "/Products?fields=%ZZ", "/Products?a=1?b=2",
    "/org?fields=id", "/org/taxes?extra=1", "/VZ_app_users", "/VZ_app_users/123?fields=password", "/users?type=AllUsers", "/settings/fields?module=Users", "/settings/fields?module=Deals&module=Deals", "/Accounts/123/Attachments", "/Accounts/123/Notes", "/Deals/search/Notes"]) {
    await assert.rejects(client.request({ ...read, path }), error("REQUEST_INVALID"));
  }
  for (const patch of [{ method: "DELETE" }, { apiVersion: "v2" }, { body: {} }, { headers: { Authorization: "provider-private-marker" } }])
    await assert.rejects(client.request({ ...read, ...patch } as ZohoClientRequest), error("REQUEST_INVALID"));
  assert.equal(fake.calls.length, 0); client.close();
});

test("Zoho client permits only fixed read scopes and exact-search grammar", async () => {
  const fake = mock(), client = createZohoClient(config(), { fetch: fake.fetcher, networkEnabled: true });
  for (const path of ["/settings/fields?module=Deals", "/users?type=CurrentUser", "/Products?page=1&per_page=200&sort_by=Product_Name&sort_order=asc",
    "/Deals/123?fields=Deal_Name,Amount", "/Deals/123/Notes?page=1&per_page=20", "/Accounts/search?criteria=%28Account_Name%3Aequals%3AFixture%20Company%29",
    "/Products/search?criteria=%28Product_Name%3Aequals%3AFixture%29&per_page=50"]) await client.request({ ...read, path });
  for (const path of ["/Accounts/search", "/Accounts/search?criteria=(Account_Name:contains:Fixture)", "/Accounts/search?criteria=(Account_Name:equals:Fixture)or(id:equals:123)",
    "/Accounts/search?criteria=(Other_Field:equals:Fixture)", "/Accounts/search?criteria=(Account_Name:equals:Fixture)&sort_by=id"])
    await assert.rejects(client.request({ ...read, path }), error("REQUEST_INVALID"));
  await assert.rejects(client.request({ ...read, apiVersion: "v2.1", path: "/users?type=CurrentUser" }), error("REQUEST_INVALID"));
  client.close();
});

test("Zoho client rejects synthetic IDs in every supported path and lookup shape before OAuth", async () => {
  const synthetic = "9".repeat(40), fake = mock(), client = createZohoClient(config(), { fetch: fake.fetcher, networkEnabled: true });
  const inputs: ZohoClientRequest[] = [
    { ...read, path: `/Deals/${synthetic}/Notes` },
    { ...write, method: "PUT", body: { data: [{ id: synthetic }] } },
    { ...write, body: { data: [{ Product_Name: "Fixture", Owner: { id: synthetic } }] } },
    { ...write, path: "/Contacts", body: { data: [{ Last_Name: "Fixture", Account_Name: synthetic }] } },
    { ...write, path: "/Deals", body: { data: [{ Deal_Name: "Fixture", VZ_app_user: { id: synthetic } }] } },
    { ...write, path: "/Notes", body: { data: [{ Note_Title: "Fixture", Parent_Id: synthetic }] } },
    { ...write, path: "/Quotes", body: { data: [{ Subject: "Fixture", Deal_Name: synthetic }] } },
    { ...write, path: "/Quotes", body: { data: [{ Subject: "Fixture", Quoted_Items: [{ Product_Name: { id: synthetic } }] }] } },
    { ...write, method: "PUT", body: { data: [{ id: 123 }] } },
  ];
  for (const input of inputs) await assert.rejects(client.request(input), error("REQUEST_INVALID"));
  assert.equal(fake.calls.length, 0); client.close();
});

test("Zoho client validates one-record write shape, target identity and serializable bounded JSON", async () => {
  const fake = mock(), client = createZohoClient(config(), { fetch: fake.fetcher, networkEnabled: true });
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  let getterCalled = false;
  const maliciousLookup = Object.defineProperty({}, "id", { enumerable: true, get() { getterCalled = true; return "123"; } });
  for (const body of [null, [], {}, { data: [] }, { data: [{}, {}] }, { data: [{}] }, { data: [{ id: "123" }] }, { data: [{ Product_Name: "x", note: undefined }] },
    { data: [{ Product_Name: "x", when: new Date() }] }, { data: [{ Product_Name: "x", amount: Infinity }] },
    { data: [{ Product_Name: "x", value: "x".repeat(100_001) }] }, { data: [{ Product_Name: "x", values: new Array(2) }] },
    { data: [{ Product_Name: "x", cyclic }] }, { data: [{ Product_Name: "x" }], token: "provider-private-marker" },
    { data: [{ Product_Name: "x" }], trigger: ["unknown"] }, JSON.parse('{"data":[{"Product_Name":"x","__proto__":{}}]}')])
    await assert.rejects(client.request({ ...write, body }), error("REQUEST_INVALID"));
  await assert.rejects(client.request({ ...write, method: "PUT", path: "/Products/123", body: { data: [{ id: "456" }] } }), error("REQUEST_INVALID"));
  await assert.rejects(client.request({ ...write, path: "/Products/123" }), error("REQUEST_INVALID"));
  await assert.rejects(client.request({ ...write, path: "/Products?" }), error("REQUEST_INVALID"));
  await assert.rejects(client.request({ ...write, body: { data: [{ Product_Name: "x", Owner: maliciousLookup }] } }), error("REQUEST_INVALID"));
  assert.equal(getterCalled, false);
  assert.equal(fake.calls.length, 0); client.close();
});

test("Zoho client supports existing nested note and quotation ID contracts without fabricating identities", async () => {
  const fake = mock(), client = createZohoClient(config(), { fetch: fake.fetcher, networkEnabled: true });
  await client.request({ ...write, path: "/Deals/123/Notes", body: { data: [{ Note_Title: "Fixture", Note_Content: "Hello" }] } });
  await client.request({ ...write, path: "/Notes/456", method: "PUT", body: { data: [{ Note_Content: "Changed" }] } });
  await client.request({ ...write, path: "/Quotes", body: { data: [{ Deal_Name: "123", Contact_Name: { id: "234", name: "Fixture" },
    Quoted_Items: [{ Product_Name: { id: "345" }, Quantity: "1", List_Price: "123.450000000000000001" }] }], trigger: [] } });
  assert.equal(fake.calls.length, 5); client.close();
});

test("Zoho client preserves exact numeric lexemes, booleans and null in business JSON and accepts empty 204", async () => {
  const fake = mock({ business: () => new Response('{"data":[{"id":9007199254740993123,"Unit_Price":1.2300000000000000001,"Amount":1e30,"Flag":true,"empty":null}],"info":{"count":1,"more_records":false}}', { headers: { "Content-Type": "application/json;charset=UTF-8" } }) });
  const client = createZohoClient(config(), { fetch: fake.fetcher, networkEnabled: true });
  assert.deepEqual((await client.request(read)).body, { data: [{ id: "9007199254740993123", Unit_Price: "1.2300000000000000001", Amount: "1e30", Flag: true, empty: null }], info: { count: "1", more_records: false } });
  client.close();
  const empty = mock({ business: () => new Response(null, { status: 204 }) });
  const emptyClient = createZohoClient(config(), { fetch: empty.fetcher, networkEnabled: true });
  assert.deepEqual(await emptyClient.request(read), { status: 204, body: undefined }); emptyClient.close();
});

test("Zoho client never replays 401, 429 or 5xx writes and never exposes provider error bodies", async () => {
  for (const status of [401, 429, 500, 503]) {
    const fake = mock({ business: () => json({ code: "provider-private-marker", details: { token: accessToken } }, status) });
    const client = createZohoClient(config(), { fetch: fake.fetcher, networkEnabled: true });
    await assert.rejects(client.request(write), error("HTTP_FAILED", status));
    assert.equal(fake.calls.length, 3); client.close();
  }
});

test("Zoho client invalidates a 401 token for the NEXT explicit call only", async () => {
  let first = true;
  const fake = mock({ business: () => { if (first) { first = false; return json({}, 401); } return json({ data: [] }); } });
  const client = createZohoClient(config(), { fetch: fake.fetcher, networkEnabled: true });
  await assert.rejects(client.request(read), error("HTTP_FAILED", 401)); assert.equal(fake.calls.length, 3);
  await client.request(read); assert.equal(fake.calls.length, 6); client.close();
});

test("Zoho client rejects redirects and sanitizes transport exceptions without retry", async () => {
  const redirect = mock({ business: () => new Response(null, { status: 302, headers: { Location: "https://attacker.invalid" } }) });
  const client = createZohoClient(config(), { fetch: redirect.fetcher, networkEnabled: true });
  await assert.rejects(client.request(read), error("HTTP_FAILED", 302)); assert.equal(redirect.calls.length, 3); client.close();
  let calls = 0;
  const failing = createZohoClient(config(), { networkEnabled: true, fetch: async () => { calls++; throw new Error(clientSecret); } });
  await assert.rejects(failing.request(read), error("UNAVAILABLE")); assert.equal(calls, 1); failing.close();
});

test("Zoho JSON reader enforces streaming byte limits and cancels oversized bodies", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"value":'));
    controller.enqueue(new TextEncoder().encode('"1234567890"}'));
  }, cancel() { cancelled = true; } });
  await assert.rejects(readBoundedZohoJson(new Response(stream, { headers: { "Content-Type": "application/json" } }), 12, true), error("RESPONSE_TOO_LARGE"));
  assert.equal(cancelled, true);
  await assert.rejects(readBoundedZohoJson(new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": "999999" } }), 100, true), error("RESPONSE_TOO_LARGE"));
});

test("Zoho JSON reader rejects malformed media, UTF-8, JSON, unsafe keys and limits without reflecting content", async () => {
  for (const response of [new Response("provider-private-marker", { headers: { "Content-Type": "text/html" } }),
    new Response("provider-private-marker", { headers: { "Content-Type": "application/json" } }),
    new Response(new Uint8Array([0xc3, 0x28]), { headers: { "Content-Type": "application/json" } }),
    new Response('{"nested":{"__proto__":{"secret":"provider-private-marker"}}}', { headers: { "Content-Type": "application/json" } })])
    await assert.rejects(readBoundedZohoJson(response, 1000, true), error("RESPONSE_INVALID"));
  for (const maximum of [0, -1, Infinity, 1.5, 4 * 1024 * 1024 + 1])
    await assert.rejects(readBoundedZohoJson(json({}), maximum, false), error("CONFIG_INVALID"));
  assert.deepEqual(await readBoundedZohoJson(json({ expires_in: 3600 }), 1000, false), { expires_in: 3600 });
});

test("Zoho client bounds even a fetch implementation that ignores abort signals", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = createZohoClient(config(), { networkEnabled: true, fetch: () => new Promise<Response>(() => {}) });
  const rejected = assert.rejects(client.request(read), error("TIMEOUT"));
  t.mock.timers.tick(20_000); await rejected; client.close();
});

test("Zoho client close aborts in-flight requests and prevents subsequent network calls", async () => {
  let started!: () => void;
  const fetching = new Promise<void>(resolve => { started = resolve; });
  let signal: AbortSignal | undefined;
  const client = createZohoClient(config(), { networkEnabled: true, fetch: async (_url, init) => {
    signal = init!.signal!; started(); return new Promise<Response>(() => {});
  } });
  const rejected = assert.rejects(client.request(read), error("CLOSED"));
  await fetching; client.close(); await rejected;
  assert.equal(signal!.aborted, true);
  await assert.rejects(client.verifyOrganization(), error("CLOSED"));
  await assert.rejects(client.request(read), error("CLOSED")); client.close();
});

test("Zoho JSON reader cancels active streams on caller abort without reflecting abort reasons", async () => {
  for (const alreadyAborted of [true, false]) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const controller = new AbortController();
    if (alreadyAborted) controller.abort(new Error(clientSecret));
    const rejected = assert.rejects(readBoundedZohoJson(new Response(stream, { headers: { "Content-Type": "application/json" } }), 100, true, controller.signal), error("UNAVAILABLE"));
    if (!alreadyAborted) controller.abort(new Error(clientSecret));
    await rejected; assert.equal(cancelled, true); assert.equal(stream.locked, false);
  }
});

test("Zoho client deadline cancels a stalled response reader even when the injected stream ignores fetch abort", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"data":')); }, cancel() { cancelled = true; } });
  const fake = mock({ business: () => new Response(stream, { headers: { "Content-Type": "application/json" } }) });
  const client = createZohoClient(config(), { fetch: fake.fetcher, networkEnabled: true });
  await client.verifyOrganization();
  const rejected = assert.rejects(client.request(read), error("TIMEOUT"));
  await setImmediate(); assert.equal(stream.locked, true);
  t.mock.timers.tick(20_000); await rejected; await setImmediate();
  assert.equal(cancelled, true); assert.equal(stream.locked, false); client.close();
});

test("Zoho client cancels a response that arrives after close without reading its data", async () => {
  let finish!: (value: Response) => void, cancelled = false;
  const client = createZohoClient(config(), { networkEnabled: true, fetch: () => new Promise<Response>(resolve => { finish = resolve; }) });
  const rejected = assert.rejects(client.request(read), error("CLOSED"));
  client.close(); await rejected;
  finish(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { "Content-Type": "application/json" } }));
  await setImmediate(); assert.equal(cancelled, true);
});

test("Zoho client rejects invalid injected dependency configuration and redacts clock failures", async () => {
  for (const dependencies of [null, [], { fetch: "invalid" }, { now: "invalid" }, { networkEnabled: "true" }])
    assert.throws(() => createZohoClient(config(), dependencies as never), error("CONFIG_INVALID"));
  for (const clock of [() => NaN, () => -1, () => { throw new Error(clientSecret); }]) {
    const fake = mock(), client = createZohoClient(config(), { fetch: fake.fetcher, now: clock, networkEnabled: true });
    await assert.rejects(client.request(read), error("CONFIG_INVALID"));
    assert.equal(fake.calls.length, 0); client.close();
  }
});
