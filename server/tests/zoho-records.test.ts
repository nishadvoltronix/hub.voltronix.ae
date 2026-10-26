import assert from "node:assert/strict";
import test from "node:test";
import { createZohoClient, ZohoClientError, type ZohoClientRequest } from "../src/integrations/zoho/client.js";
import { readZohoRecords, ZohoRecordReadError, type ZohoReadLimits, type ZohoRecordScope } from "../src/integrations/zoho/records.js";
import type { VerifiedZohoRequestPort } from "../src/integrations/zoho/transports.js";

const modified = "2026-10-15T10:00:00+04:00";
const limits: ZohoReadLimits = { pageSize: 2, maxPages: 10, maxRecords: 20 };
const product = (id = "101") => ({ id, Product_Name: " Synthetic product ", Description: " Exact description\n", Unit_Price: "9007199254740993.000000000000000001", Modified_Time: modified });
const deal = (id = "201") => ({ id, Deal_Name: "Synthetic deal", Stage: "Qualification", Amount: "123.4500",
  Account_Name: { id: "301", name: "Account", email: "ignore@example.invalid" }, Contact_Name: null,
  Owner: { id: "401", name: "Owner" }, Modified_Time: modified });
const note = (id = "501") => ({ id, Note_Title: null, Note_Content: " <b>Unrendered text</b>\n", Parent_Id: { id: "201", module: { api_name: "Deals", id: "901" }, name: "Ignored name" }, Modified_Time: modified });
function page(data: unknown[], pageNumber = 1, more = false, pageSize = 2) {
  return { status: 200, body: { data, info: { page: String(pageNumber), per_page: String(pageSize), count: String(data.length),
    more_records: more, sort_by: "id", sort_order: "asc", next_page_token: more ? `unused-page-token-${pageNumber}` : null } } };
}
function fake(replies: { status: number; body: unknown }[]) {
  const calls: ZohoClientRequest[] = [];
  const port: VerifiedZohoRequestPort = { async request(input) {
    calls.push(structuredClone(input)); const reply = replies.shift(); assert.ok(reply, "No retry or extra request"); return reply;
  } };
  return { calls, port };
}
function failure(code: ZohoRecordReadError["code"]) {
  return (error: unknown) => {
    assert.ok(error instanceof ZohoRecordReadError); assert.equal(error.code, code); assert.equal(error.cause, undefined);
    assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /private-provider-marker|private-token-marker|unused-page-token/);
    assert.equal("records" in error, false); return true;
  };
}

test("record reader requires explicit supported scope and bounded limits before requesting anything", async () => {
  const mock = fake([]); assert.equal(mock.calls.length, 0);
  for (const scope of [undefined, {}, { module: "Accounts" }, { module: "Products", path: "/Deals" },
    { module: "Notes" }, { module: "Notes", dealId: "1/Notes" }, { module: "Notes", dealId: "1".repeat(40) }]) {
    await assert.rejects(readZohoRecords(mock.port, scope as ZohoRecordScope, limits), failure("INPUT_INVALID"));
  }
  for (const invalid of [undefined, {}, { ...limits, pageSize: 0 }, { ...limits, pageSize: 201 }, { ...limits, maxPages: 11 },
    { ...limits, maxRecords: 2001 }, { ...limits, maxRecords: 1 }, { ...limits, maxRecords: Number.NaN },
    { ...limits, maxPages: 1.5 }, { ...limits, cursor: "private-token-marker" }]) {
    await assert.rejects(readZohoRecords(mock.port, { module: "Products" }, invalid as ZohoReadLimits), failure("INPUT_INVALID"));
  }
  assert.equal(mock.calls.length, 0);
});

test("Products use fixed v8 field GETs, exact identifiers/money/text and atomic complete collection", async () => {
  const first = { ...product("90071992547409930"), privateUnknown: "private-provider-marker" };
  const mock = fake([page([first, product("90071992547409931")], 1, true), page([product("90071992547409932")], 2)]);
  const result = await readZohoRecords(mock.port, { module: "Products" }, limits);
  assert.equal(result.module, "Products"); if (result.module !== "Products") assert.fail();
  assert.equal(result.records.length, 3); assert.equal(result.pagesRead, 2); assert.equal(result.complete, true);
  assert.equal(result.snapshotConsistent, false); assert.equal(result.deletionsVerified, false); assert.equal(result.richTextCompletenessVerified, false);
  assert.deepEqual(result.records[0], { externalId: "90071992547409930", name: first.Product_Name, description: first.Description,
    unitPrice: first.Unit_Price, modifiedAt: modified });
  assert.doesNotMatch(JSON.stringify(result), /private-provider-marker|privateUnknown|unused-page-token/);
  for (const [index, input] of mock.calls.entries()) {
    assert.equal(input.apiVersion, "v8"); assert.equal(input.method, "GET"); assert.equal(input.body, undefined);
    const url = new URL(input.path, "https://synthetic.invalid"); assert.equal(url.pathname, "/Products");
    assert.deepEqual(Object.fromEntries(url.searchParams), { fields: "Product_Name,Description,Unit_Price,Modified_Time",
      page: String(index + 1), per_page: "2", sort_by: "id", sort_order: "asc" });
  }
});

