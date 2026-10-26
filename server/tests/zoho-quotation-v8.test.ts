import assert from "node:assert/strict";
import test from "node:test";
import { buildQuotationRequest } from "../src/crm/commercial/quotations.js";
import { createZohoClient } from "../src/integrations/zoho/client.js";
import { createZohoTransports } from "../src/integrations/zoho/transports.js";
import { ZOHO_V8_QUOTATION_PROFILE as profile, ZohoV8QuotationError, assertStoredZohoV8Quotation, assertZohoV8QuotationRowSelection, buildZohoV8QuotationCreate,
  buildZohoV8QuotationEdit, buildZohoV8QuotationReadRequest, parseZohoV8QuotationReadback,
  verifyZohoV8QuotationReadback, type ZohoV8QuotationPlan, type ZohoV8QuotationProfile,
  type ZohoV8QuotationFailure, type ZohoV8QuotationSnapshot } from "../src/integrations/zoho/quotation-v8.js";

// Synthetic fixtures only: no credentials, filesystem, DB, sockets or CRM calls.
const item = { productId: "101", productName: "Synthetic item", description: "Synthetic description", uom: "NOS" as const,
  quantity: "2", unitPrice: "100", itemDiscount: "10" };
const quote = { subject: "Synthetic quotation", kindAttention: "Synthetic contact", discount: "5", discountType: "percentage" as const,
  adjustment: "-1", validUntil: "2026-10-31", items: [item] };
const links = { dealId: "201", contactId: "301" };
const modifiedTime = "2026-10-15T12:00:00+04:00";
const create = (value: unknown = quote) => buildZohoV8QuotationCreate(value, links, profile);
function error(code: ZohoV8QuotationFailure) { return (value: unknown) => value instanceof ZohoV8QuotationError && value.code === code; }
function response(plan: ZohoV8QuotationPlan, quoteId = "401") {
  const { header, financials, lines } = plan.expected;
  return { data: [{ id: quoteId, Quote_No: "Q-SYNTHETIC-1", Modified_Time: modifiedTime,
    Deal_Name: { id: plan.expected.dealId }, Contact_Name: { id: plan.expected.contactId }, Subject: header.subject,
    Valid_Till: header.validUntil, Project: header.Project, Terms_of_Payment: header.Terms_of_Payment,
    Specification: header.Specification, General_Exclusion: header.General_Exclusion, Brand: header.Brand,
    Warranty: header.Warranty, Delivery: header.Delivery, Discount: financials.discount, Tax: financials.tax,
    Adjustment: financials.adjustment, Sub_Total: financials.subtotal, Grand_Total: financials.grandTotal,
    Quoted_Items: lines.map((line, index) => ({ id: line.rowId ?? String(501 + index), Product_Name: { id: line.productId },
      Quantity: line.quantity, List_Price: line.unitPrice, ItemDiscount: line.itemDiscount, U_O_M: line.uom,
      Description: line.description, Net_Total: line.netTotal, Parent_Id: { id: quoteId } })),
    $has_more: { Quoted_Items: false } }] };
}
const read = (body: unknown) => parseZohoV8QuotationReadback(body, "401", profile);

test("stored native quote validation protects local financial and row integrity without granting remote snapshot authority", () => {
  const plan = create(), snapshot = read(response(plan));
  const identity = { quoteId: snapshot.quoteId, quoteNumber: snapshot.quoteNumber, modifiedTime: snapshot.modifiedTime,
    dealId: snapshot.dealId, rowIds: snapshot.lines.map(line => line.rowId) };
  const saved = JSON.parse(JSON.stringify(snapshot)) as ZohoV8QuotationSnapshot;
  const local = { ...plan.normalizedInput, notes: "Local PDF notes are retained" };
  assert.doesNotThrow(() => assertStoredZohoV8Quotation(saved, local, identity, profile));
  assert.throws(() => buildZohoV8QuotationEdit(quote, links, saved, identity.rowIds, profile), error("SNAPSHOT_INVALID"));
  for (const corrupt of [
    { ...saved, financials: { ...saved.financials, tax: "0" } },
    { ...saved, lines: saved.lines.map(line => ({ ...line, rowId: "999" })) },
    { ...saved, lines: saved.lines.map(line => ({ ...line, quantity: "99" })) },
    { ...saved, header: { ...saved.header, subject: "Changed" } },
    { ...saved, dealId: "999" }, { ...saved, quoteId: "999" },
    { ...saved, modifiedTime: "2026-10-15T13:00:00+04:00" }, { ...saved, unknown: true },
  ]) assert.throws(() => assertStoredZohoV8Quotation(corrupt, local, identity, profile), error("SNAPSHOT_INVALID"));
});

