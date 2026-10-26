import assert from "node:assert/strict";
import test from "node:test";
import { parseZohoInboundSnapshot, readZohoInboundSnapshot, safeZohoInboundDiagnostic, ZohoInboundReadError, type ZohoInboundReadInput,
  type ZohoInboundReadFailure } from "../src/integrations/zoho/inbound-snapshot.js";
import type { ZohoClientRequest } from "../src/integrations/zoho/client.js";
import type { VerifiedZohoRequestPort } from "../src/integrations/zoho/transports.js";

const created = "2025-01-02T10:00:00+04:00", modified = "2026-10-15T10:00:00+04:00";
const input: ZohoInboundReadInput = { organizationId: "12345", capturedAt: modified,
  limits: { pageSize: 2, maxPages: 100, maxProducts: 20_000, maxDeals: 20_000, maxNotes: 20_000, maxRequests: 300 } };
const product = (id = "101") => ({ id, Product_Name: " Synthetic product ", Description: " Source\ntext ",
  Unit_Price: "9007199254740993.000000000000000001", Created_Time: created, Modified_Time: modified });
const deal = (id = "201") => ({ id, Deal_Name: "Synthetic deal", Stage: "Needs Analysis", VZ_App_Status: "Site Visit", Amount: "1.2500",
  Created_Time: created, Modified_Time: modified, Account_Name: { id: "301", name: "Account" }, Contact_Name: { id: "302", name: "Contact" },
  Owner: { id: "401", name: "Owner" }, VZ_app_user: { id: "402", name: "Assignee" }, Created_By: { id: "403", name: "Creator" },
  DealNumber: "DEAL-1", EnquiryNumber: "ENQ-1", QualDealNumber: "QUAL-1", SiteDealNumber: "SITE-1", QuoteDealNumber: null,
  JobDealNumber: null, LostDealNumber: null, Qualified_Time: created, Site_Deal_Date: modified, Quote_Date: null, Job_Date: null, Lost_Time: null,
  Email: "contact@example.invalid", Phone: "0000", Mobile: "0001", Address: "Source address", Description: "Source description",
  Assign_Department1: "VOLTRONIX CONTRACTING LLC", P_BOX: "12", TRN: "123" });
const note = (id = "501", parent = "201", module = "Deals") => ({ id, Note_Title: "Source note", Note_Content: " <b>Exact note</b> ",
  Parent_Id: { id: parent, module: { api_name: module } }, Created_Time: created, Modified_Time: modified, Created_By: { id: "403", name: "Creator" } });
function page(data: unknown[], index = 1, more = false, size = 2, token: string | null = null) {
  return { status: 200, body: { data, info: { page: String(index) as string | null, count: String(data.length), per_page: String(size),
    more_records: more, sort_by: "id", sort_order: "asc", next_page_token: token } } };
}
function fake(replies: ({ status: number; body?: unknown } | Error)[]) {
  const calls: ZohoClientRequest[] = [];
  const port: VerifiedZohoRequestPort = { async request(request) {
    calls.push(structuredClone(request)); const reply = replies.shift(); assert.ok(reply, "Unexpected request or retry");
    if (reply instanceof Error) throw reply;
    return { status: reply.status, body: reply.body };
  } };
  return { port, calls };
}
function error(code: ZohoInboundReadFailure) { return (value: unknown) => {
  assert.ok(value instanceof ZohoInboundReadError); assert.equal(value.code, code);
  assert.equal(value.cause, undefined); assert.equal("products" in value, false); assert.equal("deals" in value, false);
  assert.doesNotMatch(`${value.stack} ${JSON.stringify(value)}`, /private-provider|opaque-token|private-record/); return true;
}; }

