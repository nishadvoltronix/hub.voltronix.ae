import assert from "node:assert/strict";
import test from "node:test";
import { requestLogin } from "../src/components/login-request";

const csrfToken = "a".repeat(43);
const email = "fixture@example.invalid", password = "synthetic-password";

test("login validates the challenge and submits credentials once with same-origin security", async () => {
  const calls: { path: string; options: RequestInit | undefined }[] = [];
  const result = await requestLogin(email, password, async (input, options) => {
    calls.push({ path: String(input), options });
    assert.equal(options?.credentials, "same-origin");
    assert.equal(options?.redirect, "error");
    assert.equal(options?.cache, "no-store");
    assert.ok(options?.signal instanceof AbortSignal);
    return calls.length === 1 ? Response.json({ csrfToken }) : Response.json({});
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.map(call => call.path), ["/api/auth/csrf", "/api/auth/login"]);
  assert.equal(calls[1]?.options?.method, "POST");
  assert.equal(new Headers(calls[1]?.options?.headers).get("X-CSRF-Token"), csrfToken);
  assert.deepEqual(JSON.parse(String(calls[1]?.options?.body)), { email, password });
});

test("invalid or unavailable CSRF challenges never submit a password", async () => {
  for (const challenge of [null, [], {}, { csrfToken: 123 }, { csrfToken: "short" }, { csrfToken: "a".repeat(42) + "\n" }, { csrfToken: csrfToken + "\n" }]) {
    let calls = 0;
    const result = await requestLogin(email, password, async () => { calls++; return Response.json(challenge); });
    assert.equal(calls, 1); assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /temporarily unavailable/);
  }
  for (const status of [401, 403, 429, 503]) {
    let calls = 0;
    const result = await requestLogin(email, password, async () => { calls++; return new Response(null, { status }); });
    assert.equal(calls, 1); assert.equal(result.ok, false);
    if (!result.ok) assert.doesNotMatch(result.message, /email and password/);
  }
});

test("login distinguishes credential, CSRF, rate-limit and service errors without provider text", async () => {
  for (const [status, expected] of [[401, /email and password/], [403, /security check failed/], [429, /15 minutes/], [400, /temporarily unavailable/], [503, /temporarily unavailable/]] as const) {
    let calls = 0;
    const result = await requestLogin(email, password, async () => ++calls === 1
      ? Response.json({ csrfToken }) : Response.json({ error: "private provider details" }, { status }));
    assert.equal(calls, 2); assert.equal(result.ok, false);
    if (!result.ok) { assert.match(result.message, expected); assert.doesNotMatch(result.message, /private provider details/); }
  }
});

test("malformed JSON, challenge outages and uncertain login outages never retry or leak error text", async () => {
  let calls = 0;
  const malformed = await requestLogin(email, password, async () => { calls++; return new Response("not JSON"); });
  assert.equal(malformed.ok, false); assert.equal(calls, 1);
  for (const failAt of [1, 2]) {
    calls = 0;
    const result = await requestLogin(email, password, async () => {
      if (++calls === failAt) throw new Error("private URL/token");
      return Response.json({ csrfToken });
    });
    assert.equal(calls, failAt); assert.equal(result.ok, false);
    if (!result.ok) { assert.match(result.message, /temporarily unavailable/); assert.doesNotMatch(result.message, /private URL/); }
  }
});
