import assert from "node:assert/strict";
import test from "node:test";
import { readZohoInboundChanges } from "../src/integrations/zoho/inbound-sync-reader.js";
import { openZohoInboundSource } from "../src/integrations/zoho/inbound-sync-source.js";
import { DEFAULT_ZOHO_INBOUND_LIMITS, ZohoInboundSyncError, parseZohoInboundChangeSet,
  type ZohoInboundChangesInput, type ZohoInboundSyncFailure } from "../src/integrations/zoho/inbound-sync-contracts.js";
import { ZohoClientError, type ZohoClientRequest } from "../src/integrations/zoho/client.js";
import type { VerifiedZohoRequestPort } from "../src/integrations/zoho/transports.js";
const created = "2025-01-01T00:00:00+04:00", modified = "2026-10-19T10:00:00+04:00";
const input: ZohoInboundChangesInput = { organizationId: "3001", startedAt: modified, limits: { ...DEFAULT_ZOHO_INBOUND_LIMITS, pageSize: 2 } };
const product = { id: "101", Product_Name: " Source product ", Description: null, Created_Time: created, Modified_Time: modified };
const deal = { id: "201", Deal_Name: "Historical deal", Stage: "Site Visit", VZ_App_Status: "Site Visit", Amount: "2.50",
  VZ_app_user: { id: "501", name: "Original assignee" }, Owner: { id: "701", name: "Different owner" },
  Created_Time: created, Modified_Time: modified, SiteDealNumber: "SITE-100" };
const note = { id: "301", Note_Title: "Historical note", Note_Content: "<b>Exact source</b>",
  Parent_Id: { id: "201", module: { api_name: "Deals" } }, Created_Time: created, Modified_Time: modified };
const quote = { id: "401", Subject: "Historical quote", Quote_No: "QUOTE-001", Deal_Name: { id: "201", name: "Historical deal" },
  Contact_Name: null, Created_Time: created, Modified_Time: modified, Sub_Total: "9007199254740993.000000000000000001",
  Discount: null, Tax: "0.10", Grand_Total: "123.456", Quoted_Items: [{ id: "901", Product_Name: { id: "101", name: "Source product" },
    Quantity: "1.000000000000000001", List_Price: "2.40", ItemDiscount: "10.000", Net_Total: "123.450" }], $has_more: { Quoted_Items: false } };
const appUser = { id: "501", Name: "Original assignee", Email: "synthetic@example.invalid", user_status: "active", Created_Time: created, Modified_Time: modified };
type Reply = { status: number; body: unknown };
function page(data: unknown[], index = 1, more = false, token: string | null = null): Reply { return { status: 200, body: { data,
  info: { per_page: "2", page: String(index), count: String(data.length), more_records: more, sort_by: "id", sort_order: "asc", next_page_token: token } } }; }
function fixture(override?: (request: ZohoClientRequest, calls: ZohoClientRequest[]) => Reply | undefined | Promise<Reply | undefined>) {
  const calls: ZohoClientRequest[] = [];
  const port: VerifiedZohoRequestPort = { async request(request) {
    calls.push(structuredClone(request)); const selected = await override?.(request, calls); if (selected) return selected;
    const path = new URL(request.path, "https://fixed.invalid").pathname;
    if (path === "/org") return { status: 200, body: { org: [{ id: "3001", type: "production" }] } };
    if (path.endsWith("/deleted")) return page([{ id: "999", deleted_time: modified, type: "recycle" }]);
    if (path === "/Quotes/401") return { status: 200, body: { data: [quote] } };
    const data: Record<string, unknown[]> = { "/Products": [product], "/Deals": [deal], "/Notes": [note],
      "/Quotes": [{ id: quote.id, Modified_Time: modified }], "/VZ_app_users": [appUser] };
    assert.ok(data[path], "Only the fixed collection or exact quoted identity is requested"); return page(data[path]);
  } };
  return { port, calls };
}
function error(code: ZohoInboundSyncFailure) { return (value: unknown) => {
  assert.ok(value instanceof ZohoInboundSyncError); assert.equal(value.code, code); assert.equal(value.cause, undefined);
  assert.doesNotMatch(String(value.stack) + JSON.stringify(value), /private-source|private-token/); return true;
}; }