test("complete fixed projection preserves true source timestamps, decimals and distinct assignment/owner/creator", async () => {
  const fixture = fake([page([product()]), page([deal()]), page([note()])]);
  const result = await readZohoInboundSnapshot(fixture.port, input);
  assert.equal(result.complete, true); assert.equal(result.snapshotConsistent, false); assert.equal(result.deletionsVerified, false);
  assert.equal(result.richTextCompletenessVerified, false); assert.equal(result.requestsPerformed, 3);
  assert.equal(result.products[0]!.createdAt, created); assert.equal(result.products[0]!.unitPrice, product().Unit_Price);
  assert.equal(result.products[0]!.name, " Synthetic product "); assert.equal(result.products[0]!.description, " Source\ntext ");
  const row = result.deals[0]!;
  assert.equal(row.owner?.externalId, "401"); assert.equal(row.assignedTo?.externalId, "402"); assert.equal(row.createdBy?.externalId, "403");
  assert.equal(row.stage, "Needs Analysis"); assert.equal(row.applicationStatus, "Site Visit");
  assert.equal(row.qualificationDate, created); assert.equal(row.siteDate, modified); assert.equal(row.quotationDate, null);
  assert.equal(row.department, deal().Assign_Department1); assert.equal(row.poBox, "12"); assert.equal(row.amount, "1.2500");
  assert.deepEqual(row.missingOptionalFields, []); assert.equal(result.notes[0]!.createdAt, created);
  assert.equal(result.notes[0]!.content, note().Note_Content); assert.deepEqual(result.excludedNoteCounts, { otherModules: 0, unavailableDeals: 0 });
  assert.ok(result.excludedScopes.includes("Quotes")); assert.ok(result.excludedScopes.includes("Attachments"));
  for (const [index, call] of fixture.calls.entries()) {
    assert.equal(call.method, "GET"); assert.equal(call.apiVersion, "v8"); assert.equal(call.body, undefined);
    const url = new URL(call.path, "https://fixed.invalid"); assert.equal(url.pathname, ["/Products", "/Deals", "/Notes"][index]);
    assert.ok(url.searchParams.get("fields")!.split(",").length <= 50);
    assert.ok(url.searchParams.get("fields")!.includes("Created_Time"));
    assert.equal(url.searchParams.get("page"), "1");
  }
});

test("missing optional fields are explicit and never substituted from another identity or from capture time", async () => {
  const source = { id: "201", Deal_Name: "Minimum source", Stage: "Qualification", Created_Time: created, Modified_Time: modified,
    VZ_app_user: null, VZ_App_Status: null, Owner: { id: "401", name: "Owner" } };
  const fixture = fake([page([{ id: "101", Product_Name: "Product", Created_Time: created, Modified_Time: modified }]), page([source]), { status: 204 }]);
  const result = await readZohoInboundSnapshot(fixture.port, input), row = result.deals[0]!;
  assert.equal(row.assignedTo, null); assert.equal(row.createdBy, null); assert.equal(row.applicationStatus, null);
  assert.ok(row.missingOptionalFields.includes("Created_By")); assert.equal(row.missingOptionalFields.includes("VZ_app_user"), false);
  assert.equal(row.missingOptionalFields.includes("VZ_App_Status"), false); assert.ok(row.missingOptionalFields.includes("Job_Date"));
  assert.deepEqual(result.products[0]!.missingOptionalFields, ["Description", "Unit_Price"]);
  assert.equal(row.createdAt, created); assert.notEqual(row.createdAt, input.capturedAt);
});

test("source product/deal names preserve layout whitespace but stages and other control characters remain refused", async () => {
  const name = "  Synthetic\r\nproduct\tline  ";
  const result = await readZohoInboundSnapshot(fake([page([{ ...product(), Product_Name: name }]),
    page([{ ...deal(), Deal_Name: name }]), page([])]).port, input);
  assert.equal(result.products[0]!.name, name); assert.equal(result.deals[0]!.name, name);
  assert.equal(parseZohoInboundSnapshot(JSON.parse(JSON.stringify(result))).products[0]!.name, name);
  for (const [name, category] of [["  \r\n\t", "blank_text"], ["Product\u0001", "unsupported_control"], ["Product\u007f", "unsupported_control"],
    ["Product\0", "unsupported_control"]] as const) {
    await assert.rejects(readZohoInboundSnapshot(fake([page([{ ...product(), Product_Name: name }])]).port, input), value => {
      assert.ok(value instanceof ZohoInboundReadError); assert.equal(value.diagnostic?.issue, category); return true;
    });
  }
  await assert.rejects(readZohoInboundSnapshot(fake([page([]), page([{ ...deal(), Stage: "Needs\nAnalysis" }])]).port, input), error("RESPONSE_INVALID"));
});

