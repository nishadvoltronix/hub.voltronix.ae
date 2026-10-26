import assert from "node:assert/strict";
import { test } from "node:test";
import { assertNoHarnessDebug, createHttpBrowserRunner, HttpBrowserHarnessError, isOwnedBrowserRequest, type HttpBrowserEffects, type HttpBrowserOptions } from "../scripts/mysql-auth/http-browser.js";
import type { AuthService } from "../src/auth/service.js";

// Deliberately fake effects only: no MySQL, browser launch, network listener,
// authentication store or write is exercised by these preparation tests.
const uuid = "123456789abc4def8123456789abcdef";
function options(): HttpBrowserOptions {
  return {
    runtimeConfig: { provider: "mysql", environment: "test", host: "127.0.0.1", port: 3308,
      database: `crm_local_auth_${uuid}`, user: `auth_r_${uuid.slice(0, 24)}`, password: "synthetic-test-only-private-value" },
    identities: { allowed: { email: "http-allowed@auth-fixture.invalid", password: "synthetic-allowed-password" },
      denied: { email: "http-denied@auth-fixture.invalid", password: "synthetic-denied-password" } },
    browser: true, record: () => {},
    createAuthentication: () => { throw new Error("Must not construct a real adapter in an offline test."); },
  };
}
function fixture(change: Partial<HttpBrowserEffects> = {}) {
  const actions: string[] = [];
  const effects: HttpBrowserEffects = {
    open: async () => { actions.push("open"); return { origin: "http://127.0.0.1:4001", close: async () => { actions.push("close"); } }; },
    http: async () => { actions.push("http"); return 6; },
    chromium: async () => { actions.push("chromium"); return 4; },
    ...change,
  };
  return { actions, effects, run: createHttpBrowserRunner(effects) };
}
async function safeFailure(work: Promise<unknown>) {
  await assert.rejects(work, error => {
    assert.ok(error instanceof HttpBrowserHarnessError);
    assert.equal(error.message, "Isolated authentication HTTP/browser verification refused or failed; private diagnostics were suppressed.");
    assert.equal(error.cause, undefined);
    return true;
  });
}