test("local native row selection rejects foreign, duplicate, reordered and product-swapped identities before remote work", () => {
  const prior = [{ rowId: "501", productId: "101" }, { rowId: "502", productId: "101" }];
  assert.deepEqual(assertZohoV8QuotationRowSelection(prior, [{ productId: "101" }, { productId: "102" }], ["502", null]), ["501"]);
  for (const rows of [["999"], ["501", "501"], ["502", "501"], [null, "501"]]) {
    assert.throws(() => assertZohoV8QuotationRowSelection(prior, rows.map(() => ({ productId: "101" })), rows), error("EDIT_UNSAFE"));
  }
  assert.throws(() => assertZohoV8QuotationRowSelection(prior, [{ productId: "102" }], ["501"]), error("EDIT_UNSAFE"));
});

test("native field capacities and explicitly resolved blank descriptions are checked without truncation", () => {
  for (const key of ["project", "termsOfPayment", "brand", "warranty", "delivery"]) {
    assert.doesNotThrow(() => create({ ...quote, [key]: "x".repeat(255) }));
    assert.throws(() => create({ ...quote, [key]: "x".repeat(256) }), error("INPUT_INVALID"));
  }
  assert.throws(() => create({ ...quote, specification: "x".repeat(2001) }), error("INPUT_INVALID"));
  const empty = { ...quote, items: [{ ...item, description: "" }] };
  assert.throws(() => create(empty), error("UNRESOLVED_DESCRIPTION"));
  const resolved = buildZohoV8QuotationCreate(empty, links, profile, true);
  assert.equal(resolved.expected.lines[0]?.description, "");
  assert.equal(verifyZohoV8QuotationReadback(resolved, read(response(resolved))).matched, true);
});

test("explicit v8 profile converts header percentage into exact currency, using custom line percent only", () => {
  const plan = create(), row = plan.request.body.data[0];
  assert.deepEqual({ method: plan.request.method, apiVersion: plan.request.apiVersion, path: plan.request.path,
    exactDecimalSerialization: plan.request.exactDecimalSerialization },
  { method: "POST", apiVersion: "v8", path: "/Quotes", exactDecimalSerialization: "quote-v8" });
  assert.deepEqual(row.Deal_Name, { id: "201" }); assert.deepEqual(row.Contact_Name, { id: "301" });
  assert.equal(row.Discount, "9"); assert.deepEqual(row.$line_tax, [{ name: "Vat", percentage: 5 }]); assert.equal(row.Adjustment, "-1");
  assert.deepEqual(row.Quoted_Items, [{ Product_Name: { id: "101" }, Quantity: "2", List_Price: "100", ItemDiscount: "10",
    U_O_M: "NOS", Description: "Synthetic description" }]);
  for (const field of ["Amount", "Sub_Total", "Grand_Total", "Net_Total", "Tax"]) assert.equal(field in row, false);
  assert.deepEqual(plan.expected.financials, { subtotal: "180", discount: "9", tax: "8.55", adjustment: "-1", grandTotal: "178.55" });
  assert.equal(plan.normalizedInput.discount, "5"); assert.equal(plan.normalizedInput.discountType, "percentage");
  assert.equal(plan.financialProfileVerified, false); assert.equal(plan.productionAcceptance, false); assert.equal(plan.localCommitPerformed, false);
});

