import assert from "node:assert/strict";
import test from "node:test";
import { createZohoClient, ZohoClientError } from "../src/integrations/zoho/client.js";
import { createZohoTransports, type VerifiedZohoRequestPort } from "../src/integrations/zoho/transports.js";
import { buildZohoV8QuotationCreate, buildZohoV8QuotationEdit, parseZohoV8QuotationReadback,
  ZOHO_V8_QUOTATION_PROFILE as profile, type ZohoV8QuotationPlan } from "../src/integrations/zoho/quotation-v8.js";
import { executeZohoV8Quotation, ZohoV8QuotationExecutionError,
  type ZohoV8QuotationExecutionFailure } from "../src/integrations/zoho/quotation-v8-execution.js";

const quote = { subject: "Synthetic quotation", kindAttention: "Synthetic contact", discount: "5", discountType: "percentage" as const,
  adjustment: "-1", items: [{ productId: "101", productName: "Synthetic item", description: "Synthetic description", uom: "NOS" as const,
    quantity: "2", unitPrice: "100", itemDiscount: "10" }] };
const links = { dealId: "201", contactId: "301" }, modifiedTime = "2026-10-15T12:00:00+04:00";
const create = () => buildZohoV8QuotationCreate(quote, links, profile);
const receipt = (id = "401") => ({ status: 201, body: { data: [{ code: "SUCCESS", status: "success", details: { id }, message: "record added" }] } });
function readback(plan: ZohoV8QuotationPlan, quoteId = "401") {
  const { header, financials, lines } = plan.expected;
  return { data: [{ id: quoteId, Quote_No: "Q-SYNTHETIC-1", Modified_Time: modifiedTime,
    Deal_Name: { id: links.dealId }, Contact_Name: { id: links.contactId }, Subject: header.subject,
    Valid_Till: header.validUntil, Project: header.Project, Terms_of_Payment: header.Terms_of_Payment,
    Specification: header.Specification, General_Exclusion: header.General_Exclusion, Brand: header.Brand,
    Warranty: header.Warranty, Delivery: header.Delivery, Discount: financials.discount, Tax: financials.tax,
    Adjustment: financials.adjustment, Sub_Total: financials.subtotal, Grand_Total: financials.grandTotal,
    Quoted_Items: lines.map((line, index) => ({ id: line.rowId ?? String(501 + index), Product_Name: { id: line.productId },
      Quantity: line.quantity, List_Price: line.unitPrice, ItemDiscount: line.itemDiscount, U_O_M: line.uom,
      Description: line.description, Net_Total: line.netTotal, Parent_Id: { id: quoteId } })),
    $has_more: { Quoted_Items: false } }] };
}
function fixture(plan: ZohoV8QuotationPlan, replies: { status: number; body: unknown }[] = [receipt(), { status: 200, body: readback(plan) }]) {
  const calls: Parameters<VerifiedZohoRequestPort["request"]>[0][] = [];
  const port: VerifiedZohoRequestPort = { async request(request) { calls.push(request);
    const next = replies.shift(); assert.ok(next, "No additional requests or implicit retry"); return next;
  } };
  return { port, calls };
}
function failure(code: ZohoV8QuotationExecutionFailure, attempted = true) {
  return (error: unknown) => {
    assert.ok(error instanceof ZohoV8QuotationExecutionError); assert.equal(error.code, code);
    assert.equal(error.remoteWriteAttempted, attempted); assert.equal(error.cause, undefined);
    assert.doesNotMatch(String(error.stack), /private-marker|401|Synthetic quotation/); return true;
  };
}

