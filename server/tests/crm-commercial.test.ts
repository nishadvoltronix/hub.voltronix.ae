import assert from "node:assert/strict";
import test from "node:test";
import { buildAccountPayload, buildAccountSearchPath, buildContactPayload, buildDealPayload, parseDealInput } from "../src/crm/commercial/deals.js";
import { decimal, exact, money, multiply } from "../src/crm/commercial/decimal.js";
import { buildProductPayload, buildProductSearchPath, createProductContract } from "../src/crm/commercial/products.js";
import { calculateLocalQuotation, calculateQuotation, buildQuotationRequest, buildQuotedDealTransition, inspectQuotationRules, parseLocalQuotationInput, parseQuotationInput } from "../src/crm/commercial/quotations.js";
import { executeQuotationContract } from "../src/crm/commercial/quote-contract.js";
import { type CommercialRequest, type CommercialTransport, parseWriteId } from "../src/crm/commercial/transport.js";
import { CommercialError } from "../src/crm/commercial/validation.js";

// Explicit synthetic contract fixtures. No SQLite files, credentials, sockets or CRM records.
const deal = { firstName: "Test", lastName: "Contact", companyName: "Synthetic & Co", email: "test@example.invalid",
  mobile: "+971 0000000", phone: "+971 0000001", department: "VOLTRONIX CONTRACTING LLC",
  address: "Fixture address", poBox: "TEST", trn: "00000", description: "Only a unit fixture" };
const item = { productId: "101", productName: "Synthetic fixture", description: "Fixture description",
  uom: "NOS", quantity: "2", unitPrice: "100", itemDiscount: "10" };
const quote = { subject: "Synthetic quote", kindAttention: "Fixture contact", discount: "5", discountType: "percentage" as const, adjustment: "-1",
  validUntil: "2026-10-31", items: [item] };
const links = { dealId: "201", contactId: "301", contactName: "Fixture contact" };
const success = (id: string) => ({ status: 200, body: { data: [{ code: "SUCCESS", status: "success", details: { id } }] } });
const details = { status: 200, body: { data: [{ id: "401", Quote_No: "Q-2026-9", Modified_Time: "2026-10-10T12:00:00+04:00" }] } };
function expectError(status: number) { return (error: unknown) => error instanceof CommercialError && error.status === status; }
function mock(replies: Array<{ status: number; body: unknown } | Error>) {
  const calls: CommercialRequest[] = [];
  const transport: CommercialTransport = { async request(request) {
    calls.push(structuredClone(request));
    const response = replies.shift();
    if (response instanceof Error) throw response;
    assert.ok(response, "Unexpected contract request");
    return response;
  } };
  return { calls, transport, remaining: () => replies.length };
}

