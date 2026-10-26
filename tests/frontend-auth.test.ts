import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { Script } from "node:vm";
import { build } from "esbuild";
import type { AuthUser } from "@voltronix/crm-contracts";

const environment = { CRM_FRONTEND_BACKEND: "express", CRM_EXPRESS_ORIGIN: "http://127.0.0.1:3101", APP_ORIGIN: "http://127.0.0.1:3001" };
const token = "a".repeat(43);
const user: AuthUser = { localUserId: "1", externalUserId: null, username: "Synthetic", email: "fixture@example.invalid", permissions: ["dashboard.view"] };

// Exercise the real SSR auth and bridge with isolated request state.
// Only Next's request context is replaced; no database
// provider can be loaded by this Express-only fixture.
const bundle = build({ stdin: { contents: `
  export { currentUser } from "./src/server/frontend-auth";
  export { ExpressReadError } from "./src/server/express-bridge";
`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, platform: "node", format: "cjs", plugins: [{
  name: "frontend-auth-request-context",
  setup(api) {
    api.onResolve({ filter: /^(?:server-only|next\/headers|\.\/web-auth)$/ }, args => ({ path: args.path, namespace: "fixture" }));
    api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents:
      args.path === "server-only" ? "" : args.path === "next/headers"
        ? "export async function cookies() { return globalThis.__authFixture.cookies; }"
        : "export async function currentUser() { globalThis.__authFixture.legacyCalls++; throw new Error('Unexpected legacy authentication fallback'); }",
      loader: "js",
    }));
  },
}] }).then(result => new Script(result.outputFiles[0]!.text, { filename: "frontend-auth-fixture.cjs" }));

interface FixtureExports {
  currentUser(): Promise<AuthUser | null>;
  ExpressReadError: new (status: number) => Error & { status: number };
}

async function fixture(cookie: string, fetcher: typeof fetch, overrides: Record<string, string | undefined> = {}) {
  const entries = cookie.split(";").filter(Boolean).map(pair => {
    const separator = pair.indexOf("=");
    return [pair.slice(0, separator).trim(), pair.slice(separator + 1)] as const;
  });
  const values = new Map(entries);
  const state = { legacyCalls: 0, cookies: {
    get: (name: string) => values.has(name) ? { name, value: values.get(name)! } : undefined,
    toString: () => cookie,
  } };
  const module = { exports: {} as FixtureExports };
  (await bundle).runInNewContext({ exports: module.exports, module, require: createRequire(import.meta.url),
    process: { env: { ...environment, ...overrides } }, __authFixture: state, fetch: fetcher,
    URL, Request, Response, Headers, AbortSignal, TransformStream, ReadableStream, TextDecoder, Uint8Array,
  });
  return { ...module.exports, state };
}

test("anonymous and malformed sessions need no backend authentication request", async () => {
  for (const cookie of ["", "unrelated=value", `crm_csrf=${token}`, `__Host-crm_session=${token}`, "crm_session=", "crm_session=short", `crm_session=${"a".repeat(44)}`, `crm_session=${"a".repeat(42)}!`]) {
    let calls = 0;
    const auth = await fixture(cookie, async () => { calls++; throw new Error("Backend is unavailable"); });
    assert.equal(await auth.currentUser(), null);
    assert.equal(calls, 0);
    assert.equal(auth.state.legacyCalls, 0);
  }
});

test("HTTPS recognizes only the configured secure session cookie before contacting the backend", async () => {
  const overrides = { APP_ORIGIN: "https://crm.example.invalid", CRM_API_INSTANCE_ID: "fixture-crm" };
  const anonymous = await fixture(`crm_session=${token}`, async () => assert.fail("Wrong cookie must not reach the backend"), overrides);
  assert.equal(await anonymous.currentUser(), null);
  let calls = 0;
  const supplied = await fixture(`__Host-crm_session=${token}`, async () => { calls++; throw new Error("Unavailable identity endpoint"); }, overrides);
  await assert.rejects(supplied.currentUser(), error => error instanceof supplied.ExpressReadError && error.status === 503);
  assert.equal(calls, 1);
  assert.equal(supplied.state.legacyCalls, 0);
});

test("expired sessions remain anonymous when the auth backend returns 401", async () => {
  let calls = 0;
  const auth = await fixture(`crm_session=${token}`, async () => { calls++; return Response.json({ error: "Sign in required." }, { status: 401 }); });
  assert.equal(await auth.currentUser(), null);
  assert.equal(calls, 1);
  assert.equal(auth.state.legacyCalls, 0);
});

test("valid sessions still validate with Express and preserve the returned permissions", async () => {
  for (const permissions of [user.permissions, []]) {
    const expected = { ...user, permissions: [...permissions] };
    let calls = 0;
    const auth = await fixture(`crm_session=${token}; unrelated=private`, async (input, init) => {
      calls++;
      assert.equal(input, environment.CRM_EXPRESS_ORIGIN + "/api/v1/auth/me");
      assert.equal(new Headers(init?.headers).get("cookie"), `crm_session=${token}`);
      assert.equal(init?.cache, "no-store");
      return Response.json({ user: expected });
    });
    assert.deepEqual(await auth.currentUser(), expected);
    assert.equal(calls, 1);
    assert.equal(auth.state.legacyCalls, 0);
  }
});

test("supplied sessions retain safe service errors on outages and malformed identities without legacy fallback", async () => {
  for (const response of [
    () => Response.json({ error: "private backend detail" }, { status: 503 }),
    () => { throw new Error("private backend detail"); },
    () => Response.json({ user: { ...user, password: "private backend detail" } }),
    () => Response.json({ user: null }),
    () => new Response("private backend detail", { headers: { "content-type": "application/json" } }),
  ]) {
    let calls = 0;
    const auth = await fixture(`crm_session=${token}`, async () => { calls++; return response(); });
    const unavailable = (error: unknown) => error instanceof auth.ExpressReadError && error.status === 503
      && error.message === "The service is temporarily unavailable.";
    await assert.rejects(auth.currentUser(), unavailable);
    assert.equal(calls, 1);
    assert.equal(auth.state.legacyCalls, 0);
  }
});