test("throwing input/response getters remain typed and redacted", async () => {
  const secretError = () => { throw new Error("private-provider-marker"); };
  const mock = fake([]);
  await assert.rejects(readZohoRecords(mock.port, { get module() { return secretError(); } }, limits), failure("INPUT_INVALID"));
  await assert.rejects(readZohoRecords(mock.port, { module: "Products" }, { ...limits, get pageSize() { return secretError(); } }), failure("INPUT_INVALID"));
  assert.equal(mock.calls.length, 0);
  const reply = page([product()]);
  Object.defineProperty(reply.body, "data", { get: secretError });
  await assert.rejects(readZohoRecords(fake([reply]).port, { module: "Products" }, limits), failure("RESPONSE_INVALID"));
});

test("error/status markers cannot be combined with valid-looking records or pagination", async () => {
  for (const key of ["code", "error", "errors", "status", "message"]) {
    const row = page([{ ...product(), [key]: "private-provider-marker" }]);
    const envelope = { ...page([product()]), body: { ...page([product()]).body, [key]: "private-provider-marker" } };
    for (const reply of [row, envelope]) {
      await assert.rejects(readZohoRecords(fake([reply]).port, { module: "Products" }, limits), failure("RESPONSE_INVALID"));
    }
  }
});

test("Deals expose only known standard fields and preserve nullable values and lookup identities", async () => {
  const source = { ...deal(), PrivateCustomField: "private-provider-marker" }, mock = fake([page([source])]);
  const result = await readZohoRecords(mock.port, { module: "Deals" }, limits);
  assert.equal(result.module, "Deals"); if (result.module !== "Deals") assert.fail();
  assert.deepEqual(result.records, [{ externalId: "201", name: "Synthetic deal", stage: "Qualification", amount: "123.4500",
    account: { externalId: "301", name: "Account" }, contact: null, owner: { externalId: "401", name: "Owner" }, modifiedAt: modified }]);
  assert.doesNotMatch(JSON.stringify(result), /PrivateCustomField|private-provider-marker|ignore@example.invalid/);
  assert.equal(new URL(mock.calls[0]!.path, "https://synthetic.invalid").pathname, "/Deals");
});

test("Notes read only the explicitly chosen deal and preserve content without rendering or inferring missing text", async () => {
  const mock = fake([page([note("502"), note("501")])]);
  const result = await readZohoRecords(mock.port, { module: "Notes", dealId: "201" }, limits);
  assert.equal(result.module, "Notes"); if (result.module !== "Notes") assert.fail();
  assert.equal(result.dealId, "201"); assert.equal(result.records[0]!.content, note().Note_Content); assert.equal(result.records[0]!.title, null);
  const url = new URL(mock.calls[0]!.path, "https://synthetic.invalid");
  assert.equal(url.pathname, "/Deals/201/Notes"); assert.equal(url.searchParams.has("sort_by"), false);
  assert.equal(url.searchParams.has("sort_order"), false); assert.equal(url.searchParams.get("fields"), "Note_Title,Note_Content,Parent_Id,Modified_Time");
  assert.equal(result.richTextCompletenessVerified, false);
});

test("Notes reject foreign parents and mismatched modules before returning a collection", async () => {
  const foreignParent = fake([page([{ ...note(), Parent_Id: { ...note().Parent_Id, id: "202" } }])]);
  await assert.rejects(readZohoRecords(foreignParent.port, { module: "Notes", dealId: "201" }, limits), failure("PARENT_MISMATCH"));
  const foreignModule = fake([page([{ ...note(), Parent_Id: { ...note().Parent_Id, module: { api_name: "Contacts" } } }])]);
  await assert.rejects(readZohoRecords(foreignModule.port, { module: "Notes", dealId: "201" }, limits), failure("RESPONSE_INVALID"));
});