test("deal payloads map verified account/contact/deal relationships without an invented owner or enquiry", () => {
  const parsed = parseDealInput(deal);
  assert.equal(parsed.firstName, "Test");
  assert.deepEqual(buildAccountPayload(parsed, "501"), { data: [{ Account_Name: deal.companyName, Phone: deal.phone,
    Email: deal.email, Owner: { id: "501" } }] });
  const contact = buildContactPayload(parsed, "601").data[0]!;
  assert.deepEqual(contact.Account_Name, { id: "601" });
  assert.equal(contact.Mailing_Street, "Fixture address");
  const result = buildDealPayload(parsed, { accountId: "601", contactId: "701", assignedExternalId: "801" }).data[0]!;
  assert.equal(result.Deal_Name, "Test Contact"); assert.equal(result.Stage, "Qualification");
  assert.equal(result.VZ_App_Status, "Pending"); assert.deepEqual(result.VZ_app_user, { id: "801" });
  assert.equal("EnquiryNumber" in result, false); assert.equal("Owner" in result, false);
  assert.match(buildAccountSearchPath(deal.companyName), /Synthetic%20%26%20Co/);
});
test("commercial input rejects unknown fields, missing names, invalid email, unverified department and external IDs", () => {
  for (const invalid of [{ ...deal, firstName: "" }, { ...deal, email: "bad" }, { ...deal, department: "fake" },
    { ...deal, owner: "1" }, { ...deal, lastName: "bad\nname" }]) assert.throws(() => parseDealInput(invalid), expectError(400));
  for (const id of ["", "https://elsewhere.invalid", "1/Notes", "0", "1 OR 1=1"]) assert.throws(() => buildAccountPayload(deal, id), expectError(400));
  assert.throws(() => buildAccountSearchPath("name),(id:equals:1)"), expectError(400));
});
test("decimal math preserves values beyond JavaScript safe integers and rounds only at presentation", () => {
  assert.equal(exact(multiply(decimal("9007199254740993"), decimal("1.000000000000000001"))), "9007199254740993.009007199254740993");
  assert.equal(money(decimal("1.005")), "1.01"); assert.equal(money(decimal("-1.005")), "-1.01");
  assert.equal(money(decimal("-0.004")), "0.00");
  for (const invalid of ["NaN", "Infinity", "1e2", "01", "1.0000000000000000001"]) assert.throws(() => decimal(invalid), expectError(400));
});
test("quote creation recomputes percentage lines and header, 5 percent VAT and signed adjustment", () => {
  const result = calculateQuotation(quote, "percentage");
  assert.deepEqual(result.lineTotals, ["180.00"]); assert.equal(result.subtotal, "180.00");
  assert.equal(result.taxable, "171.00"); assert.equal(result.vatAmount, "8.55"); assert.equal(result.grandTotal, "178.55");
  assert.throws(() => calculateQuotation({ ...quote, discount: "500", adjustment: "0" }, "percentage"), expectError(400));
});

test("quotations preserve synchronized product names through 255 characters without changing amounts", () => {
  const productName = "S".repeat(255), input = { ...quote, items: [{ ...item, productName }] };
  assert.equal(parseQuotationInput(input).items[0]!.productName, productName);
  assert.equal(parseLocalQuotationInput(input).items[0]!.productName, productName);
  assert.deepEqual(calculateQuotation(input), calculateQuotation(quote));
  assert.throws(() => parseQuotationInput({ ...input, items: [{ ...item, productName: "S".repeat(256) }] }), expectError(400));
  assert.throws(() => buildProductPayload({ name: "S".repeat(201), description: "Synthetic" }), expectError(400));
});
test("quote totals add unrounded lines and handle fractional quantities without binary float drift", () => {
  const result = calculateQuotation({ ...quote, discount: "0", adjustment: "0", items: [
    { ...item, quantity: "0.5", unitPrice: "0.01", itemDiscount: "0" },
    { ...item, quantity: "0.5", unitPrice: "0.01", itemDiscount: "0" },
  ] }, "percentage");
  assert.deepEqual(result.lineTotals, ["0.01", "0.01"]); assert.equal(result.exactSubtotal, "0.01");
  assert.equal(result.subtotal, "0.01"); assert.equal(result.grandTotal, "0.01");
});