test("inbound product catalog names preserve up to 2000 characters without changing outbound or deal limits", async () => {
  const name = `Catalog\n${"x".repeat(1992)}`;
  assert.equal(name.length, 2000);
  const result = await readZohoInboundSnapshot(fake([page([{ ...product(), Product_Name: name }]), page([]), page([])]).port, input);
  assert.equal(result.products[0]!.name, name); assert.equal(parseZohoInboundSnapshot(JSON.parse(JSON.stringify(result))).products[0]!.name, name);
  await assert.rejects(readZohoInboundSnapshot(fake([page([{ ...product(), Product_Name: `${name}x` }])]).port, input), value => {
    assert.ok(value instanceof ZohoInboundReadError); assert.equal(value.diagnostic?.issue, "too_big"); return true;
  });
  await assert.rejects(readZohoInboundSnapshot(fake([page([]), page([{ ...deal(), Deal_Name: "x".repeat(201) }])]).port, input), error("RESPONSE_INVALID"));
});

test("inbound product/deal descriptions preserve existing long text without inheriting outbound creation limits", async () => {
  for (const length of [10_001, 100_000]) {
    const description = `Source\r\n${"x".repeat(length - 8)}`;
    assert.equal(description.length, length);
    const result = await readZohoInboundSnapshot(fake([page([{ ...product(), Description: description }]),
      page([{ ...deal(), Description: description }]), page([])]).port, input);
    assert.equal(result.products[0]!.description, description); assert.equal(result.deals[0]!.description, description);
    assert.equal(parseZohoInboundSnapshot(JSON.parse(JSON.stringify(result))).deals[0]!.description, description);
  }
  await assert.rejects(readZohoInboundSnapshot(fake([page([{ ...product(), Description: "x".repeat(100_001) }])]).port, input), value => {
    assert.ok(value instanceof ZohoInboundReadError); assert.deepEqual(value.diagnostic,
      { module: "Products", field: "Description", issue: "too_big" }); return true;
  });
  await assert.rejects(readZohoInboundSnapshot(fake([page([]), page([{ ...deal(), Description: "x".repeat(100_001) }])]).port, input), value => {
    assert.ok(value instanceof ZohoInboundReadError); assert.deepEqual(value.diagnostic,
      { module: "Deals", field: "Description", issue: "too_big" }); return true;
  });
});

test("global Notes collection excludes other modules and unavailable Deals explicitly without retaining their content", async () => {
  const fixture = fake([page([]), page([deal()]), page([note("501"), { ...note("502", "201", "Accounts"), Note_Content: "private-record" }], 1, true),
    page([{ ...note("503", "999"), Note_Content: "private-record" }], 2)]);
  const result = await readZohoInboundSnapshot(fixture.port, input);
  assert.equal(result.notes.length, 1); assert.deepEqual(result.excludedNoteCounts, { otherModules: 1, unavailableDeals: 1 });
  assert.doesNotMatch(JSON.stringify(result), /private-record/);
  assert.equal(fixture.calls.filter(call => call.path.startsWith("/Notes?")).length, 2);
});

test("fixed token pagination reads beyond 2000 records without page/token mixing or arbitrary destinations", async () => {
  const replies = Array.from({ length: 10 }, (_, index) => page(Array.from({ length: 200 }, (_, offset) => product(String(1000 + index * 200 + offset))),
    index + 1, true, 200, index === 9 ? "opaque-token/+=" : `unused-${index}`));
  const eleventh = page([product("3000")], 1, false, 200); // Token responses may restart their displayed page counter.
  const fixture = fake([...replies, eleventh, page([], 1, false, 200), page([], 1, false, 200)]);
  const result = await readZohoInboundSnapshot(fixture.port, { ...input, limits: { ...input.limits, pageSize: 200 } });
  assert.equal(result.products.length, 2001); assert.equal(result.requestsPerformed, 13);
  const tokenRequest = new URL(fixture.calls[10]!.path, "https://fixed.invalid");
  assert.equal(tokenRequest.pathname, "/Products"); assert.equal(tokenRequest.searchParams.get("page_token"), "opaque-token/+=");
  assert.equal(tokenRequest.searchParams.has("page"), false); assert.equal(tokenRequest.searchParams.get("fields"), new URL(fixture.calls[0]!.path, "https://fixed.invalid").searchParams.get("fields"));
});

