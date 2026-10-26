import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertApiIdentity, assertApiReadiness, assertBuildOutput, assertNoEnvironmentFiles, assertPortFree, loadNativeConfiguration, loadZohoConfiguration, loadZohoSyncConfiguration, prepareApiRuntime, projectRoot, startApi, main, validateApplication, validateProfile } from "./run-hub.mjs";
import { mysqlEnvironmentKeys, nativeEnvironmentKeys, zohoCredentialKeys, zohoRuntimeKeys, zohoSyncKeys } from "./hub-environment.mjs";
import { tsImport } from "tsx/esm/api";

const common = { NODE_ENV: "production", APP_ORIGIN: "https://hub.voltronix.ae", CRM_API_INSTANCE_ID: "hub-crm",
  CRM_DATABASE_MODE: "disabled", CRM_MYSQL_NETWORK_DISABLED: "1", ZOHO_ENABLED: "false", NEXT_TELEMETRY_DISABLED: "1" };
const web = { ...common, CRM_WEB_HOST: "127.0.0.1", CRM_WEB_PORT: "3301", CRM_FRONTEND_BACKEND: "express", CRM_EXPRESS_ORIGIN: "http://127.0.0.1:3302" };
const api = { ...common, CRM_API_ENVIRONMENT: "production", CRM_API_HOST: "127.0.0.1", CRM_API_PORT: "3302" };
const identity = { service: "hub-crm-api", instanceId: "hub-crm", appOrigin: common.APP_ORIGIN };
const nativeSettings = { CRM_DATABASE_MODE: "mysql-native", CRM_MYSQL_NETWORK_DISABLED: "0",
  CRM_RUNTIME_ENABLE: "approved-production-mysql-crm-runtime", CRM_RUNTIME_SOURCE: "environment",
  CRM_MYSQL_HOST: "127.0.0.1", CRM_MYSQL_PORT: "3306", CRM_MYSQL_DATABASE: "hub_native_fixture",
  CRM_MYSQL_USER: "hub_runtime_fixture", CRM_MYSQL_PASSWORD: "private-fixture-value$literal\\n",
  CRM_MYSQL_SERVER_UUID: "11111111-1111-4111-8111-111111111111", CRM_MYSQL_APPROVED: "true",
  CRM_MYSQL_APPROVAL_REFERENCE: "fixture runtime approval", CRM_MYSQL_PROVISIONING_REFERENCE: "fixture provisioning",
  CRM_MYSQL_ISSUER_COMPANY: "VOLTRONIX CONTRACTING LLC", CRM_MYSQL_ISSUER_SALESPERSON: "Fixture Operator" };
const importSource = url => tsImport(url, import.meta.url);
const zohoSettings = { ZOHO_ENABLED: "true", ZOHO_CLIENT_ID: "synthetic-client", ZOHO_CLIENT_SECRET: "synthetic-secret",
  ZOHO_REFRESH_TOKEN: "synthetic-refresh", ZOHO_ORGANIZATION_ID: "123", ZOHO_ACCOUNT_OWNER_ID: "456",
  ZOHO_PROFILE: "voltronix-native-outbound-v1", ZOHO_DEAL_PIPELINE: "Standard (Standard)", ZOHO_AUTOMATION_POLICY: "suppressed" };

test("native mode requires explicit acknowledgement, environment source, network selection and every runtime field", () => {
  for (const key of Object.keys(nativeSettings)) {
    const missing = { ...api, ...nativeSettings }; delete missing[key];
    assert.throws(() => validateProfile("api", missing), undefined, `native mode requires ${key}`);
  }
  for (const change of [{ CRM_RUNTIME_SOURCE: "profile" }, { CRM_RUNTIME_ENABLE: "approved-local-mysql-crm-runtime" },
    { CRM_RUNTIME_PROFILE: ".local-data/operators/mysql-crm-runtime.json" }, { CRM_MYSQL_NETWORK_DISABLED: "1" }, { ZOHO_ENABLED: "true" }]) {
    assert.throws(() => validateProfile("api", { ...api, ...nativeSettings, ...change }));
  }
  const profile = validateProfile("api", { ...api, ...nativeSettings });
  assert.equal(profile.databaseMode, "mysql-native");
  assert.equal(profile.environment.CRM_MYSQL_PASSWORD, nativeSettings.CRM_MYSQL_PASSWORD);
});