test("percentage header bounds, unrounded deduction and display rounding remain exact", () => {
  const input = { ...quote, discount: "33.333333333333333333", adjustment: "0", items: [
    { ...item, quantity: "0.5", unitPrice: "0.01", itemDiscount: "0" },
    { ...item, quantity: "0.5", unitPrice: "0.01", itemDiscount: "0" },
  ] };
  const value = calculateLocalQuotation(input);
  assert.equal(value.exactSubtotal, "0.01"); assert.equal(value.headerDiscount, "0.0033333333333333333333");
  assert.equal(value.headerDiscountAmount, "0.00"); assert.equal(value.grandTotal, "0.01");
  for (const discount of ["0", "100"]) assert.equal(calculateLocalQuotation({ ...input, discount }).grandTotal, discount === "0" ? "0.01" : "0.00");
  for (const patch of [{ discount: "-1" }, { discount: "100.000000000000000001" }, { discountType: "fixed" }, { discountType: undefined }]) {
    assert.throws(() => calculateLocalQuotation({ ...input, ...patch }), expectError(400));
  }
});
test("explicit local quotations preserve optional attention without changing arithmetic or other validation", () => {
  const local = parseLocalQuotationInput({ ...quote, kindAttention: "  " });
  assert.equal(local.kindAttention, "");
  assert.deepEqual(calculateLocalQuotation(local), calculateQuotation(quote, "percentage"));
  assert.deepEqual(parseLocalQuotationInput(quote), parseQuotationInput(quote));
  for (const patch of [{ subject: "" }, { kindAttention: "bad\nname" }, { kindAttention: null },
    { kindAttention: "x".repeat(201) }, { unknown: true }, { items: [] }]) {
    assert.throws(() => parseLocalQuotationInput({ ...quote, ...patch }), expectError(400));
  }
});
test("blank local attention never becomes a remote contact request or invented name", async () => {
  const local = parseLocalQuotationInput({ ...quote, kindAttention: "" }), fixture = mock([]);
  assert.throws(() => parseQuotationInput(local), expectError(400));
  assert.throws(() => buildQuotationRequest(local, links, { operation: "create" }), expectError(400));
  await assert.rejects(() => executeQuotationContract(fixture.transport, local, "201", { operation: "create" }), expectError(400));
  await assert.rejects(() => executeQuotationContract(fixture.transport, local, "201", { operation: "edit", quoteId: "401" }), expectError(400));
  assert.deepEqual(fixture.calls, []);
});
test("historical edit inconsistency remains characterized; active contract uses approved percentages", () => {
  const diagnostics = inspectQuotationRules(quote);
  assert.equal(diagnostics.formAndCreate.subtotal, "180.00"); assert.equal(diagnostics.editServer.subtotal, "190.00");
  assert.equal(diagnostics.hasAmbiguousEditDiscount, true);
  assert.equal(buildQuotationRequest(quote, links, { operation: "edit", quoteId: "401" }).totals.subtotal, "180.00");
  const undiscounted = { ...quote, items: [{ ...item, itemDiscount: "0" }] };
  assert.equal(buildQuotationRequest(undiscounted, links, { operation: "edit", quoteId: "401" }).method, "PUT");
});
test("quote payload retains source subtotal instead of pretending the browser grand total reaches Zoho", () => {
  const request = buildQuotationRequest(quote, links, { operation: "create" });
  const payload = request.body.data[0]!;
  assert.equal(payload.Amount, "180.00"); assert.equal(request.totals.grandTotal, "178.55");
  assert.equal(payload.Valid_Till, "2026-10-31"); assert.equal("Tax" in payload, false);
  assert.equal("Discount" in payload, false); assert.equal("Grand_Total" in payload, false); assert.equal("notes" in payload, false);
  assert.deepEqual(payload.Quoted_Items[0], { Product_Name: { id: "101" }, Quantity: "2", List_Price: "100", ItemDiscount: "10", U_O_M: "NOS", Description: "Fixture description" });
  assert.deepEqual(buildQuotedDealTransition("201", "Q-2026-9").body.data[0], { id: "201", Stage: "Proposal/Price Quote", QuoteDealNumber: "Q-2026-9" });
  assert.equal(buildQuotedDealTransition("201", "Q-2026-9").localQuoteDealNumber, "QUOTE-9");
});
test("quotes reject posted totals, invalid dates, invalid quantity/rate/discount, unsupported UOM and empty lines", () => {
  for (const invalid of [{ ...quote, grandTotal: "1" }, { ...quote, validUntil: "2026-02-30" }, { ...quote, items: [] },
    ...[{ quantity: "0" }, { unitPrice: "-1" }, { itemDiscount: "101" }, { itemDiscount: "NaN" }, { uom: "invented" }, { total: "1" }]
      .map((patch) => ({ ...quote, items: [{ ...item, ...patch }] }))]) {
    assert.throws(() => calculateQuotation(invalid, "percentage"), expectError(400));
  }
});
test("product contract preserves source versions, bounded paging and minimum search length", async () => {
  const fixture = mock([{ status: 200, body: { data: [{ id: "101", Product_Name: "Fixture", Unit_Price: "1.01" }], info: { more_records: true } } },
    { status: 204, body: null }]);
  const products = createProductContract(fixture.transport);
  assert.deepEqual(await products.search("x"), []); assert.equal(fixture.calls.length, 0);
  const page = await products.list(2);
  assert.equal(page.items[0]?.unitPrice, "1.01"); assert.equal(page.items[0]?.description, null);
  assert.equal(page.moreRecords, true); assert.equal(fixture.calls[0]?.apiVersion, "v2.1");
  assert.match(fixture.calls[0]?.path ?? "", /page=2&per_page=200/);
  assert.deepEqual(await products.search("AB"), []); assert.equal(fixture.calls[1]?.apiVersion, "v8");
  assert.match(fixture.calls[1]?.path ?? "", /per_page=50/); assert.equal(fixture.remaining(), 0);
  assert.throws(() => buildProductSearchPath("xx),(id:equals:1)"), expectError(400));
});
test("product creation is one source-backed remote write and never retries an uncertain write", async () => {
  const input = { name: "Fixture product", description: "Only test data" };
  assert.deepEqual(buildProductPayload(input), { data: [{ Product_Name: input.name, Description: input.description }] });
  const fixture = mock([success("101")]);
  assert.deepEqual(await createProductContract(fixture.transport).create(input), { externalId: "101" });
  assert.equal(fixture.calls[0]?.method, "POST"); assert.equal(fixture.calls.length, 1);
  const failure = mock([new Error("sensitive provider details")]);
  await assert.rejects(() => createProductContract(failure.transport).create(input), (error: unknown) =>
    error instanceof CommercialError && error.status === 502 && !error.message.includes("sensitive"));
  assert.equal(failure.calls.length, 1);
});
test("product and write response parsing rejects errors masquerading as success or empty results", async () => {
  assert.throws(() => parseWriteId({ data: [{ code: "INVALID_DATA", details: { id: "101" } }] }), expectError(502));
  for (const reply of [{ status: 401, body: { access_token: "fixture-invalid-response" } },
    { status: 200, body: { error: "bad" } }, { status: 200, body: { data: [{ id: "101", Product_Name: "Fixture", Unit_Price: 0.1 }] } }]) {
    const fixture = mock([reply]);
    await assert.rejects(() => createProductContract(fixture.transport).search("AB"), expectError(502));
  }
});
test("mock quote creation resolves contact/product, creates quote, reads its number, then transitions deal", async () => {
  const fixture = mock([{ status: 204, body: null }, success("301"),
    { status: 200, body: { data: [{ id: "101", Description: "Resolved fixture description" }] } },
    success("401"), details, success("201")]);
  const result = await executeQuotationContract(fixture.transport,
    { ...quote, items: [{ ...item, description: "" }] }, "201", { operation: "create" });
  assert.deepEqual(fixture.calls.map((call) => `${call.method} ${call.path.split("?")[0]}`),
    ["GET /Contacts/search", "POST /Contacts", "GET /Products/101", "POST /Quotes", "GET /Quotes/401", "PUT /Deals"]);
  assert.equal(result.quoteNumber, "Q-2026-9"); assert.equal(result.normalizedItems[0]?.description, "Resolved fixture description");
  assert.equal(result.dealTransition, "acknowledged"); assert.equal(result.localCommitPerformed, false); assert.equal(fixture.remaining(), 0);
});
test("mock quote edit with zero discounts updates quote without advancing deal stage", async () => {
  const fixture = mock([{ status: 200, body: { data: [{ id: "301", Last_Name: "Fixture contact" }] } }, success("401"), details]);
  const result = await executeQuotationContract(fixture.transport, { ...quote, items: [{ ...item, itemDiscount: "0" }] },
    "201", { operation: "edit", quoteId: "401" });
  assert.equal(fixture.calls[1]?.method, "PUT"); assert.equal(fixture.calls.length, 3);
  assert.equal(result.dealTransition, "not-requested"); assert.equal(result.localCommitPerformed, false);
});