test("v8 execution sends exactly the branded create request and verifies readback without local persistence", async () => {
  const plan = create(), mock = fixture(plan), result = await executeZohoV8Quotation(mock.port, plan);
  assert.equal(mock.calls.length, 2); assert.equal(mock.calls[0], plan.request);
  assert.deepEqual(Object.keys(mock.calls[0]!).sort(), ["apiVersion", "body", "exactDecimalSerialization", "method", "path"]);
  assert.equal(mock.calls[1]!.method, "GET"); assert.match(mock.calls[1]!.path, /^\/Quotes\/401\?fields=/);
  assert.equal(result.quoteId, "401"); assert.equal(result.quoteNumber, "Q-SYNTHETIC-1");
  assert.equal(result.modifiedTime, modifiedTime); assert.equal(result.normalizedInput, plan.normalizedInput);
  assert.equal(result.snapshot.financials.grandTotal, "178.55"); assert.equal(result.snapshot.lines[0]!.rowId, "501");
  assert.equal(result.localCommitPerformed, false); assert.equal(result.productionAcceptance, false); assert.ok(Object.isFrozen(result));
});

test("edit execution preserves explicit subform row identity and exact modification-time precondition", async () => {
  const initial = create(), previous = parseZohoV8QuotationReadback(readback(initial), "401", profile);
  const plan = buildZohoV8QuotationEdit({ ...quote, subject: "Edited synthetic quotation" }, links, previous, ["501"], profile);
  const mock = fixture(plan), result = await executeZohoV8Quotation(mock.port, plan);
  assert.equal(mock.calls[0]!.method, "PUT"); assert.equal(mock.calls[0]!.path, "/Quotes/401");
  assert.equal(mock.calls[0]!.ifUnmodifiedSince, modifiedTime); assert.equal(result.snapshot.lines[0]!.rowId, "501");
  assert.equal(mock.calls.length, 2);
  const wrong = fixture(plan, [receipt("402")]);
  await assert.rejects(executeZohoV8Quotation(wrong.port, plan), failure("ACKNOWLEDGEMENT_INVALID"));
  assert.equal(wrong.calls.length, 1);
});

test("forged, cloned and accessor-bearing plans are refused before touching a port", async () => {
  const plan = create(), mock = fixture(plan);
  for (const value of [null, {}, structuredClone(plan), { ...plan }, { get request() { throw new Error("private-marker"); } }]) {
    await assert.rejects(executeZohoV8Quotation(mock.port, value as ZohoV8QuotationPlan), failure("INPUT_INVALID", false));
  }
  for (const port of [null, {}, { get request() { throw new Error("private-marker"); } }]) {
    await assert.rejects(executeZohoV8Quotation(port as VerifiedZohoRequestPort, plan), failure("INPUT_INVALID", false));
  }
  assert.equal(mock.calls.length, 0);
});

test("a write failure or precondition conflict is redacted and is never retried or followed by readback", async () => {
  const plan = create();
  for (const [status, code] of [[401, "WRITE_FAILED"], [412, "PRECONDITION_FAILED"], [429, "WRITE_FAILED"], [503, "WRITE_FAILED"]] as const) {
    const mock = fixture(plan, [{ status, body: { message: "private-marker" } }]);
    await assert.rejects(executeZohoV8Quotation(mock.port, plan), failure(code)); assert.equal(mock.calls.length, 1);
    let attempts = 0;
    await assert.rejects(executeZohoV8Quotation({ async request() { attempts++; throw new ZohoClientError("HTTP_FAILED", status); } }, plan), failure(code));
    assert.equal(attempts, 1);
  }
  await assert.rejects(executeZohoV8Quotation({ async request() { throw new Error("private-marker"); } }, plan), failure("WRITE_FAILED"));
});

test("malformed acknowledgements never identify a record or cause a follow-up request", async () => {
  const plan = create();
  for (const body of [null, {}, { data: [] }, { data: receipt().body.data.concat(receipt().body.data) },
    { ...receipt().body, error: "private-marker" }, { data: [{ ...receipt().body.data[0], error: "private-marker" }] },
    { data: [{ ...receipt().body.data[0], status: "error" }] }, { data: [{ ...receipt().body.data[0], details: { id: "0" } }] },
    { data: [{ ...receipt().body.data[0], details: { id: 401 } }] }, { get data() { throw new Error("private-marker"); } }]) {
    const mock = fixture(plan, [{ status: 200, body }]);
    await assert.rejects(executeZohoV8Quotation(mock.port, plan), failure("ACKNOWLEDGEMENT_INVALID")); assert.equal(mock.calls.length, 1);
  }
});