test("complete read-only changes preserve historical source values, quotes, identities and explicit tombstones", async () => {
  const f = fixture(), result = await readZohoInboundChanges(f.port, input);
  assert.equal(result.requestsPerformed, 12); assert.equal(result.nextWatermark, input.startedAt); assert.equal(result.since, null);
  assert.equal(result.quotes[0]!.totals.subtotal, quote.Sub_Total); assert.equal(result.quotes[0]!.totals.grandTotal, "123.456", "Never recompute historical totals");
  assert.equal(result.quotes[0]!.lines[0]!.quantity, "1.000000000000000001"); assert.deepEqual(result.quotes[0]!.source, quote);
  assert.equal(result.quotes[0]!.totals.discount, null); assert.ok(!result.quotes[0]!.missingOptionalFields.includes("Discount"));
  assert.ok(result.quotes[0]!.missingOptionalFields.includes("Adjustment")); assert.equal(result.quotes[0]!.totals.adjustment, null);
  assert.equal(result.products[0]!.name, " Source product "); assert.deepEqual(result.products[0]!.missingOptionalFields, ["Unit_Price"]);
  assert.equal(result.deals[0]!.assignedTo?.externalId, "501"); assert.equal(result.deals[0]!.owner?.externalId, "701");
  assert.equal(result.appUsers[0]!.externalId, "501"); assert.equal(result.deals[0]!.siteNumber, "SITE-100");
  assert.equal(result.notes[0]!.content, note.Note_Content); assert.equal(result.tombstones.length, 4);
  assert.equal(result.coverage.notesDeletions, false); assert.equal(result.snapshotConsistent, false);
  assert.deepEqual(parseZohoInboundChangeSet(JSON.parse(JSON.stringify(result))), result);
  assert.ok(f.calls.every(call => call.method === "GET" && call.body === undefined)); assert.ok(f.calls.every(call => !call.path.startsWith("/Notes/deleted")));
});

test("incremental reads bind identical since except for Notes, retaining Notes for unchanged parent Deals", async () => {
  const since = "2026-10-19T09:58:00+04:00", f = fixture(request => request.path.startsWith("/Deals?") ? page([]) : undefined);
  const result = await readZohoInboundChanges(f.port, { ...input, since }); assert.equal(result.deals.length, 0); assert.equal(result.notes[0]!.dealId, "201");
  for (const call of f.calls) assert.equal(call.ifModifiedSince, call.path === "/org" || call.path === "/Quotes/401" || call.path.startsWith("/Notes?") ? undefined : "2026-10-19T05:58:00+00:00");
});

test("incremental Notes recover old converted notes even after their parent Deal left the checkpoint window", async () => {
  const since = "2026-10-19T09:58:00+04:00", old = "2026-09-24T10:41:13+04:00";
  const f = fixture(request => {
    if (request.path.startsWith("/Deals?")) return page([]);
    if (!request.path.startsWith("/Notes?")) return undefined;
    assert.equal(request.ifModifiedSince, undefined, "A conditional provider response could hide converted historical notes");
    const continuation = new URL(request.path, "https://fixed.invalid").searchParams.get("page_token");
    return continuation === null ? page([{ ...note, Created_Time: old, Modified_Time: old },
      { ...note, id: "302", Parent_Id: { id: "202", module: { api_name: "Leads" } }, Created_Time: old, Modified_Time: old }], 1, true, "notes-next")
      : page([{ ...note, id: "303", Created_Time: old, Modified_Time: old }]);
  });
  const result = await readZohoInboundChanges(f.port, { ...input, since });
  assert.equal(result.deals.length, 0); assert.equal(result.excludedOtherModuleNotes, 1);
  assert.deepEqual(result.notes.map(row => [row.externalId, row.dealId, row.createdAt, row.modifiedAt]),
    [["301", "201", old, old], ["303", "201", old, old]]);
  assert.equal(result.since, since); assert.equal(result.nextWatermark, input.startedAt);
  assert.equal(f.calls.filter(call => call.path.startsWith("/Notes?")).length, 2);
});