test("quote contact lookup rejects mismatched or incomplete search before any mutation", async () => {
  for (const response of [
    { status: 200, body: { data: [{ id: "301", Last_Name: "Other customer" }] } },
    { status: 200, body: { data: [{ id: "301", Last_Name: "fixture contact" }] } },
    { status: 200, body: { data: [{ id: "301", Last_Name: "Fixture contact" }], info: { more_records: true } } },
    { status: 200, body: { data: [], info: { more_records: true } } },
    { status: 200, body: { data: [], info: { more_records: "false" } } },
    { status: 206, body: { data: [] } },
  ]) for (const mode of [{ operation: "create" }, { operation: "edit", quoteId: "401" }] as const) {
    const fixture = mock([response]);
    await assert.rejects(() => executeQuotationContract(fixture.transport, quote, "201", mode), expectError(502));
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0]?.method, "GET");
  }
});

test("quote contact lookup accepts a complete exact match or explicitly empty complete search", async () => {
  const existing = mock([{ status: 200, body: { data: [{ id: "301", Last_Name: "Fixture contact" }], info: { more_records: false } } }, success("401"), details]);
  await executeQuotationContract(existing.transport, quote, "201", { operation: "edit", quoteId: "401" });
  assert.equal(existing.calls.length, 3);
  const empty = mock([{ status: 200, body: { data: [], info: { more_records: false } } }, success("301"), success("401"), details]);
  await executeQuotationContract(empty.transport, quote, "201", { operation: "edit", quoteId: "401" });
  assert.equal(empty.calls.length, 4);
  assert.equal(empty.calls[1]?.path, "/Contacts");
});

