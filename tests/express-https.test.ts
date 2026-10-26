import assert from "node:assert/strict";
import test from "node:test";
import { frontendBackend, requireNextDatabase } from "../src/server/config/frontend-backend";
import { forwardToExpress as forwardWithIdentity, readExpress as readWithIdentity } from "../src/server/express-bridge";
import { API_IDENTITY_PATH, API_SERVICE_ID } from "@voltronix/crm-contracts";

const local = { CRM_FRONTEND_BACKEND: "express", CRM_EXPRESS_ORIGIN: "http://127.0.0.1:3002", APP_ORIGIN: "http://127.0.0.1:3001" };
const production = { ...local, NODE_ENV: "production", APP_ORIGIN: "https://crm.example.invalid", CRM_API_INSTANCE_ID: "hub-crm" };
// Keep cookie/CSRF assertions focused on the protected call after a verified identity.
// Separate express-identity tests exercise preflight failures and data isolation.
function identityFetcher(fetcher: typeof fetch): typeof fetch {
  return async (url, init) => {
    if (url === local.CRM_EXPRESS_ORIGIN + API_IDENTITY_PATH) {
      assert.equal(init?.method, "GET"); assert.equal(init?.body, undefined);
      assert.deepEqual([...new Headers(init?.headers)], [["accept", "application/json"]]);
      return Response.json({ service: API_SERVICE_ID, instanceId: production.CRM_API_INSTANCE_ID, appOrigin: production.APP_ORIGIN });
    }
    return fetcher(url, init);
  };
}
const forwardToExpress: typeof forwardWithIdentity = (request, env, fetcher = fetch) => forwardWithIdentity(request, env, identityFetcher(fetcher));
const readExpress: typeof readWithIdentity = (path, cookie, env, fetcher = fetch) => readWithIdentity(path, cookie, env, identityFetcher(fetcher));
const token = "a".repeat(43), csrf = "b".repeat(43);
const secureFlags = "; Max-Age=7200; Path=/; HttpOnly; Secure; SameSite=Lax";
function request(path: string, init?: RequestInit) { return new Request(production.APP_ORIGIN + path, init); }

test("OFFLINE production requires Express with canonical HTTPS DNS origin and a private loopback upstream", () => {
  assert.deepEqual(frontendBackend(production), { mode: "express", origin: local.CRM_EXPRESS_ORIGIN, appOrigin: production.APP_ORIGIN, instanceId: production.CRM_API_INSTANCE_ID });
  assert.throws(() => requireNextDatabase(production));
  // A production-mode Next build remains usable by the explicitly selected local demo.
  assert.equal(frontendBackend({ ...local, NODE_ENV: "production" }).mode, "express");
  for (const env of [
    { NODE_ENV: "production" }, { NODE_ENV: "production", CRM_FRONTEND_BACKEND: "nextjs" },
    { APP_ORIGIN: production.APP_ORIGIN }, { APP_ORIGIN: production.APP_ORIGIN, CRM_FRONTEND_BACKEND: "nextjs" },
    { ...production, CRM_EXPRESS_ORIGIN: "http://10.0.0.1:3002" },
    { ...production, CRM_EXPRESS_ORIGIN: "https://crm.example.invalid" },
  ]) {
    assert.throws(() => frontendBackend(env), /^Error: Invalid frontend backend configuration\.$/);
    assert.throws(() => requireNextDatabase(env));
  }
});