test("repeated/missing/invalid token and final token cannot falsely complete a collection", async () => {
  const firstTen = () => Array.from({ length: 10 }, (_, index) => page([product(String(100 + index))], index + 1, true, 2,
    index === 9 ? "opaque-token" : null));
  const repeated = page([product("110")], 11, true, 2, "opaque-token"); repeated.body.info.page = null;
  await assert.rejects(readZohoInboundSnapshot(fake([...firstTen(), repeated]).port, input), error("PAGINATION_INVALID"));
  const missing = firstTen(); missing[9]!.body.info.next_page_token = null;
  await assert.rejects(readZohoInboundSnapshot(fake(missing).port, input), error("PAGINATION_INVALID"));
  for (const token of ["", "bad\r\nheader", "x".repeat(4097)]) {
    await assert.rejects(readZohoInboundSnapshot(fake([page([product()], 1, true, 2, token)]).port, input), error("PAGINATION_INVALID"));
  }
  await assert.rejects(readZohoInboundSnapshot(fake([page([product()], 1, false, 2, "opaque-token")]).port, input), error("PAGINATION_INVALID"));
});

test("configuration, organization IDs, extra parameters and getters fail before any network", async () => {
  const fixture = fake([]);
  for (const value of [{ ...input, organizationId: "1/Notes" }, { ...input, capturedAt: "today" }, { ...input, endpoint: "/Accounts" },
    { ...input, limits: { ...input.limits, maxPages: 101 } }, { ...input, limits: { ...input.limits, maxProducts: 20_001 } },
    { ...input, limits: { ...input.limits, pageSize: 201 } }, { ...input, limits: { ...input.limits, maxRequests: 2 } },
    { ...input, get organizationId() { throw new Error("private-provider"); } }]) {
    await assert.rejects(readZohoInboundSnapshot(fixture.port, value as ZohoInboundReadInput), error("INPUT_INVALID"));
  }
  assert.equal(fixture.calls.length, 0);
});

test("required source timestamps, IDs, dates, lookup shapes and exact decimals never use defaults", async () => {
  for (const patch of [{ Created_Time: undefined }, { Modified_Time: undefined }, { Created_Time: "2026-02-30T00:00:00Z" },
    { Unit_Price: 1.5 }, { Unit_Price: "1e31" }, { id: "0" }, { Product_Name: "   " }, { Description: "bad\0text" }]) {
    await assert.rejects(readZohoInboundSnapshot(fake([page([{ ...product(), ...patch }])]).port, input), error("RESPONSE_INVALID"));
  }
  for (const patch of [{ VZ_app_user: { name: "User without id" } }, { Created_By: "401" }, { Owner: { id: 401, name: "Owner" } },
    { Stage: "" }, { Job_Date: "invalid-date" }, { Amount: Number.NaN }]) {
    await assert.rejects(readZohoInboundSnapshot(fake([page([]), page([{ ...deal(), ...patch }])]).port, input), error("RESPONSE_INVALID"));
  }
  const badNote = { ...note(), Parent_Id: { id: "201" } };
  await assert.rejects(readZohoInboundSnapshot(fake([page([]), page([deal()]), page([badNote])]).port, input), error("RESPONSE_INVALID"));
});

test("custom dates retain valid calendar-only values without inventing midnight or accepting impossible dates", async () => {
  const fixture = fake([page([]), page([{ ...deal(), Job_Date: "2028-02-29", Qualified_Time: "2025-01-02" }]), page([])]);
  const result = await readZohoInboundSnapshot(fixture.port, input);
  assert.equal(result.deals[0]!.jobDate, "2028-02-29"); assert.equal(result.deals[0]!.qualificationDate, "2025-01-02");
  for (const value of ["2026-02-29", "2026-04-31", "2026-00-01", "2026-01-00", "2026-01-02T00:00:00"]) {
    await assert.rejects(readZohoInboundSnapshot(fake([page([]), page([{ ...deal(), Job_Date: value }])]).port, input), error("RESPONSE_INVALID"));
  }
});