test("quote contact search error envelopes cannot trigger contact or quotation writes", async () => {
  for (const extra of [{ error: "SyntheticPrivateError" }, { code: "INVALID_DATA" }, { status: "error" }, { error: null }]) {
    for (const data of [[], [{ id: "301", Last_Name: "Fixture contact" }]]) {
      const fixture = mock([{ status: 200, body: { data, ...extra } }]);
      await assert.rejects(() => executeQuotationContract(fixture.transport, quote, "201", { operation: "create" }), expectError(502));
      assert.equal(fixture.calls.length, 1);
      assert.equal(fixture.calls[0]?.method, "GET");
    }
  }
});
test("fixed discounts and invalid input cause zero mock transport requests", async () => {
  const fixture = mock([]);
  await assert.rejects(() => executeQuotationContract(fixture.transport, { ...quote, discountType: "fixed" }, "201", { operation: "edit", quoteId: "401" }), expectError(400));
  await assert.rejects(() => executeQuotationContract(fixture.transport, quote, "../other", { operation: "create" }), expectError(400));
  assert.equal(fixture.calls.length, 0);
});
test("quote post-create transition failure explicitly requires reconciliation; no false local success", async () => {
  const fixture = mock([{ status: 200, body: { data: [{ id: "301", Last_Name: "Fixture contact" }] } }, success("401"), details,
    { status: 500, body: { message: "provider-only details" } }]);
  const result = await executeQuotationContract(fixture.transport, quote, "201", { operation: "create" });
  assert.equal(result.dealTransition, "requires-reconciliation"); assert.equal(result.localCommitPerformed, false);
  assert.equal(fixture.calls.length, 4);
});
test("malformed quote readback and ambiguous same-name contact fail closed without fabricated IDs/numbers/timestamps", async () => {
  const fixture = mock([{ status: 200, body: { data: [{ id: "301", Last_Name: "Fixture contact" }] } }, success("401"),
    { status: 200, body: { data: [{ id: "401", Quote_No: "Q-2026-9" }] } }]);
  await assert.rejects(() => executeQuotationContract(fixture.transport, quote, "201", { operation: "create" }), expectError(502));
  assert.equal(fixture.calls.length, 3);
  const duplicates = mock([{ status: 200, body: { data: [{ id: "301", Last_Name: "Fixture contact" }, { id: "302", Last_Name: "Fixture contact" }] } }]);
  await assert.rejects(() => executeQuotationContract(duplicates.transport, quote, "201", { operation: "create" }), expectError(502));
  assert.equal(duplicates.calls.length, 1);
});