test("historical Notes reconciliation refuses partial pages and enforces note and byte budgets", async () => {
  const historical = { ...note, Created_Time: created, Modified_Time: created };
  for (const [scenario, code] of [["count", "LIMIT_EXCEEDED"], ["bytes", "LIMIT_EXCEEDED"], ["conditional", "REQUEST_FAILED"], ["later-empty", "PAGINATION_INVALID"]] as const) {
    const f = fixture(request => {
      if (!request.path.startsWith("/Notes?")) return undefined;
      if (scenario === "conditional") return { status: 304, body: undefined };
      if (scenario === "bytes") return page([{ ...historical, Note_Content: "x".repeat(2000) }]);
      if (scenario === "later-empty") return new URL(request.path, "https://fixed.invalid").searchParams.has("page_token")
        ? { status: 204, body: undefined } : page([historical], 1, true, "notes-next");
      return page([historical, { ...historical, id: "302" }]);
    });
    await assert.rejects(readZohoInboundChanges(f.port, { ...input, since: modified,
      limits: { ...input.limits, ...(scenario === "count" ? { maxNotes: 1 } : {}), ...(scenario === "bytes" ? { maxBytes: 1024 } : {}) } }), error(code));
  }
});

test("incremental headers and row filters share the floored second boundary while preserving original cursor identity", async () => {
  const since = "2026-10-19T06:00:00.987Z";
  const f = fixture(request => {
    if (request.path.includes("/deleted?")) return page([{ id: "999", deleted_time: created, type: "recycle" }]);
    const module = request.path.split("?")[0], rows: Record<string, unknown[]> = { "/Products": [product], "/Deals": [deal], "/Notes": [note],
      "/Quotes": [{ id: quote.id }], "/VZ_app_users": [appUser] };
    return rows[module!]?page(rows[module!]!.map(row=>({...(row as object),Modified_Time:"2026-10-19T05:59:59Z"}))):undefined;
  });
  const result = await readZohoInboundChanges(f.port, { ...input, startedAt: "2026-10-19T07:00:00Z", since });
  assert.equal(result.products.length + result.deals.length + result.quotes.length + result.appUsers.length + result.tombstones.length, 0);
  assert.equal(result.notes.length, 1); assert.equal(result.notes[0]!.modifiedAt, "2026-10-19T05:59:59Z");
  assert.equal(result.requestsPerformed, 11); assert.equal(result.since, since);
  assert.ok(!f.calls.some(call => /^\/Quotes\/\d+$/.test(call.path)), "Old quote list versions never cause exact detail GETs");
  for (const call of f.calls.filter(call => call.path !== "/org")) assert.equal(call.ifModifiedSince, call.path.startsWith("/Notes?") ? undefined : "2026-10-19T06:00:00+00:00");
  const ties = await readZohoInboundChanges(fixture().port, { ...input, startedAt: "2026-10-19T07:00:00Z", since });
  assert.equal(ties.products.length, 1); assert.equal(ties.quotes.length, 1); assert.equal(ties.tombstones.length, 4);
  const invalidOld = fixture(request => request.path.startsWith("/Products?") ? page([{ ...product, Modified_Time: created, Product_Name: "" }]) : undefined);
  await assert.rejects(readZohoInboundChanges(invalidOld.port, { ...input, since: modified }), error("RESPONSE_INVALID"));
  const tooManyOld = fixture(request => request.path.includes("/deleted?") ? page([{ id: "999", deleted_time: created, type: "recycle" }]) : undefined);
  await assert.rejects(readZohoInboundChanges(tooManyOld.port, { ...input, since: modified, limits: { ...input.limits, maxTombstones: 3 } }), error("LIMIT_EXCEEDED"));
});

test("actual short final pages fit remaining entity and global tombstone budgets", async () => {
  const f = fixture(request => request.path.startsWith("/VZ_app_users/deleted?") ? { status: 204, body: undefined } : undefined);
  const result = await readZohoInboundChanges(f.port, { ...input, limits: { ...input.limits, maxProducts: 1, maxTombstones: 3 } });
  assert.equal(result.products.length, 1); assert.equal(result.tombstones.length, 3);
  await assert.rejects(readZohoInboundChanges(fixture().port, { ...input, limits: { ...input.limits, maxTombstones: 3 } }), error("LIMIT_EXCEEDED"));
});