test("readback transport and malformed response failures never return a receipt as completed work", async () => {
  const plan = create();
  for (const response of [{ status: 503, body: { message: "private-marker" } }, { status: 204, body: null }]) {
    const mock = fixture(plan, [receipt(), response]);
    await assert.rejects(executeZohoV8Quotation(mock.port, plan), failure("READBACK_FAILED")); assert.equal(mock.calls.length, 2);
  }
  for (const body of [null, { data: [] }, { ...readback(plan), error: "private-marker" },
    { data: [{ ...readback(plan).data[0], id: "402" }] }, { data: [{ ...readback(plan).data[0], $has_more: { Quoted_Items: true } }] },
    { get data() { throw new Error("private-marker"); } }]) {
    const mock = fixture(plan, [receipt(), { status: 200, body }]);
    await assert.rejects(executeZohoV8Quotation(mock.port, plan), failure("READBACK_INVALID")); assert.equal(mock.calls.length, 2);
  }
  let attempts = 0;
  await assert.rejects(executeZohoV8Quotation({ async request() {
    if (++attempts === 1) return receipt(); throw new Error("private-marker");
  } }, plan), failure("READBACK_FAILED")); assert.equal(attempts, 2);
});

test("readback requires exact parent, terms, line values and financial totals before reporting success", async () => {
  const plan = create();
  for (const patch of [{ Contact_Name: { id: "302" } }, { Subject: "private-marker" }, { Grand_Total: "999" },
    { Quoted_Items: readback(plan).data[0]!.Quoted_Items.map(line => ({ ...line, Quantity: "3" })) }]) {
    const mock = fixture(plan, [receipt(), { status: 200, body: { data: [{ ...readback(plan).data[0], ...patch }] } }]);
    await assert.rejects(executeZohoV8Quotation(mock.port, plan), failure("READBACK_MISMATCH")); assert.equal(mock.calls.length, 2);
  }
});

test("offline execution composes with the verified client and commercial bridge for exact numeric wire data", async t => {
  const plan = create(), paths: string[] = [];
  const client = createZohoClient({ clientId: "synthetic-client", clientSecret: "synthetic-secret", refreshToken: "synthetic-refresh",
    environment: "sandbox", organizationId: "123", allowWrites: true }, { networkEnabled: true, fetch: async (input, init) => {
    const url = new URL(String(input)); paths.push(url.pathname);
    if (url.pathname === "/oauth/v2/token") return Response.json({ access_token: "synthetic-access", expires_in: 3600,
      api_domain: "https://www.zohoapis.com", token_type: "Bearer" });
    assert.equal(url.origin, "https://sandbox.zohoapis.com");
    if (url.pathname === "/crm/v8/org") return Response.json({ org: [{ id: "123", type: "sandbox" }] });
    if (init?.method === "POST") {
      assert.equal(url.pathname, "/crm/v8/Quotes");
      const body = JSON.parse(String(init.body)) as { data: { Discount: number; $line_tax: unknown }[] };
      assert.equal(body.data[0]!.Discount, 9); assert.equal("Tax" in body.data[0]!, false);
      assert.deepEqual(body.data[0]!.$line_tax, [{ name: "Vat", percentage: 5 }]);
      return Response.json(receipt().body, { status: 201 });
    }
    assert.equal(init?.method, "GET"); assert.equal(url.pathname, "/crm/v8/Quotes/401");
    return Response.json(readback(plan));
  } });
  t.after(() => client.close());
  const result = await executeZohoV8Quotation(createZohoTransports(client).commercial, plan);
  assert.equal(result.quoteId, "401"); assert.equal(result.productionAcceptance, false);
  assert.deepEqual(paths, ["/oauth/v2/token", "/crm/v8/org", "/crm/v8/Quotes", "/crm/v8/Quotes/401"]);
});