test("204 is empty only on the initial page with no body; contradictory later empty pages are refused", async () => {
  for (const body of [undefined, null]) {
    const mock = fake([{ status: 204, body }]), result = await readZohoRecords(mock.port, { module: "Products" }, limits);
    assert.deepEqual(result.records, []); assert.equal(result.pagesRead, 1); assert.equal(mock.calls.length, 1);
  }
  for (const body of ["", {}, { data: [] }]) {
    await assert.rejects(readZohoRecords(fake([{ status: 204, body }]).port, { module: "Products" }, limits), failure("RESPONSE_INVALID"));
  }
  await assert.rejects(readZohoRecords(fake([page([product()], 1, true), { status: 204, body: undefined }]).port,
    { module: "Products" }, limits), failure("PAGINATION_INVALID"));
  assert.deepEqual((await readZohoRecords(fake([page([])]).port, { module: "Products" }, limits)).records, []);
  await assert.rejects(readZohoRecords(fake([page([], 1, true)]).port, { module: "Products" }, limits), failure("PAGINATION_INVALID"));
});

test("metadata count/page/per-page numbers may be exact strings or safe ints, never coercible variants", async () => {
  const numeric = page([product()]); Object.assign(numeric.body.info, { page: 1, per_page: 2, count: 1 });
  assert.equal((await readZohoRecords(fake([numeric]).port, { module: "Products" }, limits)).records.length, 1);
  for (const [key, value] of [["page", "01"], ["page", "1.0"], ["page", "1e0"], ["page", 2], ["per_page", "200"],
    ["count", "2"], ["count", "-1"], ["count", 1.5], ["count", true], ["more_records", "false"], ["more_records", undefined]]) {
    const reply = page([product()]); Object.assign(reply.body.info, { [String(key)]: value });
    await assert.rejects(readZohoRecords(fake([reply]).port, { module: "Products" }, limits), failure("PAGINATION_INVALID"));
  }
});

test("repeated pages, duplicate IDs within/across pages and nonascending module order cannot pass", async () => {
  const fixtures = [
    { replies: [page([product(), product()])], code: "DUPLICATE_RECORD" as const },
    { replies: [page([product()], 1, true), page([product()], 2)], code: "DUPLICATE_RECORD" as const },
    { replies: [page([product()], 1, true), page([product("102")], 1)], code: "PAGINATION_INVALID" as const },
    { replies: [page([product("102"), product("101")])], code: "PAGINATION_INVALID" as const },
  ];
  for (const fixture of fixtures) await assert.rejects(readZohoRecords(fake(fixture.replies).port, { module: "Products" }, limits), failure(fixture.code));
  for (const patch of [{ sort_order: "desc" }, { sort_by: "Product_Name" }, { next_page_token: "private-token-marker" }]) {
    const reply = page([product()]); Object.assign(reply.body.info, patch);
    await assert.rejects(readZohoRecords(fake([reply]).port, { module: "Products" }, limits), failure("PAGINATION_INVALID"));
  }
});

test("record and page caps refuse truncation without any out-of-budget request or partial result", async () => {
  for (const bounds of [{ ...limits, maxPages: 1 }, { ...limits, maxRecords: 2 }, { ...limits, maxRecords: 3 }]) {
    const mock = fake([page([product("101"), product("102")], 1, true)]);
    await assert.rejects(readZohoRecords(mock.port, { module: "Products" }, bounds), failure("LIMIT_EXCEEDED"));
    assert.equal(mock.calls.length, 1);
  }
  const exact = await readZohoRecords(fake([page([product("101"), product("102")])]).port, { module: "Products" }, { ...limits, maxRecords: 2 });
  assert.equal(exact.records.length, 2); assert.equal(exact.complete, true);
});

test("partial errors, missing/oversized data and false HTTP successes cannot become a complete collection", async () => {
  for (const body of [undefined, null, [], {}, { ...page([product()]).body, code: "private-provider-marker" },
    { ...page([product()]).body, error: "private-token-marker" }, { data: [product()] },
    { ...page([product()]).body, data: "private-provider-marker" }, page([product(), product("102"), product("103")]).body,
    page([{ code: "private-provider-marker", ...product() }]).body]) {
    await assert.rejects(readZohoRecords(fake([{ status: 200, body }]).port, { module: "Products" }, limits), failure("RESPONSE_INVALID"));
  }
  for (const [status, code] of [[401, "ACCESS_DENIED"], [403, "ACCESS_DENIED"], [429, "RATE_LIMITED"],
    [206, "REQUEST_FAILED"], [500, "REQUEST_FAILED"], [Number.NaN, "RESPONSE_INVALID"]] as const) {
    const mock = fake([page([product()], 1, true), { status, body: { message: "private-provider-marker" } }]);
    await assert.rejects(readZohoRecords(mock.port, { module: "Products" }, limits), failure(code)); assert.equal(mock.calls.length, 2);
  }
});

