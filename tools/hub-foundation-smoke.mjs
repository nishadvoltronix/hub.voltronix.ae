// Explicit post-build integration check. Uses only owned loopback HTTP listeners.
// Run: node --test tools/hub-foundation-smoke.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { projectRoot, validateProfile } from "./run-hub.mjs";
import { nativeEnvironmentKeys, zohoCredentialKeys } from "./hub-environment.mjs";

const common = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|HOME|USERPROFILE)$/i.test(key))),
  // Explicitly override any native credentials stored in the root .env. This
  // smoke owns only foundation HTTP listeners and must never select a database.
  ...Object.fromEntries([...nativeEnvironmentKeys, ...zohoCredentialKeys].map(key => [key, ""])),
  NODE_ENV: "production", APP_ORIGIN: "https://hub.voltronix.ae", CRM_API_INSTANCE_ID: "hub-crm",
  CRM_DATABASE_MODE: "disabled", CRM_MYSQL_NETWORK_DISABLED: "1", ZOHO_ENABLED: "false", NEXT_TELEMETRY_DISABLED: "1" };
async function reserve() {
  const server = createServer();
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port;
  return { server, port };
}
function launch(command, environment) {
  const child = spawn(process.execPath, ["tools/run-hub.mjs", command], { cwd: projectRoot, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => { output += chunk.toString(); });
  const ended = once(child, "exit");
  return { child, ended, get output() { return output; } };
}
async function stop(processOwner) {
  if (!processOwner || processOwner.child.exitCode !== null || processOwner.child.signalCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(processOwner.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    await once(killer, "exit");
  } else processOwner.child.kill("SIGTERM");
  await Promise.race([processOwner.ended, delay(10_000).then(() => { throw new Error("Owned smoke process failed to stop."); })]);
}
async function response(origin, path, options) {
  return fetch(origin + path, { ...options, redirect: "manual", signal: AbortSignal.timeout(5_000) });
}
async function waitReady(origin, path, processOwner) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    if (processOwner.child.exitCode !== null) throw new Error(`Owned service exited before liveness: ${processOwner.output}`);
    try { if ((await response(origin, path)).status === 200) return; } catch { /* owned service still starting */ }
    await delay(100);
  }
  throw new Error("Owned Hub service did not reach liveness.");
}