test("incomplete pagination, mixed errors and duplicate/nonmonotonic IDs abort without partial snapshots", async () => {
  const invalid = [page([product()]), page([product()]), page([product()]), page([product()])];
  invalid[0]!.body.info.page = "2"; invalid[1]!.body.info.count = "0";
  invalid[2]!.body.info.sort_by = "Created_Time"; invalid[3]!.body.info.per_page = "1";
  for (const reply of invalid) await assert.rejects(readZohoInboundSnapshot(fake([reply]).port, input), error("PAGINATION_INVALID"));
  for (const reply of [{ status: 200, body: { ...page([product()]).body, code: "FAILED" } },
    { status: 200, body: { data: [product()] } }, page([{ ...product(), error: "private-provider" }])]) {
    await assert.rejects(readZohoInboundSnapshot(fake([reply]).port, input), error("RESPONSE_INVALID"));
  }
  await assert.rejects(readZohoInboundSnapshot(fake([page([product()], 1, true), { status: 204 }]).port, input), error("PAGINATION_INVALID"));
  await assert.rejects(readZohoInboundSnapshot(fake([page([product(), product()])]).port, input), error("DUPLICATE_RECORD"));
  await assert.rejects(readZohoInboundSnapshot(fake([page([product("102"), product("101")])]).port, input), error("PAGINATION_INVALID"));
  await assert.rejects(readZohoInboundSnapshot(fake([page([]), page([deal()]), page([note(), note()])]).port, input), error("DUPLICATE_RECORD"));
});

test("limits cover all source Notes including filtered-out records and stop before request budget overflow", async () => {
  const cases = [
    { limits: { ...input.limits, maxProducts: 1 }, replies: [page([product("101"), product("102")])] },
    { limits: { ...input.limits, maxPages: 1 }, replies: [page([product()], 1, true)] },
    { limits: { ...input.limits, maxNotes: 1 }, replies: [page([]), page([]), page([note("501", "9", "Accounts"), note("502", "9", "Accounts")])] },
    { limits: { ...input.limits, maxRequests: 3 }, replies: [page([product()], 1, true), page([product("102")], 2), page([])] },
  ];
  for (const { limits, replies } of cases) {
    const fixture = fake(replies);
    await assert.rejects(readZohoInboundSnapshot(fixture.port, { ...input, limits }), error("LIMIT_EXCEEDED"));
    assert.ok(fixture.calls.length <= limits.maxRequests);
  }
});

test("remote failures are typed/redacted, are not retried, and never expose a partial import", async () => {
  for (const [status, code] of [[401, "ACCESS_DENIED"], [403, "ACCESS_DENIED"], [429, "RATE_LIMITED"], [500, "REQUEST_FAILED"]] as const) {
    const fixture = fake([page([product()]), { status, body: { error: "private-provider" } }]);
    await assert.rejects(readZohoInboundSnapshot(fixture.port, input), error(code)); assert.equal(fixture.calls.length, 2);
  }
  const fixture = fake([page([product()]), page([deal()]), new Error("private-provider")]);
  await assert.rejects(readZohoInboundSnapshot(fixture.port, input), error("REQUEST_FAILED")); assert.equal(fixture.calls.length, 3);
  const throwing = page([product()]); Object.defineProperty(throwing.body, "data", { get() { throw new Error("private-provider"); } });
  await assert.rejects(readZohoInboundSnapshot(fake([throwing]).port, input), error("RESPONSE_INVALID"));
});

test("hybrid error envelopes and error-bearing rows cannot masquerade as complete source reads", async () => {
  for (const key of ["code", "error", "errors", "status", "message"]) {
    const reply = page([product()]); (reply.body as Record<string, unknown>)[key] = "private-provider";
    await assert.rejects(readZohoInboundSnapshot(fake([reply]).port, input), error("RESPONSE_INVALID"));
    await assert.rejects(readZohoInboundSnapshot(fake([page([{ ...product(), [key]: "private-provider" }])]).port, input), error("RESPONSE_INVALID"));
  }
});