test("lossy numeric money/IDs, absent selected values, invalid timestamps and long text are refused without repair", async () => {
  for (const patch of [{ id: 9007199254740992 }, { id: "1".repeat(40) }, { Unit_Price: 0.01 }, { Unit_Price: "1e30" },
    { Unit_Price: undefined }, { Description: undefined }, { Modified_Time: "2026-02-30T00:00:00Z" },
    { Modified_Time: "not a date" }, { Product_Name: "x\0y" }, { Description: "x".repeat(100_001) }]) {
    await assert.rejects(readZohoRecords(fake([page([{ ...product(), ...patch }])]).port, { module: "Products" }, limits), failure("RESPONSE_INVALID"));
  }
  const nullable = await readZohoRecords(fake([page([{ ...product(), Unit_Price: null, Description: null }])]).port, { module: "Products" }, limits);
  assert.equal(nullable.module, "Products"); if (nullable.module !== "Products") assert.fail();
  assert.equal(nullable.records[0]!.unitPrice, null); assert.equal(nullable.records[0]!.description, null);
});

test("transport failures are redacted without logging, retries or returning prior page records", async context => {
  const logs: unknown[][] = [];
  context.mock.method(console, "log", (...args: unknown[]) => { logs.push(args); });
  context.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  let calls = 0;
  await assert.rejects(readZohoRecords({ async request() { calls++; if (calls === 1) return page([product()], 1, true);
    throw new Error("private-provider-marker private-token-marker"); } }, { module: "Products" }, limits), failure("REQUEST_FAILED"));
  assert.equal(calls, 2); assert.deepEqual(logs, []);
});

test("record reads preserve source catalog layout and exact exponent money consistently with snapshot imports", async () => {
  const sourceName = ` Synthetic\r\nproduct\t${"x".repeat(1900)} `;
  const description = ` <b>Plain source text</b>\n${"x".repeat(99_900)}`;
  const products = await readZohoRecords(fake([page([{ ...product(), Product_Name: sourceName, Description: description,
    Unit_Price: "9.007199254740993e15" }])]).port, { module: "Products" }, limits);
  assert.equal(products.module, "Products"); if (products.module !== "Products") assert.fail();
  assert.equal(products.records[0]!.name, sourceName); assert.equal(products.records[0]!.description, description);
  assert.equal(products.records[0]!.unitPrice, "9007199254740993");
  const deals = await readZohoRecords(fake([page([{ ...deal(), Deal_Name: "Synthetic\nproject", Amount: "1.23e-7" }])]).port,
    { module: "Deals" }, limits);
  assert.equal(deals.module, "Deals"); if (deals.module !== "Deals") assert.fail();
  assert.equal(deals.records[0]!.name, "Synthetic\nproject"); assert.equal(deals.records[0]!.amount, "0.000000123");
});

test("source parsing still rejects blank names, forbidden controls, oversized values and unrepresentable money", async () => {
  for (const name of [" ", "\r\n\t", "x\u0001y", "x\u007fy", "x".repeat(2001)]) {
    await assert.rejects(readZohoRecords(fake([page([{ ...product(), Product_Name: name }])]).port,
      { module: "Products" }, limits), failure("RESPONSE_INVALID"));
  }
  for (const stage of [" ", "Closed\nWon", "Qualification\t"]) {
    await assert.rejects(readZohoRecords(fake([page([{ ...deal(), Stage: stage }])]).port,
      { module: "Deals" }, limits), failure("RESPONSE_INVALID"));
  }
  for (const amount of ["1e-19", "1.001e-18", "1e30", "1e1001", "1e9999999", "01e2", "+1e2", " 1e2 ", "AED 1", 1e2]) {
    await assert.rejects(readZohoRecords(fake([page([{ ...deal(), Amount: amount }])]).port,
      { module: "Deals" }, limits), failure("RESPONSE_INVALID"));
  }
});

test("typed client exceptions preserve permission and rate-limit categories without arbitrary exception inspection", async () => {
  for (const [status, expected] of [[401, "ACCESS_DENIED"], [403, "ACCESS_DENIED"], [429, "RATE_LIMITED"],
    [500, "REQUEST_FAILED"]] as const) {
    let calls = 0;
    await assert.rejects(readZohoRecords({ async request() { calls++; throw new ZohoClientError("HTTP_FAILED", status); } },
      { module: "Products" }, limits), failure(expected));
    assert.equal(calls, 1);
  }
  await assert.rejects(readZohoRecords({ async request() { throw { httpStatus: 403, message: "private-provider-marker" }; } },
    { module: "Products" }, limits), failure("REQUEST_FAILED"));
});

