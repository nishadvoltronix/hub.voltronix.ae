import assert from "node:assert/strict";
import test from "node:test";
import { createZohoClient } from "../src/integrations/zoho/client.js";
import { createZohoTransports } from "../src/integrations/zoho/transports.js";
import { createProductContract } from "../src/crm/commercial/products.js";
import { buildAccountPayload, buildContactPayload, buildDealPayload } from "../src/crm/commercial/deals.js";
import { executeQuotationContract } from "../src/crm/commercial/quote-contract.js";

const config = { clientId: "synthetic-client", clientSecret: "synthetic-secret", refreshToken: "synthetic-refresh",
  environment: "sandbox" as const, organizationId: "12345", allowWrites: true };
const success = (id: string) => ({ data: [{ code: "SUCCESS", status: "success", details: { id } }] });
function fixture(replies: { body?: unknown; raw?: string; status?: number }[]) {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth/v2/token") return Response.json({ access_token: "synthetic-access", expires_in: 3600,
      api_domain: "https://www.zohoapis.com", token_type: "Bearer" });
    assert.equal(url.origin, "https://sandbox.zohoapis.com");
    if (url.pathname === "/crm/v8/org") return Response.json({ org: [{ id: config.organizationId, type: "sandbox" }] });
    calls.push({ path: url.pathname + url.search, method: init?.method ?? "GET",
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }) });
    const next = replies.shift(); assert.ok(next, "No implicit retries or extra business calls");
    return new Response(next.status === 204 ? null : next.raw ?? JSON.stringify(next.body), {
      status: next.status ?? 200, headers: { "Content-Type": "application/json" },
    });
  };
  const client = createZohoClient(config, { fetch: request, networkEnabled: true });
  return { client, ports: createZohoTransports(client), calls, remaining: () => replies.length };
}

test("OFFLINE real HTTP bridge runs product create/search/list contracts with exact numeric wire prices", async t => {
  const mock = fixture([{ body: success("101") },
    { raw: '{"data":[{"id":"101","Product_Name":"Test item","Description":null,"Unit_Price":9007199254740993.123456789012345678}]}' },
    { raw: '{"data":[{"id":"101","Product_Name":"Test item","Description":null,"Unit_Price":0.01}],"info":{"more_records":false}}' }]);
  t.after(() => mock.client.close());
  const contract = createProductContract(mock.ports.commercial);
  assert.deepEqual(await contract.create({ name: "Test item", description: "Synthetic only" }), { externalId: "101" });
  assert.equal((await contract.search("Test item"))[0]!.unitPrice, "9007199254740993.123456789012345678");
  assert.equal((await contract.list(1)).items[0]!.unitPrice, "0.01");
  assert.match(mock.calls[0]!.path, /^\/crm\/v2\.1\/Products$/);
  assert.match(mock.calls[1]!.path, /^\/crm\/v8\/Products\/search\?/);
  assert.equal(mock.remaining(), 0);
});

test("OFFLINE v8 lead HTTP bridge accepts source account/contact/deal relationship payloads and stage/note paths", async t => {
  const mock = fixture(["201", "301", "401", "401", "501", "501"].map(id => ({ body: success(id) })));
  t.after(() => mock.client.close());
  const deal = { firstName: "Synthetic", lastName: "Contact", companyName: "Synthetic company", email: "test@example.invalid",
    mobile: "+971 0000000", phone: "+971 0000001", department: "VOLTRONIX CONTRACTING LLC", address: "Fixture only",
    poBox: "TEST", trn: "00000", description: "Offline fixture, never sent" };
  for (const [path, body] of [["/Accounts", buildAccountPayload(deal, "601")],
    ["/Contacts", buildContactPayload(deal, "201")],
    ["/Deals", buildDealPayload(deal, { accountId: "201", contactId: "301", assignedExternalId: "601" })]] as const) {
    assert.equal((await mock.ports.leads.request({ method: "POST", path, body })).status, 200);
  }
  await mock.ports.leads.request({ method: "PUT", path: "/Deals/401", body: { data: [{ Stage: "Site Visit", VZ_App_Status: "Site Visit" }] } });
  await mock.ports.leads.request({ method: "POST", path: "/Deals/401/Notes", body: { data: [{ Note_Title: "Synthetic", Note_Content: "Offline note" }] } });
  await mock.ports.leads.request({ method: "PUT", path: "/Notes/501", body: { data: [{ Note_Title: "Synthetic", Note_Content: "Edited offline" }] } });
  assert.ok(mock.calls.every(call => call.path.startsWith("/crm/v8/")));
  assert.equal(mock.remaining(), 0);
});

test("OFFLINE quotation HTTP sequencing preserves contract versions and never claims local commit or financial parity", async t => {
  const mock = fixture([{ status: 204 }, { body: success("301") },
    { body: { data: [{ id: "101", Description: "Source description" }] } }, { body: success("701") },
    { body: { data: [{ id: "701", Quote_No: "QUOTE-1", Modified_Time: "2026-10-15T12:00:00+04:00" }] } }, { body: success("401") }]);
  t.after(() => mock.client.close());
  const quote = { subject: "Synthetic quote", kindAttention: "Fixture contact", discount: "0", discountType: "percentage" as const,
    adjustment: "0", validUntil: "2026-10-31", items: [{ productId: "101", productName: "Test item", description: "", uom: "NOS",
      quantity: "2", unitPrice: "100", itemDiscount: "0" }] };
  const result = await executeQuotationContract(mock.ports.commercial, quote, "401", { operation: "create" });
  assert.equal(result.localCommitPerformed, false);
  assert.equal(result.dealTransition, "acknowledged");
  assert.equal(result.quoteId, "701");
  assert.equal(mock.remaining(), 0);
  assert.ok(mock.calls.every(call => call.path.startsWith("/crm/v2.1/")));
});

test("OFFLINE transport bridge cannot send local synthetic product IDs through a quotation payload", async t => {
  const mock = fixture([]); t.after(() => mock.client.close());
  await assert.rejects(mock.ports.commercial.request({ method: "POST", apiVersion: "v2.1", path: "/Quotes",
    body: { data: [{ Subject: "Synthetic", Quoted_Items: [{ Product_Name: { id: "1".repeat(40) } }] }] } }));
  assert.equal(mock.calls.length, 0);
});

test("OFFLINE commercial bridge preserves quote concurrency and exact-decimal options without forwarding local hints", async t => {
  const mock = fixture([{ body: success("701") }]); t.after(() => mock.client.close());
  const request = { apiVersion: "v8" as const, method: "PUT" as const, path: "/Quotes/701",
    body: { data: [{ id: "701", Discount: "0.50" }] }, ifUnmodifiedSince: "2026-10-15T00:00:00Z",
    exactDecimalSerialization: "quote-v8" as const, localCommitPerformed: false };
  assert.equal((await mock.ports.commercial.request(request)).status, 200);
  assert.equal(mock.calls[0]!.path, "/crm/v8/Quotes/701");
  assert.deepEqual(mock.calls[0]!.body, { data: [{ id: "701", Discount: 0.5 }] });
});