test("native configuration reuses the actual production validator without importing composition or connecting", async () => {
  const imported = [];
  const configuration = await loadNativeConfiguration(projectRoot, validateProfile("api", { ...api, ...nativeSettings }), true, async url => {
    imported.push(url);
    return importSource(url);
  });
  assert.equal(configuration.mysql.password, nativeSettings.CRM_MYSQL_PASSWORD);
  assert.equal(configuration.serverUuid, nativeSettings.CRM_MYSQL_SERVER_UUID);
  assert.equal(configuration.api.instanceId, common.CRM_API_INSTANCE_ID);
  assert.equal(imported.length, 1);
  assert.match(imported[0], /runtime\/configuration\.ts$/);
  const settings = await importSource(new URL("../server/src/runtime/environment-settings.ts", import.meta.url).href);
  assert.deepEqual(mysqlEnvironmentKeys, settings.mysqlEnvironmentKeys);
  for (const change of [{ CRM_MYSQL_HOST: "192.0.2.1" }, { CRM_MYSQL_PORT: "3307" }, { CRM_MYSQL_USER: "root" },
    { CRM_MYSQL_DATABASE: "mysql" }, { CRM_MYSQL_APPROVED: "false" }, { CRM_MYSQL_SERVER_UUID: "private-fixture-value" },
    { CRM_MYSQL_ISSUER_COMPANY: "unapproved" }, { CRM_MYSQL_ISSUER_SALESPERSON: "\nprivate-fixture-value" }]) {
    await assert.rejects(loadNativeConfiguration(projectRoot, validateProfile("api", { ...api, ...nativeSettings, ...change }), true, importSource),
      error => /configuration failed/.test(error.message) && !error.message.includes("private-fixture-value"));
  }
});

test("optional Zoho storage remains disabled and is bounded without revealing secrets", () => {
  for (const mode of [api, { ...api, ...nativeSettings }]) {
    const profile = validateProfile("api", { ...mode, ZOHO_CLIENT_ID: "private-fixture-value", ZOHO_CLIENT_SECRET: "private-fixture-value", ZOHO_REFRESH_TOKEN: "private-fixture-value" });
    assert.equal(profile.environment.ZOHO_REFRESH_TOKEN, "private-fixture-value");
    for (const key of zohoCredentialKeys) for (const value of ["private-fixture-value\n", "\0private-fixture-value", "x".repeat(4097)]) {
      assert.throws(() => validateProfile("api", { ...mode, [key]: value }), error => !error.message.includes("private-fixture-value"));
    }
  }
});

test("web child process blanks backend fields even when Next loads the same root dotenv file", () => {
  const root = mkdtempSync(join(tmpdir(), "hub-next-env-test-"));
  try {
    writeFileSync(join(root, ".env"), "CRM_MYSQL_PASSWORD='private-fixture-value$VARIABLE'\nZOHO_REFRESH_TOKEN=private-fixture-value\nCRM_RUNTIME_SOURCE=environment\n");
    const profile = validateProfile("web", { ...web, ...nativeSettings, ZOHO_REFRESH_TOKEN: "private-fixture-value" });
    for (const key of [...nativeEnvironmentKeys, ...zohoCredentialKeys, ...zohoRuntimeKeys]) assert.equal(profile.environment[key], "");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e",
      "import nextEnv from '@next/env'; nextEnv.loadEnvConfig(process.argv[1]); process.stdout.write(JSON.stringify([process.env.CRM_MYSQL_PASSWORD,process.env.ZOHO_REFRESH_TOKEN,process.env.CRM_RUNTIME_SOURCE]));", root],
    { cwd: projectRoot, env: profile.environment, encoding: "utf8", windowsHide: true });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), ["", "", ""]);
    assert.doesNotMatch(child.stdout + child.stderr, /private-fixture-value/);
  } finally { rmSync(root, { recursive: true }); }
});