test("HTTP/browser runner sequences fake effects and closes its owned target", async () => {
  const f = fixture(); assert.equal(await f.run(options()), 10);
  assert.deepEqual(f.actions, ["open", "http", "chromium", "close"]);
});
test("HTTP-only execution does not construct a browser", async () => {
  const f = fixture(); assert.equal(await f.run({ ...options(), browser: false }), 6);
  assert.deepEqual(f.actions, ["open", "http", "close"]);
});
test("application database, non-loopback host, wrong port or driver fail before every effect", async () => {
  const invalid = [
    { environment: "development", database: "crm_local_dev" }, { database: "crm_nextjs_development" },
    { database: "crm_local_auth_123456789abc1def8123456789abcdef" }, { database: "mysql" },
    { host: "localhost" }, { host: "127.0.0.2" }, { host: "example.invalid" }, { port: 3306 },
    { provider: "sqlite" }, { environment: "staging" }, { password: "" }, { unexpected: "profile" },
  ];
  for (const change of invalid) {
    const f = fixture(), input = options();
    input.runtimeConfig = { ...input.runtimeConfig, ...change } as HttpBrowserOptions["runtimeConfig"];
    await safeFailure(f.run(input)); assert.deepEqual(f.actions, []);
  }
});
test("dedicated runtime identity must match the exact isolated schema suffix", async () => {
  for (const user of ["root", "application", `auth_m_${uuid.slice(0, 24)}`, `auth_f_${uuid.slice(0, 24)}`, `auth_r_${"a".repeat(24)}`]) {
    const f = fixture(), input = options(); input.runtimeConfig.user = user;
    await safeFailure(f.run(input)); assert.deepEqual(f.actions, []);
  }
});
test("only separate reserved synthetic email identities reach the fake target", async () => {
  for (const identity of [
    { email: "real@example.com", password: "value" }, { email: "bad-address", password: "value" },
    { email: "allowed@fixture.invalid", password: "" }, { email: "allowed@fixture.invalid", password: "x\0y" },
    { email: "allowed@fixture.invalid", password: "a".repeat(1025) },
  ]) {
    const f = fixture(), input = options(); input.identities.allowed = identity;
    await safeFailure(f.run(input)); assert.deepEqual(f.actions, []);
  }
  const f = fixture(), input = options(); input.identities.denied.email = input.identities.allowed.email.toUpperCase();
  await safeFailure(f.run(input)); assert.deepEqual(f.actions, []);
});
test("tracked authentication factory, explicit browser flag and recorder are mandatory", async () => {
  for (const field of ["createAuthentication", "browser", "record"] as const) {
    const f = fixture(), input = options();
    delete (input as unknown as Record<string, unknown>)[field];
    await safeFailure(f.run(input)); assert.deepEqual(f.actions, []);
  }
});
test("runner snapshots and freezes validated target and identity metadata", async () => {
  const input = options(); let observed: HttpBrowserOptions | undefined;
  const f = fixture({ open: async current => {
    observed = current;
    input.runtimeConfig.host = "wrong" as "127.0.0.1";
    input.identities.allowed.email = "changed@example.com";
    return { origin: "http://127.0.0.1:4001", close: async () => {} };
  } });
  await f.run(input);
  assert.equal(observed?.runtimeConfig.host, "127.0.0.1");
  assert.equal(observed?.identities.allowed.email, "http-allowed@auth-fixture.invalid");
  assert.ok(Object.isFrozen(observed) && Object.isFrozen(observed.runtimeConfig) && Object.isFrozen(observed.identities.allowed));
});
test("an unowned or non-loopback origin is rejected and the opened handle is closed", async () => {
  for (const origin of ["https://example.invalid", "http://localhost:4001", "http://127.0.0.2:4001", "http://127.0.0.1:80", "http://127.0.0.1:4001/", "http://user:private@127.0.0.1:4001"]) {
    let closed = 0;
    const f = fixture({ open: async () => ({ origin, close: async () => { closed++; } }) });
    await safeFailure(f.run(options())); assert.equal(closed, 1); assert.deepEqual(f.actions, []);
  }
});
test("open failure is sanitized and no later effect runs", async () => {
  const f = fixture({ open: async () => { throw new Error("password=cookie=private database details"); } });
  await safeFailure(f.run(options())); assert.deepEqual(f.actions, []);
});
test("HTTP failure closes the server and never begins Chromium", async () => {
  const f = fixture({ http: async () => { throw new Error("sensitive request contents"); } });
  await safeFailure(f.run(options())); assert.deepEqual(f.actions, ["open", "close"]);
});
test("Chromium failure closes the server without exposing browser output", async () => {
  const f = fixture({ chromium: async () => { throw new Error("browser cookie and synthetic password"); } });
  await safeFailure(f.run(options())); assert.deepEqual(f.actions, ["open", "http", "close"]);
});
test("cleanup failure is safely surfaced even after successful checks", async () => {
  const f = fixture({ open: async () => ({ origin: "http://127.0.0.1:4001", close: async () => { throw new Error("database connection details"); } }) });
  await safeFailure(f.run(options())); assert.deepEqual(f.actions, ["http", "chromium"]);
});
test("zero, negative, fractional and non-finite results cannot become claimed passes", async () => {
  for (const count of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const f = fixture({ http: async () => count }); await safeFailure(f.run(options()));
    assert.deepEqual(f.actions, ["open", "close"]);
    const browser = fixture({ chromium: async () => count }); await safeFailure(browser.run(options()));
    assert.deepEqual(browser.actions, ["open", "http", "close"]);
  }
});
test("recording failures remain fatal, sanitized and trigger owned cleanup", async () => {
  const f = fixture({ http: async (_target, input) => { input.record("safe-case-name", "http"); return 1; } });
  const input = options(); input.record = () => { throw new Error("private log destination"); };
  await safeFailure(f.run(input)); assert.deepEqual(f.actions, ["open", "close"]);
});
test("tracked factory is passed through without construction in offline orchestration", async () => {
  let factoryCalls = 0;
  const input = options();
  input.createAuthentication = () => { factoryCalls++; return { auth: {} as AuthService, close: async () => {} }; };
  const f = fixture(); await f.run(input); assert.equal(factoryCalls, 0);
});
test("browser network policy permits only owned-origin test and auth routes", () => {
  const origin = "http://127.0.0.1:4001";
  for (const path of ["/__auth-harness/login", "/__auth-harness/client.js", "/__auth-harness/permission", "/api/v1/auth/csrf", "/api/v1/auth/login", "/api/v1/auth/me", "/api/v1/auth/logout"]) {
    assert.equal(isOwnedBrowserRequest(origin, `${origin}${path}`), true);
  }
  for (const url of ["https://example.invalid/", "http://127.0.0.1:4002/api/v1/auth/me", "http://localhost:4001/api/v1/auth/me",
    "https://127.0.0.1:4001/api/v1/auth/me", "ws://127.0.0.1:4001/api/v1/auth/me", "about:blank", "data:text/plain,test",
    "http://name:private@127.0.0.1:4001/api/v1/auth/me", `${origin}/api/v1/auth/me?private=value`, `${origin}/api/v1/auth/me#private`,
    `${origin}/api/v1/leads`, `${origin}/.env.local`, `${origin}/favicon.ico`, `${origin}/api/v1/auth/%6de`]) {
    assert.equal(isOwnedBrowserRequest(origin, url), false);
  }
  assert.equal(isOwnedBrowserRequest("http://localhost:4001", "http://localhost:4001/api/v1/auth/me"), false);
});
test("debug and inspector settings that can disclose request credentials are refused", () => {
  assert.doesNotThrow(() => assertNoHarnessDebug({}, ["--import", "tsx"]));
  for (const key of ["NODE_DEBUG", "NODE_DEBUG_NATIVE", "DEBUG", "PWDEBUG", "NODE_OPTIONS"]) {
    assert.throws(() => assertNoHarnessDebug({ [key]: "synthetic-debug-setting" }, []), HttpBrowserHarnessError);
  }
  for (const argument of ["--inspect", "--inspect=9229", "--inspect-brk", "--inspect-brk=9229", "--inspect-port=9229"]) {
    assert.throws(() => assertNoHarnessDebug({}, [argument]), HttpBrowserHarnessError);
  }
});
