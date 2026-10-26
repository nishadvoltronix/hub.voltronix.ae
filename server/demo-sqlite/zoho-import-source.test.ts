import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { captureLocalZohoSource, LocalZohoSourceError, type LocalZohoSourceCode } from "./zoho-import-source.js";

// Injected synthetic fetch only. No environment, files, DB or live requests.
const credentials = { clientId: "synthetic-client", clientSecret: "synthetic-secret", refreshToken: "synthetic-refresh" };
const token = () => ({ access_token: "synthetic-access", api_domain: "https://www.zohoapis.com", token_type: "Bearer", expires_in: 3600 });
const organization = () => ({ org: [{ id: "12345", type: "production", company_name: "VOLTRONIX" }] });
type Call = { url: string; init: RequestInit };
function fake(options: { token?: (count: number) => Response; org?: (count: number) => Response; business?: (call: Call) => Response } = {}) {
  const calls: Call[] = []; let tokens = 0, orgs = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const call = { url: String(url), init: init ?? {} }; calls.push(call);
    if (call.url === "https://accounts.zoho.com/oauth/v2/token") return options.token?.(++tokens) ?? Response.json(token());
    if (call.url === "https://www.zohoapis.com/crm/v8/org") return options.org?.(++orgs) ?? Response.json(organization());
    const target = new URL(call.url);
    assert.equal(target.origin, "https://www.zohoapis.com");
    assert.ok(["/crm/v8/Products", "/crm/v8/Deals", "/crm/v8/Notes"].includes(target.pathname));
    return options.business?.(call) ?? new Response(null, { status: 204 });
  };
  return { calls, fetcher };
}
function error(code: LocalZohoSourceCode) { return (value: unknown) => {
  assert.ok(value instanceof LocalZohoSourceError); assert.equal(value.code, code); assert.equal(value.name, "LocalZohoSourceError");
  assert.equal(value.cause, undefined); assert.equal("snapshot" in value, false);
  assert.doesNotMatch(`${value.stack} ${JSON.stringify(value)}`, /synthetic-secret|synthetic-refresh|synthetic-access|private-provider|private-customer/);
  return true;
}; }

test("source binds named production grant then independently rechecks pinned org before fixed read-only capture", async () => {
  const fixture = fake(), snapshot = await captureLocalZohoSource(credentials, fixture.fetcher);
  assert.equal(snapshot.organizationId, "12345"); assert.equal(snapshot.complete, true); assert.equal(snapshot.requestsPerformed, 3);
  assert.deepEqual(snapshot.products, []); assert.deepEqual(snapshot.deals, []); assert.deepEqual(snapshot.notes, []);
  assert.equal(fixture.calls.length, 7);
  assert.deepEqual(fixture.calls.slice(0, 4).map(call => new URL(call.url).pathname), ["/oauth/v2/token", "/crm/v8/org", "/oauth/v2/token", "/crm/v8/org"]);
  for (const call of fixture.calls) {
    assert.equal(call.init.redirect, "error"); assert.equal(call.init.cache, "no-store"); assert.equal(call.init.credentials, "omit");
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.doesNotMatch(call.url, /synthetic-secret|synthetic-refresh|synthetic-access/);
    if (call.url.endsWith("/oauth/v2/token")) {
      assert.equal(call.init.method, "POST");
      const form = new URLSearchParams(call.init.body as URLSearchParams);
      assert.equal(form.get("grant_type"), "refresh_token"); assert.equal(form.get("client_secret"), credentials.clientSecret);
    } else { assert.equal(call.init.method, "GET"); assert.equal(call.init.body, undefined); }
  }
});

test("invalid credentials, extra configuration and hostile getters fail without fetch", async () => {
  const fixture = fake();
  for (const value of [{ ...credentials, clientId: "" }, { ...credentials, clientSecret: "bad\r\nsecret" },
    { ...credentials, refreshToken: "x".repeat(4097) }, { ...credentials, environment: "sandbox" },
    { ...credentials, get clientSecret() { throw new Error("synthetic-secret"); } }]) {
    await assert.rejects(captureLocalZohoSource(value as typeof credentials, fixture.fetcher), error("CREDENTIALS_INVALID"));
  }
  await assert.rejects(captureLocalZohoSource(credentials, "not a fetch" as unknown as typeof fetch), error("CREDENTIALS_INVALID"));
  assert.equal(fixture.calls.length, 0);
});