test("OFFLINE HTTPS login forwards selected host cookies and actual CSRF/origin without trusting proxy headers", async () => {
  const response = await forwardToExpress(request("/api/auth/login", { method: "POST", headers: {
    origin: production.APP_ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", "x-csrf-token": csrf,
    cookie: `unrelated=fixture; crm_session=${token}; crm_csrf=${token}; __Host-crm_csrf=${csrf}`,
    "x-forwarded-host": "untrusted.example.invalid", "x-forwarded-proto": "http", "x-forwarded-for": "192.0.2.1",
    forwarded: "host=untrusted.example.invalid;proto=http", authorization: "synthetic-fixture-only",
  }, body: JSON.stringify({ email: "fixture@example.invalid", password: "synthetic-fixture-only" }) }), production, async (url, init) => {
    assert.equal(url, local.CRM_EXPRESS_ORIGIN + "/api/v1/auth/login");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("cookie"), `__Host-crm_csrf=${csrf}`);
    assert.equal(headers.get("origin"), production.APP_ORIGIN);
    assert.equal(headers.get("x-csrf-token"), csrf);
    assert.equal(headers.get("sec-fetch-site"), "same-origin");
    for (const name of ["x-forwarded-host", "x-forwarded-proto", "x-forwarded-for", "forwarded", "authorization"]) assert.equal(headers.has(name), false);
    assert.equal(init?.redirect, "manual"); assert.equal(init?.cache, "no-store");
    await new Response(init?.body).arrayBuffer();
    const result = Response.json({ csrfToken: csrf });
    result.headers.append("set-cookie", `__Host-crm_session=${token}${secureFlags}`);
    result.headers.append("set-cookie", `__Host-crm_csrf=${csrf}${secureFlags}`);
    return result;
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.headers.getSetCookie(), [`__Host-crm_session=${token}${secureFlags}`, `__Host-crm_csrf=${csrf}${secureFlags}`]);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.deepEqual(await response.json(), { csrfToken: csrf });
});

test("OFFLINE HTTPS SSR and CSRF challenge use secure host cookies without local-cookie or identity fallback", async () => {
  const cookies = `crm_session=${csrf}; __Host-crm_session=${token}; unrelated=fixture`;
  const value = await readExpress<{ id: string }>("/api/jobs/1", cookies, production, async (url, init) => {
    assert.equal(url, local.CRM_EXPRESS_ORIGIN + "/api/v1/jobs/1");
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("cookie"), `__Host-crm_session=${token}`);
    assert.equal(new Headers(init?.headers).get("origin"), production.APP_ORIGIN);
    return Response.json({ id: "1" });
  });
  assert.equal(value.id, "1");
  const response = await forwardToExpress(request("/api/auth/csrf", { headers: { cookie: cookies } }), production, async (_, init) => {
    assert.equal(new Headers(init?.headers).get("cookie"), `__Host-crm_session=${token}`);
    return Response.json({ csrfToken: csrf }, { headers: { "set-cookie": `__Host-crm_csrf=${csrf}${secureFlags}` } });
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.headers.getSetCookie(), [`__Host-crm_csrf=${csrf}${secureFlags}`]);
});

test("OFFLINE duplicate selected cookies including name whitespace remain visible to authoritative backend rejection", async () => {
  for (const [env, name] of [[local, "crm_session"], [production, "__Host-crm_session"]] as const) {
    const ambiguous = `${name} =${csrf}; ${name}=${token}`;
    const response = await forwardToExpress(new Request(env.APP_ORIGIN + "/api/auth/me", { headers: { cookie: ambiguous } }), env, async (_, init) => {
      assert.equal(new Headers(init?.headers).get("cookie"), ambiguous);
      return Response.json({ error: "Invalid request." }, { status: 400 });
    });
    assert.equal(response.status, 400);
  }
});