test("opaque tokens remain parameters of one fixed collection and source ID ordering remains checked", async () => {
  const token = "https://private-token.invalid/path?x=+y", f = fixture(request => {
    const url = new URL(request.path, "https://fixed.invalid"); if (url.pathname !== "/Products") return;
    if (!url.searchParams.has("page_token")) return page([product, { ...product, id: "102" }], 1, true, token);
    assert.equal(url.searchParams.get("page_token"), token); assert.equal(url.searchParams.has("page"), false);
    return page([{ ...product, id: "103" }]);
  });
  const result = await readZohoInboundChanges(f.port, input); assert.equal(result.products.length, 3); assert.equal(result.requestsPerformed, 13);
  assert.ok(f.calls.every(call => call.path.startsWith("/") && !call.path.startsWith("//")));
});

test("a partial, duplicate, regressing or contradictory page never yields a completed change set", async () => {
  for (const scenario of ["duplicate", "regression", "empty-later", "repeated-token"] as const) {
    const f = fixture(request => {
      const url = new URL(request.path, "https://fixed.invalid"); if (url.pathname !== "/Products") return;
      if (!url.searchParams.has("page_token")) return page([product, { ...product, id: "102" }], 1, true, "cursor-a");
      if (scenario === "duplicate") return page([{ ...product, id: "102" }]);
      if (scenario === "regression") return page([{ ...product, id: "100" }]);
      if (scenario === "empty-later") return { status: 204, body: undefined };
      return page([{ ...product, id: "103" }], 1, true, "cursor-a");
    });
    await assert.rejects(readZohoInboundChanges(f.port, input), error(scenario === "duplicate" ? "RESPONSE_INVALID" : "PAGINATION_INVALID"));
  }
});

test("source quote detail must be complete, exact-identity and at least as current as its list observation", async () => {
  for (const [patch, code] of [[{ id: "402" }, "RESPONSE_INVALID"], [{ Modified_Time: created }, "RESPONSE_INVALID"],
    [{ $has_more: { Quoted_Items: true } }, "INCOMPLETE_QUOTE"], [{ Sub_Total: 1.2 }, "RESPONSE_INVALID"]] as const) {
    const f = fixture(request => request.path === "/Quotes/401" ? { status: 200, body: { data: [{ ...quote, ...patch }] } } : undefined);
    await assert.rejects(readZohoInboundChanges(f.port, input), error(code));
  }
});

test("quote detail reads cap concurrency at four, retain source order and drain failures without starting queued reads", async () => {
  const ids = Array.from({ length: 8 }, (_, index) => String(401 + index));
  for (const shouldFail of [false, true]) {
    let active = 0, peak = 0; const completed: string[] = [];
    const f = fixture(async request => {
      if (request.path.startsWith("/Quotes?")) return page(ids.map(id => ({ id, Modified_Time: modified })));
      const selected = /^\/Quotes\/(\d+)$/.exec(request.path)?.[1]; if (!selected) return undefined;
      active++; peak = Math.max(peak, active);
      try {
        if (shouldFail && selected === "401") return { status: 200, body: { message: "private-source" } };
        await new Promise(resolve => setTimeout(resolve, (409 - Number(selected)) * 2)); completed.push(selected);
        return { status: 200, body: { data: [{ ...quote, id: selected }] } };
      } finally { active--; }
    });
    const port: VerifiedZohoRequestPort = { async request(value) {
      const reply = await f.port.request(value), body = reply.body as { info?: { per_page: string } };
      if (body?.info) body.info.per_page = "8"; return reply;
    } };
    const pass = readZohoInboundChanges(port, { ...input, limits: { ...input.limits, pageSize: 8 } });
    if (shouldFail) { await assert.rejects(pass, error("RESPONSE_INVALID")); assert.equal(f.calls.filter(call => /^\/Quotes\/\d+$/.test(call.path)).length, 4); }
    else { const result = await pass; assert.deepEqual(result.quotes.map(row => row.externalId), ids); assert.notDeepEqual(completed, ids); assert.equal(peak, 4); }
    assert.equal(active, 0); assert.ok(peak <= 4);
  }
});