test("staged JSON parser checks bounds, exact DTO fields, relationships, completeness and missing-field consistency", async () => {
  const snapshot = await readZohoInboundSnapshot(fake([page([product()]), page([deal()]), page([note()])]).port, input);
  assert.deepEqual(parseZohoInboundSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot);
  const mutations: ((value: typeof snapshot) => void)[] = [
    value => { value.organizationId = "1/Notes"; },
    value => { (value as unknown as Record<string, unknown>).complete = false; },
    value => { (value as unknown as Record<string, unknown>).snapshotConsistent = true; },
    value => { (value as unknown as Record<string, unknown>).secretExtra = "private-provider"; },
    value => { value.products.push(value.products[0]!); },
    value => { value.notes[0]!.dealId = "999"; },
    value => { value.products[0]!.missingOptionalFields = ["Unit_Price"]; },
    value => { value.products[0]!.missingOptionalFields = ["Created_Time"]; },
    value => { value.deals[0]!.missingOptionalFields = ["unknown"]; },
    value => { value.notes[0]!.createdAt = "2026-01-01"; },
    value => { value.excludedNoteCounts.otherModules = 20_000; },
    value => { value.excludedScopes = ["Quotes", "Quotes", "Quotes", "Quotes", "Quotes", "Quotes", "Quotes"]; },
  ];
  for (const mutate of mutations) { const value = structuredClone(snapshot); mutate(value); assert.throws(() => parseZohoInboundSnapshot(value), error("SNAPSHOT_INVALID")); }
  const malicious = { get organizationId() { throw new Error("private-provider"); } };
  assert.throws(() => parseZohoInboundSnapshot(malicious), error("SNAPSHOT_INVALID"));
});

test("shape diagnostics expose only static module/field/issue, never row indexes, input values or arbitrary keys", async () => {
  await assert.rejects(readZohoInboundSnapshot(fake([page([{ ...product(), Unit_Price: "private-record" }])]).port, input), value => {
    assert.ok(value instanceof ZohoInboundReadError); assert.deepEqual(value.diagnostic,
      { module: "Products", field: "Unit_Price", issue: "decimal_noncanonical" });
    assert.doesNotMatch(JSON.stringify(value), /private-record|received|path|index/); return true;
  });
  await assert.rejects(readZohoInboundSnapshot(fake([page([]), page([{ ...deal(), Owner: { id: "401", name: 12 } }])]).port, input), value => {
    assert.ok(value instanceof ZohoInboundReadError); assert.deepEqual(value.diagnostic,
      { module: "Deals", field: "Owner", issue: "invalid_type" }); return true;
  });
  for (const value of [{ module: "Customers-private-record", field: "Unit_Price", issue: "invalid_type" },
    { module: "Products", field: "private-record", issue: "invalid_type" }, { module: "Products", field: "Unit_Price", issue: "private-record" },
    { module: "Products", field: "Unit_Price", issue: "invalid_type", value: "private-record" }]) {
    assert.equal(safeZohoInboundDiagnostic(value), undefined);
  }
});

test("source money exponent normalization is exact, bounded and never rounds or cleans decorated currency", async () => {
  const cases = [
    ["1.23E+7", "12300000"], ["1.23e-7", "0.000000123"], ["-1.2300e+2", "-123"], ["0e+100", "0"],
    ["-0.0000e-18", "0"], ["900719925474099312345678901234e-18", "900719925474.099312345678901234"],
    ["9.007199254740993e15", "9007199254740993"], ["1E-18", "0.000000000000000001"],
    ["1e+29", "100000000000000000000000000000"], ["0.00012300e4", "1.23"], ["1.2500", "1.2500"],
  ];
  for (const [source, expected] of cases) {
    const result = await readZohoInboundSnapshot(fake([page([{ ...product(), Unit_Price: source }]),
      page([{ ...deal(), Amount: source }]), page([])]).port, input);
    assert.equal(result.products[0]!.unitPrice, expected); assert.equal(result.deals[0]!.amount, expected);
    assert.equal(parseZohoInboundSnapshot(JSON.parse(JSON.stringify(result))).deals[0]!.amount, expected);
  }
  for (const source of ["1e30", "1e-19", "1.001e-18", "1e1001", "1e-1001", "1e9999999", "1e", "1E+", "01e2", "+1e2", " 1e2 ",
    "", "  ", "1,000.00", "AED 123", "NaN", "Infinity", "1.0000000000000000001"]) {
    await assert.rejects(readZohoInboundSnapshot(fake([page([{ ...product(), Unit_Price: source }])]).port, input), error("RESPONSE_INVALID"));
  }
  const snapshot = await readZohoInboundSnapshot(fake([page([product()]), page([]), page([])]).port, input);
  snapshot.products[0]!.unitPrice = "1e2";
  assert.throws(() => parseZohoInboundSnapshot(snapshot), error("SNAPSHOT_INVALID"));
});