test("real verified HTTP boundary propagates business read refusal categories without exposing body or retrying", async () => {
  for (const [status, expected] of [[403, "ACCESS_DENIED"], [429, "RATE_LIMITED"]] as const) {
    let calls = 0;
    const client = createZohoClient({ clientId: "synthetic-client", clientSecret: "synthetic-secret", refreshToken: "synthetic-refresh",
      environment: "production", organizationId: "12345", allowWrites: false }, { networkEnabled: true, fetch: async url => {
        calls++; const path = new URL(String(url)).pathname;
        if (path.endsWith("/token")) return new Response(JSON.stringify({ access_token: "synthetic-access", api_domain: "https://www.zohoapis.com",
          token_type: "Bearer", expires_in: 3600 }), { headers: { "Content-Type": "application/json" } });
        if (path.endsWith("/org")) return new Response('{"org":[{"id":"12345","type":"production"}]}', { headers: { "Content-Type": "application/json" } });
        return new Response("private-provider-marker", { status });
      } });
    try { await assert.rejects(readZohoRecords(client, { module: "Products" }, limits), failure(expected)); }
    finally { client.close(); }
    assert.equal(calls, 3);
  }
});

test("reader uses real verified client and lossless synthetic HTTP without requiring unsupported paths or coercing money", async () => {
  const calls: { url: string; method: string }[] = [];
  const responses = [
    JSON.stringify({ access_token: "synthetic-access", api_domain: "https://www.zohoapis.com", token_type: "Bearer", expires_in: 3600 }),
    '{"org":[{"id":"12345","type":"production"}]}',
    '{"data":[{"id":90071992547409931,"Product_Name":"Synthetic","Description":null,"Unit_Price":9007199254740993.000000000000000001,"Modified_Time":"2026-10-15T10:00:00+04:00"}],"info":{"page":1,"per_page":2,"count":1,"more_records":false,"sort_by":"id","sort_order":"asc","next_page_token":null}}',
  ];
  const client = createZohoClient({ clientId: "synthetic-client", clientSecret: "synthetic-secret", refreshToken: "synthetic-refresh",
    environment: "production", organizationId: "12345", allowWrites: false }, { networkEnabled: true, fetch: async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" }); const raw = responses.shift(); assert.ok(raw);
      return new Response(raw, { headers: { "Content-Type": "application/json" } });
    } });
  try {
    const result = await readZohoRecords(client, { module: "Products" }, limits);
    assert.equal(result.module, "Products"); if (result.module !== "Products") assert.fail();
    assert.equal(result.records[0]!.externalId, "90071992547409931");
    assert.equal(result.records[0]!.unitPrice, "9007199254740993.000000000000000001");
    assert.equal(calls.length, 3); assert.deepEqual(calls.map(call => call.method), ["POST", "GET", "GET"]);
    assert.equal(calls[1]!.url, "https://www.zohoapis.com/crm/v8/org");
    assert.equal(new URL(calls[2]!.url).pathname, "/crm/v8/Products");
  } finally { client.close(); }
});

test("related notes route and mandatory field selection also pass through the real verified client", async () => {
  const paths: string[] = [];
  const client = createZohoClient({ clientId: "synthetic-client", clientSecret: "synthetic-secret", refreshToken: "synthetic-refresh",
    environment: "sandbox", organizationId: "12345", allowWrites: false }, { networkEnabled: true, fetch: async (url, init) => {
      const path = new URL(String(url)).pathname; paths.push(path);
      const body = path.endsWith("/token") ? { access_token: "synthetic-access", api_domain: "https://www.zohoapis.com", token_type: "Bearer", expires_in: 3600 }
        : path.endsWith("/org") ? { org: [{ id: "12345", type: "sandbox" }] } : page([note()]).body;
      if (path.endsWith("/Notes")) { assert.equal(init?.method, "GET"); assert.equal(new URL(String(url)).searchParams.has("fields"), true); }
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    } });
  try { assert.equal((await readZohoRecords(client, { module: "Notes", dealId: "201" }, limits)).records.length, 1); }
  finally { client.close(); }
  assert.deepEqual(paths, ["/oauth/v2/token", "/crm/v8/org", "/crm/v8/Deals/201/Notes"]);
});