test("staged quote financial tampering and missing-field contradictions are refused", async () => {
  const result = await readZohoInboundChanges(fixture().port, input);
  const financial = structuredClone(result); financial.quotes[0]!.totals.grandTotal = "0"; assert.throws(() => parseZohoInboundChangeSet(financial), error("RESPONSE_INVALID"));
  const missing = structuredClone(result); missing.products[0]!.unitPrice = "1"; assert.throws(() => parseZohoInboundChangeSet(missing), error("RESPONSE_INVALID"));
  const cursor = structuredClone(result); cursor.nextWatermark = created; assert.throws(() => parseZohoInboundChangeSet(cursor), error("RESPONSE_INVALID"));
});

test("parent modules other than Deals are counted, while malformed parent data refuses the pass", async () => {
  const f = fixture(request => request.path.startsWith("/Notes?") ? page([{ ...note, Parent_Id: { id: "201", module: { api_name: "Contacts" } } }]) : undefined);
  const result = await readZohoInboundChanges(f.port, input); assert.equal(result.notes.length, 0); assert.equal(result.excludedOtherModuleNotes, 1);
  await assert.rejects(readZohoInboundChanges(fixture(request => request.path.startsWith("/Notes?") ? page([{ ...note, Parent_Id: null }]) : undefined).port, input), error("RESPONSE_INVALID"));
});

test("org changes, request/byte limits and stale deletion cursor fail without a watermark result", async () => {
  for (const when of ["start", "end"]) {
    const f = fixture((request, calls) => request.path === "/org" && (when === "start" || calls.length > 1)
      ? { status: 200, body: { org: [{ id: "3999", type: "production" }] } } : undefined);
    await assert.rejects(readZohoInboundChanges(f.port, input), error("ORGANIZATION_MISMATCH")); if (when === "start") assert.equal(f.calls.length, 1);
  }
  await assert.rejects(readZohoInboundChanges(fixture().port, { ...input, limits: { ...input.limits, maxRequests: 11 } }), error("LIMIT_EXCEEDED"));
  await assert.rejects(readZohoInboundChanges(fixture(request => request.path.startsWith("/Products?") ? page([{ ...product, Description: "x".repeat(2000) }]) : undefined).port,
    { ...input, limits: { ...input.limits, maxBytes: 1024 } }), error("LIMIT_EXCEEDED"));
  const old = fixture(); await assert.rejects(readZohoInboundChanges(old.port, { ...input, since: created }), error("CURSOR_TOO_OLD")); assert.equal(old.calls.length, 0);
});

test("permission, rate limit and cancellation errors are bounded and never leak provider details", async () => {
  for (const [status, code] of [[403, "ACCESS_DENIED"], [429, "RATE_LIMITED"], [503, "REQUEST_FAILED"]] as const) {
    await assert.rejects(readZohoInboundChanges(fixture(() => { throw new ZohoClientError("HTTP_FAILED", status); }).port, input), error(code));
  }
  await assert.rejects(readZohoInboundChanges(fixture(() => { throw new Error("private-source private-token"); }).port, input), error("REQUEST_FAILED"));
  const controller = new AbortController(), f = fixture(() => { controller.abort(); return undefined; });
  await assert.rejects(readZohoInboundChanges(f.port, input, controller.signal), error("ABORTED")); assert.equal(f.calls.length, 1);
});

test("only transient GET failures retry at most twice within the shared request budget", async () => {
  for (const transient of [new ZohoClientError("TIMEOUT"), new ZohoClientError("UNAVAILABLE"), new ZohoClientError("HTTP_FAILED", 502)]) {
    let attempts = 0;
    const f = fixture(request => { if (request.path.startsWith("/Products?") && ++attempts === 1) throw transient; return undefined; });
    const result = await readZohoInboundChanges(f.port, input); assert.equal(attempts, 2); assert.equal(result.requestsPerformed, 13);
  }
  const failed = fixture(() => { throw new ZohoClientError("UNAVAILABLE"); });
  await assert.rejects(readZohoInboundChanges(failed.port, input), error("REQUEST_FAILED")); assert.equal(failed.calls.length, 3);
  for (const failure of [new ZohoClientError("HTTP_FAILED", 401), new ZohoClientError("HTTP_FAILED", 403), new ZohoClientError("HTTP_FAILED", 429),
    new ZohoClientError("ORGANIZATION_MISMATCH"), new ZohoClientError("RESPONSE_INVALID"), new ZohoClientError("RESPONSE_TOO_LARGE")]) {
    const f = fixture(() => { throw failure; }); await assert.rejects(readZohoInboundChanges(f.port, input)); assert.equal(f.calls.length, 1);
  }
  const bounded = fixture((request, calls) => { if (calls.length === 11) throw new ZohoClientError("UNAVAILABLE");
    if (request.path.startsWith("/Quotes?")) return page([]); return undefined; });
  await assert.rejects(readZohoInboundChanges(bounded.port, { ...input, limits: { ...input.limits, maxRequests: 11 } }), error("LIMIT_EXCEEDED"));
  assert.equal(bounded.calls.length, 11);
});