function nativeRuntimeFixture(options = {}) {
  const calls = [];
  const runtime = { auth: {}, crmServices: {}, readiness: async () => { calls.push("ready"); return options.ready ?? true; },
    close: async () => { calls.push("close"); if (options.closeFails) throw new Error("private-fixture-value"); } };
  if (options.sync) runtime.startBackground = () => { calls.push("background"); };
  let release;
  const listener = { stop: async () => { calls.push("stop"); await release?.(); }, server: {} };
  const importer = async url => {
    if (/runtime\/configuration\.(?:js|ts)$/.test(url)) return { loadRuntimeConfiguration: (_root, environment, readProfile) => {
      calls.push("configuration"); assert.equal(environment.CRM_DATABASE_MODE, undefined);
      assert.equal(environment.CRM_MYSQL_PASSWORD, nativeSettings.CRM_MYSQL_PASSWORD);
      assert.throws(readProfile, /fallback is unavailable/); return {};
    } };
    if (/runtime\/zoho-configuration\.(?:js|ts)$/.test(url)) return { loadRuntimeZohoConfiguration: environment => {
      calls.push("integration-configuration"); assert.equal(environment.ZOHO_PROFILE, zohoSettings.ZOHO_PROFILE); return { selected: true };
    }, loadRuntimeZohoSyncConfiguration: environment => {
      calls.push("sync-configuration"); assert.equal(environment.ZOHO_SYNC_PRINCIPAL_ID, "1"); return { inbound: true };
    } };
    if (/runtime\/composition\.(?:js|ts)$/.test(url)) return { openCrmRuntime: async (_configuration, integration, dependencies, inbound) => {
      calls.push("create"); assert.equal(dependencies.networkEnabled, Boolean(integration || inbound));
      if (options.openFails) throw Error("private-fixture-value"); return runtime;
    } };
    assert.match(url, /\/server\.(?:js|ts)$/);
    return { startServer: async (configuration, dependencies, close) => {
      calls.push("listen");
      assert.equal(configuration.instanceId, common.CRM_API_INSTANCE_ID);
      assert.equal(dependencies.auth, runtime.auth); assert.equal(dependencies.crmServices, runtime.crmServices);
      assert.equal(dependencies.readiness, runtime.readiness); release = close;
      if (options.listenFails) { await close(); throw new Error("private-fixture-value"); }
      return listener;
    } };
  };
  return { calls, importer, runtime, listener };
}

test("native startup checks readiness before listening and closes its database once on normal shutdown", async () => {
  const fixture = nativeRuntimeFixture();
  const instance = await startApi(projectRoot, validateProfile("api", { ...api, ...nativeSettings }), true, fixture.importer);
  assert.deepEqual(fixture.calls, ["configuration", "create", "ready", "listen"]);
  await instance.stop(); await instance.stop();
  assert.equal(fixture.calls.filter(call => call === "close").length, 1);
});

