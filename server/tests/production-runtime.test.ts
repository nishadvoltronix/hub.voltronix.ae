import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { loadConfig, ConfigurationError } from "../src/config.js";
import { createApp, READINESS_PATH } from "../src/app.js";
import { createHttpLifecycle } from "../src/server.js";
import { authCookiePolicy } from "../src/auth/http.js";
import { createCrmRuntime } from "../src/runtime/composition.js";
import { createReadinessProbe } from "../src/runtime/readiness.js";
import { assertValidatedRuntimeConfiguration, loadRuntimeConfiguration, productionRuntimeAcknowledgement,
  RuntimeConfigurationError, runtimeProfilePath, validateRuntimeConfiguration } from "../src/runtime/configuration.js";
import { readPrivateMigrationProfile, readPrivateRuntimeProfile } from "../src/runtime/private-profile.js";

const settings = { CRM_API_ENVIRONMENT: "production", CRM_API_HOST: "127.0.0.1", CRM_API_PORT: "3002",
  APP_ORIGIN: "https://crm.example.invalid", CRM_RUNTIME_ENABLE: productionRuntimeAcknowledgement, CRM_RUNTIME_PROFILE: runtimeProfilePath };
const api = loadConfig(settings);
const now = 1_800_000_000_000;
function profile() {
  return { version: 2, mysql: { provider: "mysql", environment: "production", host: "127.0.0.1", port: 3306,
    database: "crm_synthetic_test", user: "crm_runtime", password: "synthetic-test-only-not-a-credential" },
  approval: { approved: true, reference: "Synthetic offline approval", provisioningReference: "Synthetic offline receipt",
    serverUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
  issuer: { company: "VOLTRONIX CONTRACTING LLC", salesperson: "Synthetic approved display name" } };
}

test("OFFLINE production API requires canonical HTTPS DNS origin and never opens a public listener", () => {
  assert.equal(api.environment, "production");
  assert.equal(api.host, "127.0.0.1");
  for (const origin of ["http://crm.example.invalid", "http://127.0.0.1:3001", "https://127.0.0.1", "https://[::1]",
    "https://localhost", "https://crm.localhost", "https://crm.example.invalid:443", "https://crm.example.invalid:8443",
    "https://crm.example.invalid/", "https://crm.example.invalid?private=synthetic", "https://crm.example.invalid#fragment",
    "https://user@crm.example.invalid", "https://CRM.example.invalid", "https://crm.example.invalid.", "https://bad_label.example.invalid"]) {
    assert.throws(() => loadConfig({ ...settings, APP_ORIGIN: origin }), ConfigurationError);
  }
  for (const host of ["0.0.0.0", "::", "localhost"]) assert.throws(() => loadConfig({ ...settings, CRM_API_HOST: host }), ConfigurationError);
  assert.equal(loadConfig({ ...settings, CRM_API_HOST: "::1" }).host, "::1");
  for (const mode of ["development", "test", "staging"]) {
    assert.throws(() => loadConfig({ ...settings, CRM_API_ENVIRONMENT: mode }), ConfigurationError);
  }
});

test("OFFLINE production uses explicit v2 approved private profile with immutable owner issuer and no daily expiry", async () => {
  const input = profile();
  const configuration = loadRuntimeConfiguration("unused", settings, (_root, name) => {
    assert.equal(name, runtimeProfilePath); return input;
  }, now);
  assert.equal(configuration.mysql.port, 3306);
  assert.deepEqual(configuration.issuer, input.issuer);
  assert.ok(Object.isFrozen(configuration.issuer));
  input.issuer.salesperson = "Caller changed input";
  assert.equal(configuration.issuer?.salesperson, "Synthetic approved display name");
  assertValidatedRuntimeConfiguration(configuration, now + 365 * 86_400_000);
  const runtime = createCrmRuntime(configuration);
  assert.equal(typeof runtime.crmServices.commercial.createQuotation, "function");
  assert.equal(typeof runtime.readiness, "function");
  await runtime.close(); // Pure construction: no database connection or data write.
});

test("OFFLINE production selection cannot reinterpret local approval or fall back to another credential file", () => {
  for (const patch of [{ CRM_RUNTIME_ENABLE: "approved-local-mysql-crm-runtime" }, { CRM_RUNTIME_ENABLE: "" },
    { CRM_RUNTIME_PROFILE: ".env" }, { CRM_RUNTIME_PROFILE: ".local-data/operators/mysql-crm-migration.json" }, { DEBUG: "1" }]) {
    let reads = 0;
    assert.throws(() => loadRuntimeConfiguration("unused", { ...settings, ...patch }, () => { reads++; return profile(); }, now), RuntimeConfigurationError);
    assert.equal(reads, 0);
  }
  const invalid = [{ ...profile(), version: 1 }, { ...profile(), issuer: undefined },
    { ...profile(), issuer: { company: "Unapproved synthetic company", salesperson: "Synthetic salesperson" } },
    { ...profile(), issuer: { ...profile().issuer, salesperson: "" } },
    { ...profile(), issuer: { ...profile().issuer, salesperson: "private\ntext" } },
    { ...profile(), approval: { ...profile().approval, approved: false } },
    { ...profile(), approval: { ...profile().approval, validUntil: "2099-01-01T00:00:00Z" } },
    { ...profile(), approval: { ...profile().approval, serverUuid: "placeholder" } },
    { ...profile(), mysql: { ...profile().mysql, environment: "test" } },
    { ...profile(), mysql: { ...profile().mysql, password: "" } },
    { ...profile(), mysql: { ...profile().mysql, host: "database.example.invalid" } },
    { ...profile(), mysql: { ...profile().mysql, user: "root" } },
    { ...profile(), mysql: { ...profile().mysql, database: "mysql" } }];
  for (const input of invalid) assert.throws(() => validateRuntimeConfiguration(input, api, now), RuntimeConfigurationError);
  assert.throws(() => assertValidatedRuntimeConfiguration({ ...validateRuntimeConfiguration(profile(), api, now) }, now), RuntimeConfigurationError);
});

test("OFFLINE private runtime and migration readers cannot exchange profiles", () => {
  assert.throws(() => readPrivateRuntimeProfile("unused", ".local-data/operators/mysql-crm-migration.json"), RuntimeConfigurationError);
  assert.throws(() => readPrivateMigrationProfile("unused", runtimeProfilePath), RuntimeConfigurationError);
});

test("OFFLINE readiness is bounded, single-flight, sanitized and rechecks after completion", async () => {
  let calls = 0, complete: (() => void) | undefined;
  const probe = createReadinessProbe(async () => { calls++; await new Promise<void>(resolve => { complete = resolve; }); }, 10);
  assert.deepEqual(await Promise.all([probe(), probe()]), [false, false]);
  assert.equal(calls, 1);
  const resumed = probe(); complete!(); assert.equal(await resumed, true);
  const next = probe(); await Promise.resolve(); complete!(); assert.equal(await next, true);
  assert.equal(calls, 2);
  assert.equal(await createReadinessProbe(async () => { throw new Error("synthetic-private-driver-message"); })(), false);
  for (const deadline of [0, -1, 5001, Number.NaN]) assert.throws(() => createReadinessProbe(async () => {}, deadline));
});

test("OFFLINE HTTPS cookie and HTTP health composition keeps readiness separate, private and origin guarded", async () => {
  let checks = 0, healthy = true;
  const app = createApp(api, { readiness: async () => { checks++; if (!healthy) throw new Error("synthetic-private-driver-message"); return true; } });
  assert.equal(app.get("trust proxy"), false);
  const policy = authCookiePolicy(api.appOrigin);
  assert.equal(policy.sessionCookie, "__Host-crm_session"); assert.equal(policy.csrfCookie, "__Host-crm_csrf");
  assert.deepEqual(policy.options, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 7_200_000 });
  const server = createServer(app), lifecycle = createHttpLifecycle(server);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const call = (path: string, method = "GET", headers: Record<string, string> = {}) => new Promise<{ status: number; body: string; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, path, method, headers, agent: false }, response => {
      let body = ""; response.on("data", chunk => { body += String(chunk); }); response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode!, body, headers: response.headers }));
    }); req.on("error", reject); req.end();
  });
  try {
    const ready = await call(READINESS_PATH);
    assert.equal(ready.status, 200); assert.deepEqual(JSON.parse(ready.body), { status: "ready" });
    assert.equal(ready.headers["cache-control"], "no-store"); assert.equal(ready.headers["set-cookie"], undefined);
    assert.equal(ready.headers["strict-transport-security"], "max-age=31536000");
    assert.equal((await call(READINESS_PATH, "HEAD")).body, ""); assert.equal(checks, 2);
    assert.equal((await call(READINESS_PATH, "POST")).status, 405);
    assert.equal((await call(`${READINESS_PATH}?token=synthetic`)).status, 400);
    assert.equal((await call(READINESS_PATH, "GET", { origin: "https://unapproved.example.invalid", "x-forwarded-proto": "https" })).status, 403);
    assert.equal(checks, 2);
    healthy = false;
    const unavailable = await call(READINESS_PATH);
    assert.equal(unavailable.status, 503); assert.deepEqual(JSON.parse(unavailable.body), { status: "unavailable" });
    assert.equal((await call("/api/v1/health/live")).status, 200); assert.equal(checks, 3);
  } finally { await lifecycle.stop(); }
});