test("bootstrap refuses foreign or sandbox OAuth domains, malformed tokens and hybrid error success", async () => {
  for (const patch of [{ api_domain: "https://evil.invalid" }, { api_domain: "https://sandbox.zohoapis.com" },
    { access_token: "bad\nheader" }, { token_type: "bearer" }, { expires_in: 0 }, { expires_in: "3600" },
    { code: "SUCCESS" }, { error: "private-provider" }, { errors: [] }, { status: "success" }, { message: "private-provider" }]) {
    const fixture = fake({ token: () => Response.json({ ...token(), ...patch }) });
    await assert.rejects(captureLocalZohoSource(credentials, fixture.fetcher), error("TOKEN_INVALID"));
    assert.equal(fixture.calls.length, 1);
  }
});

test("bootstrap requires exact VOLTRONIX production company, one valid org, and clean raw nested envelopes", async () => {
  const bodies: unknown[] = [
    { org: [] }, { org: [...organization().org, ...organization().org] },
    ...[{ company_name: "OTHER" }, { company_name: "Voltronix" }, { company_name: "VOLTRONIX " }, { type: "sandbox" }, { id: "1/Notes" },
      { error: "private-provider" }, { errors: [] }, { code: "SUCCESS" }, { status: "success" }, { message: "private-provider" }]
      .map(patch => ({ org: [{ ...organization().org[0], ...patch }] })),
    ...["error", "errors", "code", "status", "message"].map(key => ({ ...organization(), [key]: "private-provider" })),
  ];
  for (const body of bodies) {
    const fixture = fake({ org: () => Response.json(body) });
    await assert.rejects(captureLocalZohoSource(credentials, fixture.fetcher), error("ORGANIZATION_MISMATCH"));
    assert.equal(fixture.calls.length, 2);
  }
});

test("verified-client recheck rejects changed organization before any business GET", async () => {
  const fixture = fake({ org: count => Response.json(count === 1 ? organization() : { org: [{ ...organization().org[0], id: "999" }] }) });
  await assert.rejects(captureLocalZohoSource(credentials, fixture.fetcher), error("ORGANIZATION_MISMATCH"));
  assert.equal(fixture.calls.length, 4);
});

test("read-only capture retains approved inbound reason codes without exposing rejected source records", async () => {
  const invalidShape = fake({ business: () => Response.json({ data: [{ id: "101", Product_Name: "private-customer" }],
    info: { page: 1, per_page: 200, count: 1, more_records: false, sort_by: "id", sort_order: "asc" } }) });
  await assert.rejects(captureLocalZohoSource(credentials, invalidShape.fetcher), error("INBOUND_RESPONSE_INVALID"));
  const invalidPage = fake({ business: () => Response.json({ data: [], info: { page: 2, per_page: 200, count: 0, more_records: false } }) });
  await assert.rejects(captureLocalZohoSource(credentials, invalidPage.fetcher), error("INBOUND_PAGINATION_INVALID"));
  const denied = fake({ business: () => Response.json({ message: "private-provider" }, { status: 403 }) });
  await assert.rejects(captureLocalZohoSource(credentials, denied.fetcher), error("INBOUND_ACCESS_DENIED"));
  const limited = fake({ business: () => Response.json({ message: "private-provider" }, { status: 429 }) });
  await assert.rejects(captureLocalZohoSource(credentials, limited.fetcher), error("INBOUND_RATE_LIMITED"));
  assert.equal(invalidShape.calls.length, 5); assert.equal(denied.calls.length, 5);
});