test("new codec never selects or changes the legacy contract", () => {
  const before = buildQuotationRequest(quote, { ...links, contactName: quote.kindAttention }, { operation: "create" });
  create();
  assert.deepEqual(buildQuotationRequest(quote, { ...links, contactName: quote.kindAttention }, { operation: "create" }), before);
  assert.equal(before.apiVersion, "v2.1"); assert.equal(before.body.data[0]!.Amount, "180.00");
  assert.equal("Tax" in before.body.data[0]!, false);
});

test("unrounded header tax and high-precision input are never coerced through binary float", () => {
  const plan = create({ ...quote, discount: "0", adjustment: "0", items: [{ ...item, quantity: "0.5", unitPrice: "0.01", itemDiscount: "0" }] });
  assert.deepEqual(plan.request.body.data[0].$line_tax, [{ name: "Vat", percentage: 5 }]);
  assert.deepEqual(plan.expected.financials, { subtotal: "0.005", discount: "0", tax: "0.00025", adjustment: "0", grandTotal: "0.00525" });
  const large = create({ ...quote, discount: "100", adjustment: "0", items: [{ ...item, quantity: "0.1", unitPrice: "9007199254740993", itemDiscount: "0" }] });
  assert.equal(large.request.body.data[0].Discount, "900719925474099.3");
  assert.equal((large.request.body.data[0].Quoted_Items[0] as { List_Price: string }).List_Price, "9007199254740993");
});

test("numeric capacities refuse unrepresentable values instead of rounding or truncating", () => {
  for (const patch of [
    { items: [{ ...item, quantity: "0.0000000001" }] },
    { items: [{ ...item, unitPrice: "12345678.123456789" }] },
    { items: [{ ...item, unitPrice: "10000000000000000" }] },
    { items: [{ ...item, itemDiscount: "1.001" }] },
    { adjustment: "-0.0000000001" },
    { discount: "33.333333333333333333" },
    // Both operands fit metadata, but derived VAT has ten decimal places.
    { discount: "0", adjustment: "0", items: [{ ...item, quantity: "1", unitPrice: "0.00000001", itemDiscount: "0" }] },
  ]) assert.throws(() => create({ ...quote, ...patch }), error("PRECISION_UNREPRESENTABLE"));
  const exactTrailing = create({ ...quote, adjustment: "-0.000000000000", items: [{ ...item, itemDiscount: "10.0000000000" }] });
  assert.equal(exactTrailing.request.body.data[0].Adjustment, "0");
  assert.equal((exactTrailing.request.body.data[0].Quoted_Items[0] as { ItemDiscount: string }).ItemDiscount, "10");
});

test("description resolution and notes mapping cannot silently lose user content", () => {
  assert.throws(() => create({ ...quote, notes: "Keep these notes" }), error("UNSUPPORTED_NOTES"));
  assert.throws(() => create({ ...quote, items: [{ ...item, description: "" }] }), error("UNRESOLVED_DESCRIPTION"));
  assert.throws(() => create({ ...quote, items: [{ ...item, description: "x".repeat(2001) }] }), error("INPUT_INVALID"));
  const plan = create({ ...quote, project: "Project\nA", termsOfPayment: "Net 30", specification: "Spec", generalExclusion: "Exclusions",
    brand: "Brand", warranty: "Warranty", delivery: "Delivery", notes: "", items: [{ ...item, description: "x".repeat(2000) }] });
  assert.equal(plan.request.body.data[0].Project, "Project\nA"); assert.equal(plan.request.body.data[0].Warranty, "Warranty");
  assert.equal(plan.normalizedInput.items[0]!.productName, item.productName);
  assert.equal(plan.normalizedInput.kindAttention, quote.kindAttention);
});

test("candidate writes respect the observed 120-character subject capacity", () => {
  assert.equal(create({ ...quote, subject: "S".repeat(120) }).request.body.data[0].Subject.length, 120);
  assert.throws(() => create({ ...quote, subject: "S".repeat(121) }), error("INPUT_INVALID"));
  // A historical read can be inspected without claiming a new write fits.
  const body = response(create()); body.data[0]!.Subject = "S".repeat(200);
  assert.equal(read(body).header.subject.length, 200);
});