test("built HTTPS-configured Hub foundation runs without database or integration dependencies", { timeout: 90_000 }, async t => {
  const reservedApi = await reserve(), reservedWeb = await reserve();
  const apiOrigin = `http://127.0.0.1:${reservedApi.port}`, webOrigin = `http://127.0.0.1:${reservedWeb.port}`;
  const apiEnvironment = { ...common, CRM_API_ENVIRONMENT: "production", CRM_API_HOST: "127.0.0.1", CRM_API_PORT: String(reservedApi.port) };
  const webEnvironment = { ...common, CRM_WEB_HOST: "127.0.0.1", CRM_WEB_PORT: String(reservedWeb.port), CRM_FRONTEND_BACKEND: "express", CRM_EXPRESS_ORIGIN: apiOrigin };
  validateProfile("api", apiEnvironment); validateProfile("web", webEnvironment);
  let api, web, impostor;
  try {
    await new Promise(resolve => reservedApi.server.close(resolve));
    await new Promise(resolve => reservedWeb.server.close(resolve));
    api = launch("api", apiEnvironment);
    await waitReady(apiOrigin, "/api/v1/health/live", api);
    web = launch("web", webEnvironment);
    await waitReady(webOrigin, "/api/health/live", web);

    await t.test("live identity and disabled readiness reflect the actual API composition", async () => {
      const identity = await response(apiOrigin, "/api/v1/health/identity");
      assert.equal(identity.status, 200);
      assert.deepEqual(await identity.json(), { service: "hub-crm-api", instanceId: "hub-crm", appOrigin: common.APP_ORIGIN });
      const ready = await response(apiOrigin, "/api/v1/health/ready");
      assert.equal(ready.status, 503); assert.deepEqual(await ready.json(), { status: "unavailable" });
    });
    await t.test("login and its built/public assets are served without issuing a session", async () => {
      const login = await response(webOrigin, "/login");
      assert.equal(login.status, 200); assert.equal(login.headers.has("set-cookie"), false);
      assert.equal(login.headers.get("x-frame-options"), "DENY");
      const html = await login.text();
      const paths = [...new Set([...html.matchAll(/(?:src|href)="(\/(?:_next|legacy)\/[^"?]+)(?:\?[^\"]*)?"/g)].map(match => match[1]))];
      assert.ok(paths.length >= 3, "built login assets must be discoverable");
      for (const path of paths) assert.equal((await response(webOrigin, path)).status, 200, path);
    });
    await t.test("all representative database-backed route families fail closed", async () => {
      for (const path of ["/api/auth/me", "/api/auth/csrf", "/api/dashboard", "/api/leads/1", "/api/deals", "/api/pipeline",
        "/api/items", "/api/quotations", "/api/jobs", "/api/settings/users", "/api/log-attachments/1"]) {
        const result = await response(webOrigin, path);
        assert.equal(result.status, 503, path); assert.equal(result.headers.has("set-cookie"), false, path);
        assert.doesNotMatch(await result.text(), /password|mysql|sqlite|stack|refresh_token/i);
      }
    });
    await t.test("database-free authentication never creates a development account/session", async () => {
      const result = await response(webOrigin, "/api/auth/login", { method: "POST", headers: {
        origin: common.APP_ORIGIN, "content-type": "application/json",
      }, body: JSON.stringify({ email: "synthetic@example.invalid", password: "synthetic-smoke-only" }) });
      assert.equal(result.status, 503); assert.equal(result.headers.has("set-cookie"), false);
    });
    await t.test("conflicting API startup refuses the occupied port and leaves its owner running", async () => {
      const conflict = launch("api", apiEnvironment);
      const [code] = await conflict.ended;
      assert.equal(code, 1); assert.match(conflict.output, /listener .* unavailable/);
      assert.equal((await response(apiOrigin, "/api/v1/health/live")).status, 200);
    });
    await t.test("an invalid explicit configuration override refuses startup without fallback", async () => {
      // Empty explicitly overrides even a valid root .env value.
      const missing = { ...webEnvironment, CRM_API_INSTANCE_ID: "" };
      const rejected = launch("web", missing);
      const [code] = await rejected.ended;
      assert.equal(code, 1); assert.match(rejected.output, /CRM_API_INSTANCE_ID/);
    });
    await t.test("a replaced API receives only identity probes, never browser cookies or login bodies", async () => {
      await stop(api);
      const requests = [];
      impostor = createServer((request, result) => {
        requests.push({ path: request.url, cookie: request.headers.cookie, method: request.method });
        result.setHeader("content-type", "application/json");
        result.end(JSON.stringify({ service: "another-application", instanceId: "other", appOrigin: "https://other.example.invalid" }));
      });
      impostor.listen(reservedApi.port, "127.0.0.1"); await once(impostor, "listening");
      const result = await response(webOrigin, "/api/auth/login", { method: "POST", headers: {
        origin: common.APP_ORIGIN, "content-type": "application/json", cookie: "__Host-crm_session=" + "a".repeat(43),
      }, body: JSON.stringify({ email: "synthetic@example.invalid", password: "synthetic-smoke-only" }) });
      assert.equal(result.status, 503);
      assert.deepEqual(requests, [{ path: "/api/v1/health/identity", cookie: undefined, method: "GET" }]);
      const rejected = launch("web", { ...webEnvironment, CRM_WEB_PORT: String((await reserveFreePort())) });
      const [code] = await rejected.ended;
      assert.equal(code, 1); assert.match(rejected.output, /API identity check failed/);
    });
  } finally {
    await stop(web); await stop(api);
    if (impostor) { impostor.closeAllConnections(); await new Promise(resolve => impostor.close(resolve)); }
    for (const reservation of [reservedWeb, reservedApi]) if (reservation.server.listening) await new Promise(resolve => reservation.server.close(resolve));
  }
});

async function reserveFreePort() {
  const owned = await reserve();
  await new Promise(resolve => owned.server.close(resolve));
  return owned.port;
}
