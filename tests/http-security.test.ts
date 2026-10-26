import assert from "node:assert/strict";
import test from "node:test";
import { parseWebConfig } from "../src/server/config/web";
import { cookieOptions, HttpError, readJson, rejectCrossOriginRead, requireCsrf, requireSameOrigin } from "../src/server/http-security";

const config = parseWebConfig({ APP_ORIGIN: "http://127.0.0.1:3001" });
const token = "a".repeat(43);
test("web origin rejects missing, malformed and non-loopback HTTP configuration without leaking values", () => {
  for (const origin of [undefined, "http://example.test", "https://user:secret@example.test", "https://example.test/path", "https://example.test/"]) {
    assert.throws(() => parseWebConfig({ APP_ORIGIN: origin }), /^Error: Invalid APP_ORIGIN configuration\.$/);
  }
  const secure = parseWebConfig({ APP_ORIGIN: "https://crm.example.test" });
  assert.equal(secure.sessionCookie, "__Host-crm_session");
  assert.deepEqual(cookieOptions(secure, 7200), { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 7200 });
});
test("mutations require exact origin and matching bounded CSRF tokens", () => {
  const request = (origin?: string, csrf = token) => new Request(config.origin, { headers: { ...(origin ? { origin } : {}), "X-CSRF-Token": csrf } });
  for (const origin of [undefined, "null", "https://attacker.test", `${config.origin}.attacker.test`]) {
    assert.throws(() => requireSameOrigin(request(origin), config), HttpError);
  }
  requireSameOrigin(request(config.origin), config);
  assert.equal(requireCsrf(request(config.origin), token), token);
  assert.throws(() => requireCsrf(request(config.origin, "b".repeat(43)), token), HttpError);
  assert.throws(() => requireCsrf(request(config.origin), undefined), HttpError);
  assert.throws(() => rejectCrossOriginRead(new Request(config.origin, { headers: { "Sec-Fetch-Site": "cross-site" } }), config), HttpError);
  assert.throws(() => rejectCrossOriginRead(new Request(config.origin, { headers: { "Sec-Fetch-Site": "same-site" } }), config), HttpError);
});
test("JSON parser rejects unsupported, malformed and oversized streamed requests", async () => {
  const request = (body: string, type = "application/json") => new Request(config.origin, { method: "POST", headers: { "Content-Type": type }, body });
  await assert.rejects(readJson(request("{}", "text/plain")), (error: unknown) => error instanceof HttpError && error.status === 415);
  await assert.rejects(readJson(request("bad")), (error: unknown) => error instanceof HttpError && error.status === 400);
  await assert.rejects(readJson(request(JSON.stringify({ oversized: "a".repeat(9000) }))), (error: unknown) => error instanceof HttpError && error.status === 413);
  assert.deepEqual(await readJson(request('{"email":"fixture@example.test"}')), { email: "fixture@example.test" });
});

test("commercial JSON limits allow bounded larger payloads without weakening default or streamed byte enforcement", async () => {
  const payload = JSON.stringify({ description: "€".repeat(4000) });
  const request = (body: string, length?: string) => new Request(config.origin, { method: "POST", body,
    headers: { "Content-Type": "application/json", ...(length === undefined ? {} : { "Content-Length": length }) } });
  await assert.rejects(readJson(request(payload)), (error: unknown) => error instanceof HttpError && error.status === 413);
  assert.equal((await readJson(request(payload), 65_536) as { description: string }).description.length, 4000);
  await assert.rejects(readJson(request(payload, "1"), 10_000), (error: unknown) => error instanceof HttpError && error.status === 413);
  await assert.rejects(readJson(request("{}", "262145"), 262_144), (error: unknown) => error instanceof HttpError && error.status === 413);
  await assert.rejects(readJson(request("{}"), 262_145), (error: unknown) => error instanceof HttpError && error.status === 500);
});