test("unknown profile, IDs, injected fields, malformed decimals and header amounts are refused", () => {
  for (const candidate of [undefined, "", "default", "../Quotes", "voltronix-custom-quoted-items-v8 ", { profile }]) {
    assert.throws(() => buildZohoV8QuotationCreate(quote, links, candidate as ZohoV8QuotationProfile), error("PROFILE_INVALID"));
  }
  for (const bad of ["0", "1/Notes", "https://elsewhere.invalid", "9".repeat(31)]) {
    assert.throws(() => buildZohoV8QuotationCreate(quote, { ...links, dealId: bad }, profile), error("INPUT_INVALID"));
    assert.throws(() => create({ ...quote, items: [{ ...item, productId: bad }] }), error("INPUT_INVALID"));
  }
  for (const patch of [{ Tax: "1" }, { discountType: "amount" }, { discount: "101" }, { discountType: undefined },
    { items: [{ ...item, unitPrice: "1e2" }] }, { items: [{ ...item, quantity: "0" }] }]) {
    assert.throws(() => create({ ...quote, ...patch }), error("INPUT_INVALID"));
  }
});

test("readback matches exact relationships, lines, terms and totals without approving tenant semantics", () => {
  const plan = create(), body = response(plan);
  body.data[0]!.Tax = "8.550000000"; body.data[0]!.Quoted_Items[0]!.Quantity = "2.000";
  const snapshot = read(body), result = verifyZohoV8QuotationReadback(plan, snapshot);
  assert.deepEqual(result, { matched: true, issues: [], financialProfileVerified: false, productionAcceptance: false, localCommitPerformed: false });
  assert.equal(snapshot.quoteId, "401"); assert.equal(snapshot.lines[0]!.rowId, "501");
  assert.ok(Object.isFrozen(snapshot)); assert.ok(Object.isFrozen(snapshot.lines[0])); assert.ok(Object.isFrozen(plan.request.body.data[0]));
  assert.throws(() => { (snapshot.lines[0] as { rowId: string }).rowId = "999"; }, TypeError);
});

test("readback requires a complete single record, lossless numeric strings and unique parent-bound row IDs", () => {
  const plan = create({ ...quote, items: [item, item] });
  const invalid: unknown[] = [{ data: [] }, { data: response(plan).data, code: "SUCCESS" },
    { ...response(plan), info: { more_records: true } }, { ...response(plan), info: null }];
  const change = (apply: (body: ReturnType<typeof response>) => void) => { const body = response(plan); apply(body); invalid.push(body); };
  change(body => { body.data.push(body.data[0]!); });
  change(body => { body.data[0]!.id = "402"; });
  change(body => { body.data[0]!.$has_more.Quoted_Items = true; });
  change(body => { (body.data[0] as unknown as Record<string, unknown>).$has_more = undefined; });
  change(body => { body.data[0]!.Quoted_Items[1]!.id = "501"; });
  change(body => { body.data[0]!.Quoted_Items[0]!.Parent_Id.id = "402"; });
  change(body => { (body.data[0] as unknown as Record<string, unknown>).Tax = 8.55; });
  change(body => { body.data[0]!.Tax = "8.55e0"; });
  change(body => { body.data[0]!.Quoted_Items[0]!.Quantity = "-1"; });
  change(body => { body.data[0]!.Quoted_Items[0]!.ItemDiscount = "101"; });
  change(body => { (body.data[0]!.Quoted_Items[0] as unknown as Record<string, unknown>).error = "secret failure body"; });
  change(body => { (body.data[0]!.Quoted_Items[0]!.Parent_Id as Record<string, unknown>).module = { api_name: "Deals" }; });
  for (const number of ["", "   ", "\t", "Q-1\n", "Q-\u007f1"]) change(body => { body.data[0]!.Quote_No = number; });
  for (const date of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-01-00", "bad"]) {
    change(body => { body.data[0]!.Valid_Till = date; });
  }
  for (const body of invalid) assert.throws(() => read(body), error("READBACK_INVALID"));
  const leapDay = response(plan); leapDay.data[0]!.Valid_Till = "2028-02-29";
  assert.equal(read(leapDay).header.validUntil, "2028-02-29");
});