test("caller cancellation interrupts retry backoff before a second GET", async () => {
  const controller = new AbortController();
  const f = fixture(() => { setTimeout(() => controller.abort("private-source"), 10); throw new ZohoClientError("TIMEOUT"); });
  await assert.rejects(readZohoInboundChanges(f.port, input, controller.signal), error("ABORTED")); assert.equal(f.calls.length, 1);
});

test("empty conditional responses are valid only on the first page and initial 304 is refused", async () => {
  const f = fixture(request => request.path !== "/org" ? { status: request.path.startsWith("/Notes?") ? 204 : 304, body: undefined } : undefined);
  const result = await readZohoInboundChanges(f.port, { ...input, since: modified }); assert.equal(result.requestsPerformed, 11); assert.equal(result.products.length, 0);
  await assert.rejects(readZohoInboundChanges(fixture(request => request.path !== "/org" ? { status: 304, body: undefined } : undefined).port, input), error("REQUEST_FAILED"));
});

test("source factory uses its independent read-only client and exposes lifecycle cancellation", async () => {
  const calls: { path: string; method: string | undefined }[] = []; let started: (() => void) | undefined, pending = false;
  const began = new Promise<void>(resolve => { started = resolve; });
  const source = await openZohoInboundSource({ organizationId: "3001", credentials: { clientId: "synthetic-client", clientSecret: "synthetic-secret", refreshToken: "synthetic-refresh" } },
    { networkEnabled: true, fetch: async (url, init) => {
      const path = new URL(String(url)).pathname; calls.push({ path, method: init?.method });
      if (path === "/oauth/v2/token") return Response.json({ access_token: "synthetic-access", api_domain: "https://www.zohoapis.com", token_type: "Bearer", expires_in: 3600 });
      if (path === "/crm/v8/org") return Response.json({ org: [{ id: "3001", type: "production" }] });
      pending = true; started!(); return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("private-source")), { once: true }));
    } });
  const read = source.readChanges(input); await began; assert.equal(pending, true);
  await assert.rejects(source.readChanges(input), error("INPUT_INVALID")); source.close(); source.close();
  await assert.rejects(read, error("ABORTED")); await assert.rejects(source.readiness(), error("ABORTED"));
  assert.ok(calls.every(call => call.path === "/oauth/v2/token" || call.method === "GET"));
});

test("a per-pass cancellation aborts the request without closing the reusable read-only source", async () => {
  let announce: (() => void) | undefined, block = true, reads = 0;
  const began = new Promise<void>(resolve => { announce = resolve; });
  const source = await openZohoInboundSource({ organizationId: "3001", credentials: { clientId: "synthetic-client", clientSecret: "synthetic-secret", refreshToken: "synthetic-refresh" } },
    { networkEnabled: true, fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/oauth/v2/token") return Response.json({ access_token: "synthetic-access", api_domain: "https://www.zohoapis.com", token_type: "Bearer", expires_in: 3600 });
      if (path === "/crm/v8/org") return Response.json({ org: [{ id: "3001", type: "production" }] });
      reads++;
      if (!block) return new Response(null, { status: 204 });
      announce!(); return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("private-token")), { once: true }));
    } });
  try {
    const controller = new AbortController(), pass = source.readChanges(input, controller.signal); await began; controller.abort("private-source");
    await assert.rejects(pass, error("ABORTED")); assert.equal(reads, 1);
    block = false; await source.readiness();
    const empty = await source.readChanges(input); assert.equal(empty.products.length + empty.deals.length + empty.quotes.length + empty.tombstones.length, 0);
    assert.equal(empty.requestsPerformed, 11);
  } finally { source.close(); }
});