test("inbound polling is explicit, bounded and isolated from the Next process even with outbound writes disabled", async () => {
  const values = { ...web, ...api, ...nativeSettings, ...zohoSettings, ZOHO_ENABLED: "false",
    ZOHO_SYNC_ENABLED: "true", ZOHO_SYNC_INTERVAL_SECONDS: "300", ZOHO_SYNC_PRINCIPAL_ID: "1" };
  for (const patch of [{ ZOHO_SYNC_ENABLED: "1" }, { ZOHO_SYNC_INTERVAL_SECONDS: "59" }, { ZOHO_SYNC_INTERVAL_SECONDS: "86401" },
    { ZOHO_SYNC_INTERVAL_SECONDS: "60.5" }, { ZOHO_SYNC_PRINCIPAL_ID: "" }, { ZOHO_ORGANIZATION_ID: "" }, { ZOHO_CLIENT_SECRET: "" }]) {
    assert.throws(() => validateApplication({ ...values, ...patch }));
  }
  const selected = validateApplication(values);
  assert.equal(selected.api.zohoEnabled, false); assert.equal(selected.api.zohoSyncEnabled, true);
  for (const key of zohoSyncKeys) assert.equal(selected.web.environment[key], key === "ZOHO_SYNC_ENABLED" ? "false" : "");
  const parsed = await loadZohoSyncConfiguration(projectRoot, selected.api, true, importSource);
  assert.equal(parsed.principalId, "1"); assert.equal(parsed.intervalMs, 300000);
});

test("inbound background work starts only after a successful listener, never during readiness checks", async () => {
  const previous = process.env.ZOHO_NETWORK_DISABLED; delete process.env.ZOHO_NETWORK_DISABLED;
  try {
    const profile = validateProfile("api", { ...api, ...nativeSettings, ...zohoSettings, ZOHO_ENABLED: "false",
      ZOHO_SYNC_ENABLED: "true", ZOHO_SYNC_INTERVAL_SECONDS: "300", ZOHO_SYNC_PRINCIPAL_ID: "1" });
    const checked = nativeRuntimeFixture({ sync: true });
    const runtime = await prepareApiRuntime(projectRoot, profile, true, checked.importer); await runtime.close();
    assert.equal(checked.calls.includes("background"), false); assert.equal(checked.calls.includes("listen"), false);
    const started = nativeRuntimeFixture({ sync: true });
    const instance = await startApi(projectRoot, profile, true, started.importer);
    assert.deepEqual(started.calls, ["configuration", "sync-configuration", "create", "ready", "listen", "background"]);
    await instance.stop();
    const refused = nativeRuntimeFixture({ sync: true, listenFails: true });
    await assert.rejects(startApi(projectRoot, profile, true, refused.importer));
    assert.equal(refused.calls.includes("background"), false);
  } finally { if (previous === undefined) delete process.env.ZOHO_NETWORK_DISABLED; else process.env.ZOHO_NETWORK_DISABLED = previous; }
});

test("native readiness and listener failures close resources without fallback or secret-bearing errors", async () => {
  for (const options of [{ ready: false }, { listenFails: true }, { ready: false, closeFails: true }]) {
    const fixture = nativeRuntimeFixture(options);
    await assert.rejects(startApi(projectRoot, validateProfile("api", { ...api, ...nativeSettings }), true, fixture.importer),
      error => !error.message.includes("private-fixture-value"));
    assert.equal(fixture.calls.filter(call => call === "close").length, 1);
    if (options.ready === false) assert.equal(fixture.calls.includes("listen"), false);
  }
});

test("explicit production integration requires its complete profile and never forwards credentials to Next", async () => {
  const values = { ...web, ...api, ...nativeSettings, ...zohoSettings };
  for (const key of [...zohoCredentialKeys, ...zohoRuntimeKeys]) {
    const incomplete = { ...values }; delete incomplete[key];
    assert.throws(() => validateApplication(incomplete), undefined, key);
  }
  for (const patch of [{ ZOHO_PROFILE: "unknown" }, { ZOHO_AUTOMATION_POLICY: "workflows" }, { ZOHO_ACCOUNT_OWNER_ID: "0" },
    { ZOHO_ORGANIZATION_ID: "123/private" }, { ZOHO_DEAL_PIPELINE: " value " }, { ZOHO_NETWORK_DISABLED: "unknown" }]) {
    assert.throws(() => validateApplication({ ...values, ...patch }));
  }
  const selected = validateApplication(values);
  assert.equal(selected.api.zohoEnabled, true); assert.equal(selected.web.zohoEnabled, true);
  assert.equal(selected.api.environment.ZOHO_CLIENT_SECRET, zohoSettings.ZOHO_CLIENT_SECRET);
  assert.equal(selected.web.environment.ZOHO_ENABLED, "false"); assert.equal(selected.web.environment.ZOHO_NETWORK_DISABLED, "1");
  for (const key of [...zohoCredentialKeys, ...zohoRuntimeKeys]) assert.equal(selected.web.environment[key], "");
  const imports = [];
  const parsed = await loadZohoConfiguration(projectRoot, selected.api, true, async url => { imports.push(url); return importSource(url); });
  assert.equal(parsed.profile, zohoSettings.ZOHO_PROFILE); assert.equal(parsed.credentials.clientId, zohoSettings.ZOHO_CLIENT_ID);
  assert.equal(imports.length, 1); assert.match(imports[0], /runtime\/zoho-configuration\.ts$/);
});