test("readback mismatches yield only redacted categories, never acceptance or input values", () => {
  const plan = create();
  const cases: [string, (row: ReturnType<typeof response>["data"][number]) => void][] = [
    ["PARENT", row => { row.Deal_Name.id = "999"; }], ["PARENT", row => { row.Contact_Name.id = "999"; }],
    ["HEADER", row => { row.Subject = "Different confidential subject"; }], ["HEADER", row => { row.Brand = "Different brand"; }],
    ["LINE_VALUES", row => { row.Quoted_Items[0]!.Product_Name.id = "999"; }],
    ["LINE_VALUES", row => { row.Quoted_Items[0]!.Quantity = "3"; }],
    ["LINE_VALUES", row => { row.Quoted_Items[0]!.ItemDiscount = "9"; }],
    ["LINE_VALUES", row => { row.Quoted_Items[0]!.Description = "Different private description"; }],
    ["FINANCIAL_TOTALS", row => { row.Quoted_Items[0]!.Net_Total = "180.01"; }],
    ["FINANCIAL_TOTALS", row => { row.Discount = "5"; }], ["FINANCIAL_TOTALS", row => { row.Tax = "9"; }],
    ["FINANCIAL_TOTALS", row => { row.Tax = "0"; }],
    ["FINANCIAL_TOTALS", row => { row.Sub_Total = "200"; }], ["FINANCIAL_TOTALS", row => { row.Grand_Total = "200"; }],
  ];
  for (const [category, patch] of cases) {
    const body = response(plan); patch(body.data[0]!);
    const result = verifyZohoV8QuotationReadback(plan, read(body));
    assert.equal(result.matched, false); assert.ok(result.issues.includes(category as never));
    assert.equal(result.financialProfileVerified, false); assert.doesNotMatch(JSON.stringify(result), /private|confidential|999/);
  }
});

test("safe edit retains explicit row IDs, deletes omitted rows, appends new rows and pins modification time", () => {
  const original = create({ ...quote, items: [item, { ...item, productId: "102" }] }), previous = read(response(original));
  const edit = buildZohoV8QuotationEdit({ ...quote, items: [{ ...item, quantity: "3" }, { ...item, productId: "103" }] },
    links, previous, ["501", null], profile);
  assert.equal(edit.request.method, "PUT"); assert.equal(edit.request.path, "/Quotes/401");
  assert.equal(edit.request.ifUnmodifiedSince, modifiedTime); assert.equal(edit.request.exactDecimalSerialization, "quote-v8");
  assert.deepEqual(edit.request.body.data[0].Quoted_Items, [
    { id: "501", Product_Name: { id: "101" }, Quantity: "3", List_Price: "100", ItemDiscount: "10", U_O_M: "NOS", Description: item.description },
    { Product_Name: { id: "103" }, Quantity: "2", List_Price: "100", ItemDiscount: "10", U_O_M: "NOS", Description: item.description },
    { id: "502", _delete: null },
  ]);
  const body = response(edit); body.data[0]!.Quoted_Items[1]!.id = "503";
  assert.equal(verifyZohoV8QuotationReadback(edit, read(body)).matched, true);
  body.data[0]!.Quoted_Items[1]!.id = "502";
  assert.ok(verifyZohoV8QuotationReadback(edit, read(body)).issues.includes("LINE_ID"));
});

test("duplicate product lines remain distinct and are never matched only by product ID", () => {
  const original = create({ ...quote, items: [item, { ...item, quantity: "3" }] }), previous = read(response(original));
  const edit = buildZohoV8QuotationEdit({ ...quote, items: [{ ...item, quantity: "4" }] }, links, previous, ["502"], profile);
  assert.equal(edit.request.body.data[0].Quoted_Items[0]!.id, "502");
  assert.deepEqual(edit.request.body.data[0].Quoted_Items[1], { id: "501", _delete: null });
  assert.equal(verifyZohoV8QuotationReadback(edit, read(response(edit))).matched, true);
});