test("OFFLINE HTTPS logout retains secure host-cookie deletion for both session and CSRF", async () => {
  const expires = "; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax";
  const response = await forwardToExpress(request("/api/auth/logout", { method: "POST", headers: {
    origin: production.APP_ORIGIN, "x-csrf-token": csrf, cookie: `__Host-crm_session=${token}; __Host-crm_csrf=${csrf}`,
  } }), production, async (_, init) => {
    assert.equal(new Headers(init?.headers).get("cookie"), `__Host-crm_session=${token}; __Host-crm_csrf=${csrf}`);
    const result = Response.json({ signedOut: true });
    result.headers.append("set-cookie", `__Host-crm_session=${expires}`);
    result.headers.append("set-cookie", `__Host-crm_csrf=${expires}`);
    return result;
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.headers.getSetCookie(), [`__Host-crm_session=${expires}`, `__Host-crm_csrf=${expires}`]);
});

test("OFFLINE HTTPS cookie downgrades, scope changes, unexpected names and duplicate flags fail closed", async () => {
  for (const cookie of [
    `__Host-crm_session=${token}; Path=/; HttpOnly; SameSite=Lax`,
    `crm_session=${token}${secureFlags}`, `crm_csrf=${csrf}${secureFlags}`,
    `__Host-crm_session=${token}${secureFlags}; Domain=crm.example.invalid`,
    `__Host-crm_session=${token}${secureFlags}; Secure`,
    `__Host-crm_session=${token}${secureFlags}; Path=/`,
    `__Host-crm_session=${token}; Path=/; Secure; SameSite=Lax`,
    `__Host-crm_session=${token}; Path=/; HttpOnly; Secure; SameSite=None`,
    `__Host-crm_session=${token}; Path=/private; HttpOnly; Secure; SameSite=Lax`,
    `other=${token}${secureFlags}`,
  ]) {
    const response = await forwardToExpress(request("/api/auth/csrf"), production, async () => {
      const result = Response.json({});
      result.headers.append("set-cookie", `__Host-crm_csrf=${csrf}${secureFlags}`);
      result.headers.append("set-cookie", cookie);
      return result;
    });
    assert.equal(response.status, 503); assert.equal(response.headers.has("set-cookie"), false);
    assert.deepEqual(await response.json(), { error: "The service is temporarily unavailable." });
  }
  for (const cookie of [`__Host-crm_session=${token}${secureFlags}`, `crm_session=${token}${secureFlags}`]) {
    const response = await forwardToExpress(new Request(local.APP_ORIGIN + "/api/auth/csrf"), local,
      async () => Response.json({}, { headers: { "set-cookie": cookie } }));
    assert.equal(response.status, 503);
  }
});

test("OFFLINE bridge cannot turn an attacker Origin or Fetch-Metadata header into trusted HTTPS", async () => {
  for (const origin of ["https://attacker.example.invalid", "http://crm.example.invalid", "null"]) {
    const response = await forwardToExpress(request("/api/auth/logout", { method: "POST", headers: {
      origin, "sec-fetch-site": "cross-site", "x-forwarded-proto": "https", "x-forwarded-host": "crm.example.invalid",
    } }), production, async (_, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("origin"), origin); assert.equal(headers.get("sec-fetch-site"), "cross-site");
      assert.equal(headers.has("x-forwarded-proto"), false); assert.equal(headers.has("x-forwarded-host"), false);
      return Response.json({ error: "Invalid request." }, { status: 403 });
    });
    assert.equal(response.status, 403);
  }
});

test("OFFLINE production configuration and upstream failures disclose no credential values and never fall back", async () => {
  const invalid = await forwardToExpress(request("/api/auth/me"), { ...production, CRM_FRONTEND_BACKEND: "nextjs" },
    async () => assert.fail("Invalid production selection must not call any upstream"));
  assert.equal(invalid.status, 503);
  const unavailable = await forwardToExpress(request("/api/auth/me"), production, async () => { throw new Error("synthetic-secret-marker"); });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.text()).includes("synthetic-secret-marker"), false);
});

test("OFFLINE readiness uses the same private Express boundary and preserves redacted dependency statuses", async () => {
  for (const [status, body] of [[200, "ready"], [503, "unavailable"]] as const) {
    const response = await forwardToExpress(request("/api/health/ready"), production, async (url, init) => {
      assert.equal(url, local.CRM_EXPRESS_ORIGIN + "/api/v1/health/ready");
      assert.equal(new Headers(init?.headers).has("cookie"), false);
      return Response.json({ status: body }, { status });
    });
    assert.equal(response.status, status); assert.deepEqual(await response.json(), { status: body });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