test("selected integration refusal never listens or falls back to local services", async () => {
  const previous = process.env.ZOHO_NETWORK_DISABLED;
  delete process.env.ZOHO_NETWORK_DISABLED;
  try {
    const profile = validateProfile("api", { ...api, ...nativeSettings, ...zohoSettings });
    const failed = nativeRuntimeFixture({ openFails: true });
    await assert.rejects(startApi(projectRoot, profile, true, failed.importer), error => !error.message.includes("private-fixture-value"));
    assert.deepEqual(failed.calls, ["configuration", "integration-configuration", "create"]);
    process.env.ZOHO_NETWORK_DISABLED = "1";
    const blocked = nativeRuntimeFixture();
    await assert.rejects(prepareApiRuntime(projectRoot, profile, true, blocked.importer), /readiness failed/);
    assert.deepEqual(blocked.calls, ["configuration", "integration-configuration"]);
  } finally {
    if (previous === undefined) delete process.env.ZOHO_NETWORK_DISABLED; else process.env.ZOHO_NETWORK_DISABLED = previous;
  }
});

test("disabled composition never imports configuration or native runtime", async () => {
  assert.equal(await prepareApiRuntime(projectRoot, validateProfile("api", api), false, async () => { assert.fail("disabled mode imported native code"); }), undefined);
  let imports = 0;
  await startApi(projectRoot, validateProfile("api", api), false, async url => {
    imports++; assert.match(url, /\/dist\/server\.js$/);
    return { startServer: async (_config, dependencies, close) => { assert.deepEqual(dependencies, {}); assert.equal(close, undefined); return {}; } };
  });
  assert.equal(imports, 1);
});

test("an inherited network veto refuses native activation before construction and is never mutated", async () => {
  const previous = process.env.CRM_MYSQL_NETWORK_DISABLED;
  process.env.CRM_MYSQL_NETWORK_DISABLED = "1";
  try {
    const fixture = nativeRuntimeFixture();
    await assert.rejects(prepareApiRuntime(projectRoot, validateProfile("api", { ...api, ...nativeSettings }), true, fixture.importer), /readiness failed/);
    assert.deepEqual(fixture.calls, ["configuration"]);
    assert.equal(process.env.CRM_MYSQL_NETWORK_DISABLED, "1");
  } finally {
    if (previous === undefined) delete process.env.CRM_MYSQL_NETWORK_DISABLED;
    else process.env.CRM_MYSQL_NETWORK_DISABLED = previous;
  }
});