test("edit refuses fabricated snapshots, ambiguous identity, reordering and implicit parent changes", () => {
  const original = create({ ...quote, items: [item, item] }), previous = read(response(original));
  assert.throws(() => buildZohoV8QuotationEdit(quote, links, structuredClone(previous), ["501"], profile), error("SNAPSHOT_INVALID"));
  assert.throws(() => verifyZohoV8QuotationReadback(structuredClone(original), previous), error("INPUT_INVALID"));
  assert.throws(() => verifyZohoV8QuotationReadback(original, {} as ZohoV8QuotationSnapshot), error("SNAPSHOT_INVALID"));
  for (const rowIds of [["999"], ["501", "501"], ["502", "501"], [null, "501"], [], ["1/Notes"]]) {
    const items = rowIds.length === 2 ? [item, item] : [item];
    assert.throws(() => buildZohoV8QuotationEdit({ ...quote, items }, links, previous, rowIds, profile), error("EDIT_UNSAFE"));
  }
  assert.throws(() => buildZohoV8QuotationEdit(quote, { ...links, dealId: "999" }, previous, ["501"], profile), error("EDIT_UNSAFE"));
  assert.throws(() => buildZohoV8QuotationEdit(quote, { ...links, contactId: "999" }, previous, ["501"], profile), error("EDIT_UNSAFE"));
  assert.throws(() => buildZohoV8QuotationEdit({ ...quote, items: [{ ...item, productId: "102" }] }, links, previous, ["501"], profile), error("EDIT_UNSAFE"));
});

test("edit and readback enforce bounded row counts including delete markers", () => {
  const original = create({ ...quote, items: Array.from({ length: 200 }, () => ({ ...item })) }), previous = read(response(original));
  assert.throws(() => create({ ...quote, items: Array.from({ length: 201 }, () => ({ ...item })) }), error("INPUT_INVALID"));
  assert.throws(() => buildZohoV8QuotationEdit(quote, links, previous, [null], profile), error("EDIT_UNSAFE"));
  const body = response(original); body.data[0]!.Quoted_Items.push({ ...body.data[0]!.Quoted_Items[0]!, id: "999" });
  assert.throws(() => read(body), error("READBACK_INVALID"));
  const first = create({ ...quote, items: [item, item] });
  const fewer = response(first); fewer.data[0]!.Quoted_Items.pop();
  assert.ok(verifyZohoV8QuotationReadback(first, read(fewer)).issues.includes("LINE_COUNT"));
});

test("readback verifies retained IDs and record identity, including valid but unrelated snapshots", () => {
  const original = create(), previous = read(response(original));
  const edit = buildZohoV8QuotationEdit(quote, links, previous, ["501"], profile);
  const differentLine = response(edit); differentLine.data[0]!.Quoted_Items[0]!.id = "999";
  assert.ok(verifyZohoV8QuotationReadback(edit, read(differentLine)).issues.includes("LINE_ID"));
  const otherQuote = parseZohoV8QuotationReadback(response(edit, "402"), "402", profile);
  assert.ok(verifyZohoV8QuotationReadback(edit, otherQuote).issues.includes("QUOTE_ID"));
});

test("read request uses one caller-pinned record and a fixed bounded field list", () => {
  const request = buildZohoV8QuotationReadRequest("401", profile);
  assert.equal(request.method, "GET"); assert.equal(request.apiVersion, "v8");
  const url = new URL(request.path, "https://example.invalid");
  assert.equal(url.pathname, "/Quotes/401");
  const fields = url.searchParams.get("fields")!.split(",");
  assert.ok(fields.includes("Quoted_Items")); assert.ok(fields.includes("Grand_Total")); assert.ok(fields.length <= 50);
  assert.deepEqual([...url.searchParams.keys()], ["fields"]);
  assert.throws(() => buildZohoV8QuotationReadRequest("401?fields=Secret", profile), error("INPUT_INVALID"));
});