test("bootstrap enforces token/org response size bounds and JSON media without reflecting contents", async () => {
  const hugeToken = fake({ token: () => Response.json({ ...token(), private: "x".repeat(70_000) }) });
  await assert.rejects(captureLocalZohoSource(credentials, hugeToken.fetcher), error("RESPONSE_TOO_LARGE"));
  const hugeOrg = fake({ org: () => Response.json({ ...organization(), private: "x".repeat(270_000) }) });
  await assert.rejects(captureLocalZohoSource(credentials, hugeOrg.fetcher), error("RESPONSE_TOO_LARGE"));
  const html = fake({ token: () => new Response("private-provider", { headers: { "Content-Type": "text/html" } }) });
  await assert.rejects(captureLocalZohoSource(credentials, html.fetcher), error("RESPONSE_INVALID"));
});

test("bootstrap rejects redirects and HTTP errors and sanitizes thrown transport failures without retry", async () => {
  for (const response of [Response.redirect("https://elsewhere.invalid", 302), Response.json({ message: "private-provider" }, { status: 500 })]) {
    const fixture = fake({ token: () => response });
    await assert.rejects(captureLocalZohoSource(credentials, fixture.fetcher), error("HTTP_FAILED")); assert.equal(fixture.calls.length, 1);
  }
  const redirected = Response.json(token()); Object.defineProperty(redirected, "redirected", { value: true });
  await assert.rejects(captureLocalZohoSource(credentials, fake({ token: () => redirected }).fetcher), error("HTTP_FAILED"));
  const fail: typeof fetch = async () => { throw new Error("synthetic-secret private-provider"); };
  await assert.rejects(captureLocalZohoSource(credentials, fail), error("REQUEST_FAILED"));
});

test("bootstrap deadline bounds a fetch ignoring abort and cancels a response arriving after timeout", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish!: (response: Response) => void, cancelled = false;
  const fetcher: typeof fetch = () => new Promise(resolve => { finish = resolve; });
  const rejected = assert.rejects(captureLocalZohoSource(credentials, fetcher), error("TIMEOUT"));
  t.mock.timers.tick(20_000); await rejected;
  finish(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { "Content-Type": "application/json" } }));
  await setImmediate(); assert.equal(cancelled, true);
});

test("bootstrap deadline also cancels an indefinitely stalled response stream", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"access_token":')); },
    cancel() { cancelled = true; } });
  const fetcher: typeof fetch = async () => new Response(stream, { headers: { "Content-Type": "application/json" } });
  const rejected = assert.rejects(captureLocalZohoSource(credentials, fetcher), error("TIMEOUT"));
  await setImmediate(); assert.equal(stream.locked, true);
  t.mock.timers.tick(20_000); await rejected; await setImmediate();
  assert.equal(cancelled, true); assert.equal(stream.locked, false);
});

test("source diagnostic constructor refuses arbitrary strings as reason codes", () => {
  const value = new LocalZohoSourceError("synthetic-secret private-provider" as LocalZohoSourceCode);
  assert.equal(value.code, "UNAVAILABLE"); assert.doesNotMatch(`${value.stack}`, /synthetic-secret|private-provider/);
});

test("source propagates only revalidated static inbound diagnostic categories", async () => {
  const fixture = fake({ business: () => Response.json({ data: [{ id: "101", Product_Name: "private-customer", Unit_Price: "private-provider",
    Created_Time: "2026-01-01T00:00:00Z", Modified_Time: "2026-01-01T00:00:00Z" }],
  info: { page: 1, per_page: 200, count: 1, more_records: false, sort_by: "id", sort_order: "asc" } }) });
  await assert.rejects(captureLocalZohoSource(credentials, fixture.fetcher), value => {
    assert.ok(value instanceof LocalZohoSourceError); assert.equal(value.code, "INBOUND_RESPONSE_INVALID");
    assert.deepEqual(value.diagnostic, { module: "Products", field: "Unit_Price", issue: "decimal_noncanonical" });
    assert.ok(Object.isFrozen(value.diagnostic)); assert.doesNotMatch(JSON.stringify(value), /private-provider|private-customer/); return true;
  });
  const invalid = new LocalZohoSourceError("INBOUND_RESPONSE_INVALID", { module: "Products", field: "private-customer", issue: "invalid_type" });
  assert.equal(invalid.diagnostic, undefined);
});