test("production profiles require every setting and discard unrelated inherited values", () => {
  for (const [kind, environment] of [["web", web], ["api", api]]) {
    const config = validateProfile(kind, { ...environment, PATH: "test-path", UNRELATED_TOKEN: "not-forwarded" });
    assert.equal(config.environment.PATH, "test-path");
    assert.equal(config.environment.UNRELATED_TOKEN, undefined);
    for (const key of Object.keys(environment)) {
      const missing = { ...environment }; delete missing[key];
      assert.throws(() => validateProfile(kind, missing), undefined, `${kind} must require ${key}`);
    }
  }
});
test("database selectors and credentials never fall back to disabled or demo mode", () => {
  for (const key of ["CRM_RUNTIME_ENABLE", "CRM_RUNTIME_PROFILE", "CRM_RUNTIME_SOURCE", "CRM_MYSQL_PASSWORD", "DB_PASSWORD", "DATABASE_URL", "MYSQL_HOST", "NEXT_PUBLIC_API_ORIGIN"]) {
    assert.throws(() => validateProfile("web", { ...web, [key]: "sensitive-fixture-value" }), error => !error.message.includes("sensitive-fixture-value"));
  }
  for (const mode of ["legacy", "native", "sqlite", "demo", "", "DISABLED"]) assert.throws(() => validateProfile("api", { ...api, CRM_DATABASE_MODE: mode }));
  assert.throws(() => validateProfile("api", { ...api, ZOHO_ENABLED: "true" }));
  assert.throws(() => validateProfile("api", { ...api, CRM_MYSQL_NETWORK_DISABLED: "0" }));
});
test("unsafe runtime injection and proxies are refused without echoing their values", () => {
  for (const key of ["NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED", "DEBUG", "HTTP_PROXY", "https_proxy", "ALL_PROXY", "NODE_USE_ENV_PROXY"]) {
    assert.throws(() => validateProfile("web", { ...web, [key]: "private-setting" }), error => error.message.includes(key) && !error.message.includes("private-setting"));
  }
});
test("HTTPS canonical origin, instance and explicit independent loopback ports are validated", () => {
  for (const origin of ["http://hub.voltronix.ae", "https://hub.voltronix.ae/", "https://hub.voltronix.ae:444", "https://127.0.0.1", "https://foo.localhost", "https://user:pass@hub.voltronix.ae"]) {
    assert.throws(() => validateProfile("web", { ...web, APP_ORIGIN: origin }));
  }
  for (const upstream of ["http://127.0.0.1:3301", "http://localhost:3302", "http://192.0.2.1:3302", "http://127.0.0.1:3302/path", "http://127.0.0.1", "https://127.0.0.1:3302"]) {
    assert.throws(() => validateProfile("web", { ...web, CRM_EXPRESS_ORIGIN: upstream }));
  }
  for (const invalid of ["0.0.0.0", "localhost", "192.0.2.1", "::"]) assert.throws(() => validateProfile("api", { ...api, CRM_API_HOST: invalid }));
  for (const invalid of ["0", "80", "65536", "3302x", " 3302", "03302"]) assert.throws(() => validateProfile("api", { ...api, CRM_API_PORT: invalid }));
  for (const invalid of ["", "UPPER", "space value", "a".repeat(65)]) assert.throws(() => validateProfile("api", { ...api, CRM_API_INSTANCE_ID: invalid }));
  assert.equal(validateProfile("web", { ...web, CRM_WEB_HOST: "::1", CRM_EXPRESS_ORIGIN: "http://[::1]:4402" }).apiOrigin, "http://[::1]:4402");
});
test("only one root dotenv file is permitted; nested or override environments fail", () => {
  const root = mkdtempSync(join(tmpdir(), "hub-config-test-"));
  try {
    mkdirSync(join(root, "server"));
    writeFileSync(join(root, ".env.example"), "# template");
    writeFileSync(join(root, ".env"), "# one application configuration");
    assert.doesNotThrow(() => assertNoEnvironmentFiles(root));
    for (const name of [".env", ".env.local", ".env.production", ".ENV.PRODUCTION"]) {
      const path = join(root, "server", name);
      writeFileSync(path, "# deliberately empty");
      assert.throws(() => assertNoEnvironmentFiles(root));
      rmSync(path);
    }
  } finally { rmSync(root, { recursive: true }); }
});
test("one application configuration must bind the exact upstream used by its web process", () => {
  const environment = { ...web, ...api };
  assert.equal(validateApplication(environment).api.port, 3302);
  for (const settings of [{ CRM_API_PORT: "4402" }, { CRM_API_HOST: "::1" }, { CRM_EXPRESS_ORIGIN: "http://127.0.0.1:4402" }]) {
    assert.throws(() => validateApplication({ ...environment, ...settings }), /CRM_EXPRESS_ORIGIN must match/);
  }
  assert.equal(validateApplication({ ...environment, CRM_API_HOST: "::1", CRM_EXPRESS_ORIGIN: "http://[::1]:3302" }).api.host, "::1");
});
test("build rejects incomplete or conflicting application settings before compilation", async () => {
  const root = mkdtempSync(join(tmpdir(), "hub-build-config-test-"));
  try {
    await assert.rejects(main("build", { ...web, ...api, CRM_API_PORT: "80" }, root), /CRM_API_PORT must be/);
    await assert.rejects(main("build", { ...web, ...api, CRM_API_ENVIRONMENT: "development" }, root), /CRM_API_ENVIRONMENT must explicitly/);
    await assert.rejects(main("build", { ...web, ...api, CRM_API_PORT: "4402" }, root), /CRM_EXPRESS_ORIGIN must match/);
  } finally { rmSync(root, { recursive: true }); }
});