test("OFFLINE codec through commercial bridge emits exact numbers, conditional edits and lossless readback", async t => {
  const value = { ...quote, discount: "100", adjustment: "0", items: [{ ...item, quantity: "0.1", unitPrice: "9007199254740993", itemDiscount: "0" }] };
  const plan = create(value), calls: { path: string; method: string; body: string; headers: Headers }[] = [];
  let activePlan = plan;
  const rawJSON = (JSON as unknown as { rawJSON: (value: string) => unknown }).rawJSON;
  const fetcher: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    if (target.origin === "https://accounts.zoho.com" && target.pathname === "/oauth/v2/token") {
      return Response.json({ access_token: "synthetic-access", expires_in: 3600, api_domain: "https://www.zohoapis.com", token_type: "Bearer" });
    }
    assert.equal(target.origin, "https://sandbox.zohoapis.com");
    if (target.pathname === "/crm/v8/org") return Response.json({ org: [{ id: "12345", type: "sandbox" }] });
    assert.ok(["/crm/v8/Quotes", "/crm/v8/Quotes/401"].includes(target.pathname));
    calls.push({ path: target.pathname, method: init?.method ?? "GET", body: String(init?.body ?? ""), headers: new Headers(init?.headers) });
    if (init?.method !== "GET") return Response.json({ data: [{ code: "SUCCESS", details: { id: "401" } }] });
    // Mimic JSON numeric wire tokens, including an integer above MAX_SAFE_INTEGER.
    const body = response(activePlan), row = body.data[0]!;
    const serialized = JSON.stringify({ data: [{ ...row, Discount: rawJSON(row.Discount), Tax: rawJSON(row.Tax),
      Adjustment: rawJSON(row.Adjustment), Sub_Total: rawJSON(row.Sub_Total), Grand_Total: rawJSON(row.Grand_Total),
      Quoted_Items: row.Quoted_Items.map(line => ({ ...line, Quantity: rawJSON(line.Quantity), List_Price: rawJSON(line.List_Price),
        ItemDiscount: rawJSON(line.ItemDiscount), Net_Total: rawJSON(line.Net_Total) })) }] });
    return new Response(serialized, { headers: { "Content-Type": "application/json" } });
  };
  const client = createZohoClient({ clientId: "synthetic-client", clientSecret: "synthetic-secret", refreshToken: "synthetic-refresh",
    environment: "sandbox", organizationId: "12345", allowWrites: true }, { fetch: fetcher, networkEnabled: true });
  t.after(() => client.close());
  const transport = createZohoTransports(client).commercial;
  await transport.request(plan.request);
  assert.ok(calls[0]!.body.includes('"List_Price":9007199254740993'));
  assert.ok(calls[0]!.body.includes('"Discount":900719925474099.3'));
  assert.ok(calls[0]!.body.includes('"Quantity":0.1'));
  assert.ok(calls[0]!.body.includes('"Product_Name":{"id":"101"}'));
  const readRequest = buildZohoV8QuotationReadRequest("401", profile);
  const previous = read((await transport.request(readRequest)).body);
  assert.equal(previous.lines[0]!.unitPrice, "9007199254740993");
  assert.equal(verifyZohoV8QuotationReadback(plan, previous).matched, true);
  activePlan = buildZohoV8QuotationEdit({ ...value, adjustment: "-0.01" }, links, previous, ["501"], profile);
  await transport.request(activePlan.request);
  assert.equal(calls[2]!.headers.get("If-Unmodified-Since"), modifiedTime);
  assert.ok(calls[2]!.body.includes('"Adjustment":-0.01'));
  assert.ok(calls[2]!.body.includes('"id":"501"'));
  const updated = read((await transport.request(readRequest)).body);
  assert.deepEqual(verifyZohoV8QuotationReadback(activePlan, updated), {
    matched: true, issues: [], financialProfileVerified: false, productionAcceptance: false, localCommitPerformed: false,
  });
  assert.deepEqual(calls.map(call => call.method), ["POST", "GET", "PUT", "GET"]);
});