test("development requires the same complete safe application configuration before compiling or starting", async () => {
  const root = mkdtempSync(join(tmpdir(), "hub-dev-config-test-"));
  try {
    for (const environment of [{}, { ...web, ...api, CRM_API_PORT: "4402" },
      { ...web, ...api, CRM_DATABASE_MODE: "native" }, { ...web, ...api, ZOHO_ENABLED: "true" },
      { ...web, ...api, CRM_MYSQL_NETWORK_DISABLED: "0" },
      { ...web, ...api, CRM_MYSQL_PASSWORD: "sensitive-fixture-value" }]) {
      await assert.rejects(main("dev", environment, root), error => !error.message.includes("sensitive-fixture-value"));
      assert.deepEqual(readdirSync(root), [], "refusal must not create files or build output");
    }
  } finally { rmSync(root, { recursive: true }); }
});

test("development refuses either occupied listener before source compilation and leaves existing services running", async () => {
  const root = mkdtempSync(join(tmpdir(), "hub-dev-port-test-"));
  const existing = createServer((_request, response) => response.end("existing-service"));
  const reserve = createServer();
  await new Promise(resolve => existing.listen(0, "127.0.0.1", resolve));
  await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const occupied = existing.address().port, free = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  try {
    for (const [apiPort, webPort] of [[occupied, free], [free, occupied]]) {
      await assert.rejects(main("dev", { ...web, ...api, CRM_API_PORT: String(apiPort), CRM_WEB_PORT: String(webPort),
        CRM_EXPRESS_ORIGIN: `http://127.0.0.1:${apiPort}` }, root), /listener .* unavailable/);
      assert.deepEqual(readdirSync(root), []);
      assert.equal(await (await fetch(`http://127.0.0.1:${occupied}`)).text(), "existing-service");
    }
  } finally {
    existing.closeAllConnections(); await new Promise(resolve => existing.close(resolve));
    rmSync(root, { recursive: true });
  }
});
test("missing compiled release output is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "hub-build-test-"));
  try { assert.throws(() => assertBuildOutput(root, "api"), /Missing required build output/); }
  finally { rmSync(root, { recursive: true }); }
});
test("occupied listener produces a useful error and leaves the existing service running", async () => {
  const server = createServer((_request, response) => response.end("existing-service"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    await assert.rejects(assertPortFree("127.0.0.1", port), new RegExp(`127.0.0.1:${port} is unavailable`));
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "existing-service");
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test("identity preflight is credential-free and accepts only the configured service", async () => {
  const profile = validateProfile("web", web);
  await assertApiIdentity(profile, async (url, options) => {
    assert.equal(url, `${web.CRM_EXPRESS_ORIGIN}/api/v1/health/identity`);
    assert.equal(options.method, "GET"); assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error"); assert.equal(options.cache, "no-store");
    assert.deepEqual(options.headers, { accept: "application/json" }); assert.equal(options.body, undefined);
    return Response.json(identity);
  });
  for (const body of [{ ...identity, service: "other" }, { ...identity, instanceId: "other" }, { ...identity, appOrigin: "https://crm.voltronix.ae" }, { ...identity, extra: true }, null]) {
    await assert.rejects(assertApiIdentity(profile, async () => Response.json(body)), /identity check failed/);
  }
});
test("malformed, unavailable and oversized identity responses fail closed", async () => {
  const profile = validateProfile("web", web);
  for (const response of [new Response("unavailable", { status: 503 }), new Response(JSON.stringify(identity)),
    Response.json(identity, { headers: { "set-cookie": "unexpected=value" } }),
    new Response("{", { headers: { "content-type": "application/json" } }),
    new Response(" ".repeat(4097), { headers: { "content-type": "application/json" } })]) {
    await assert.rejects(assertApiIdentity(profile, async () => response), /identity check failed/);
  }
  await assert.rejects(assertApiIdentity(profile, async () => { throw new Error("private upstream detail"); }), error => !error.message.includes("private upstream detail"));
});

test("native split web startup needs a ready API, using a bounded credential-free probe", async () => {
  const profile = validateProfile("web", { ...web, ...nativeSettings });
  await assertApiReadiness(profile, async (url, options) => {
    assert.equal(url, `${web.CRM_EXPRESS_ORIGIN}/api/v1/health/ready`);
    assert.equal(options.method, "GET"); assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error"); assert.equal(options.cache, "no-store");
    assert.deepEqual(options.headers, { accept: "application/json" }); assert.equal(options.body, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ status: "ready" });
  });
  for (const response of [Response.json({ status: "unavailable" }, { status: 503 }), Response.json(identity),
    Response.json({ status: "ready", extra: true }), Response.json({ status: "ready" }, { headers: { "set-cookie": "unexpected=value" } }),
    new Response("{", { headers: { "content-type": "application/json" } }),
    new Response(" ".repeat(4097), { headers: { "content-type": "application/json" } })]) {
    await assert.rejects(assertApiReadiness(profile, async () => response), /database readiness check failed/);
  }
  await assert.rejects(assertApiReadiness(profile, async () => { throw new Error("private-fixture-value"); }),
    error => !error.message.includes("private-fixture-value"));
});

test("native web command refuses a matching but database-disabled API before spawning Next", async () => {
  const root = mkdtempSync(join(tmpdir(), "hub-native-web-test-"));
  const requests = [];
  const upstream = createServer((request, response) => {
    requests.push({ path: request.url, cookie: request.headers.cookie, method: request.method });
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/health/identity") response.end(JSON.stringify(identity));
    else { response.statusCode = 503; response.end(JSON.stringify({ status: "unavailable" })); }
  });
  const reserved = createServer();
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  await new Promise(resolve => reserved.listen(0, "127.0.0.1", resolve));
  const webPort = reserved.address().port, upstreamPort = upstream.address().port;
  await new Promise(resolve => reserved.close(resolve));
  try {
    mkdirSync(join(root, "shared/contracts/dist"), { recursive: true }); mkdirSync(join(root, ".next"));
    writeFileSync(join(root, "shared/contracts/dist/index.js"), "// build fixture"); writeFileSync(join(root, ".next/BUILD_ID"), "fixture");
    const environment = { ...web, ...nativeSettings, CRM_WEB_PORT: String(webPort), CRM_EXPRESS_ORIGIN: `http://127.0.0.1:${upstreamPort}` };
    for (const command of ["web", "check-web"]) {
      requests.length = 0;
      await assert.rejects(main(command, environment, root), /database readiness check failed/);
      assert.deepEqual(requests, [
        { path: "/api/v1/health/identity", cookie: undefined, method: "GET" },
        { path: "/api/v1/health/ready", cookie: undefined, method: "GET" },
      ]);
    }
  } finally {
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    rmSync(root, { recursive: true });
  }
});
