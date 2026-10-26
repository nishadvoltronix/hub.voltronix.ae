// Explicit local development smoke. All configuration is synthetic process input;
// no root .env, database, migration, seeded account or Zoho connection is needed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { assertPortFree, projectRoot } from "./run-hub.mjs";

const osEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|HOME|USERPROFILE)$/i.test(key)));
async function reserve() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { server, port: server.address().port };
}
function launch(environment) {
  const child = spawn(process.execPath, ["--import", "tsx", "tools/run-hub.mjs", "dev"], {
    cwd: projectRoot, env: { ...osEnvironment, ...environment }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", bytes => { output += bytes.toString(); });
  child.stderr.on("data", bytes => { output += bytes.toString(); });
  return { child, ended: once(child, "exit"), get output() { return output; } };
}
async function stop(owned) {
  if (owned.child.exitCode !== null || owned.child.signalCode !== null) return;
  if (process.platform === "win32") {
    const cleanup = spawn("taskkill.exe", ["/PID", String(owned.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    await once(cleanup, "exit");
  } else owned.child.kill("SIGTERM");
  await owned.ended;
}
const get = (origin, path) => fetch(origin + path, { redirect: "manual", signal: AbortSignal.timeout(30_000) });

test("one strict development command starts source API and Next with explicit shared configuration", { timeout: 120_000 }, async t => {
  const api = await reserve(), web = await reserve();
  const apiOrigin = `http://127.0.0.1:${api.port}`, webOrigin = `http://127.0.0.1:${web.port}`;
  const environment = { NODE_ENV: "production", APP_ORIGIN: "https://hub.voltronix.ae", CRM_API_INSTANCE_ID: "hub-crm",
    CRM_DATABASE_MODE: "disabled", CRM_MYSQL_NETWORK_DISABLED: "1", ZOHO_ENABLED: "false", NEXT_TELEMETRY_DISABLED: "1",
    CRM_API_ENVIRONMENT: "production", CRM_API_HOST: "127.0.0.1", CRM_API_PORT: String(api.port),
    CRM_WEB_HOST: "127.0.0.1", CRM_WEB_PORT: String(web.port), CRM_FRONTEND_BACKEND: "express", CRM_EXPRESS_ORIGIN: apiOrigin };
  await new Promise(resolve => api.server.close(resolve)); await new Promise(resolve => web.server.close(resolve));
  const owned = launch(environment);
  try {
    const deadline = Date.now() + 75_000;
    let started = false;
    while (Date.now() < deadline && owned.child.exitCode === null) {
      try { if ((await get(webOrigin, "/api/health/live")).status === 200) { started = true; break; } } catch { /* owned startup */ }
      await delay(100);
    }
    assert.ok(started, owned.output);
    await t.test("source API identity and both listeners match while persistence remains unavailable", async () => {
      const identity = await get(apiOrigin, "/api/v1/health/identity");
      assert.equal(identity.status, 200);
      assert.deepEqual(await identity.json(), { service: "hub-crm-api", instanceId: "hub-crm", appOrigin: environment.APP_ORIGIN });
      assert.equal((await get(apiOrigin, "/api/v1/health/ready")).status, 503);
      const login = await get(webOrigin, "/login");
      assert.equal(login.status, 200); assert.match(await login.text(), /Hub CRM/);
      assert.equal((await get(webOrigin, "/api/auth/me")).status, 503);
    });
    await t.test("another development command refuses occupied ports without changing the running application", async () => {
      const duplicate = launch(environment);
      const [code] = await duplicate.ended;
      assert.equal(code, 1); assert.match(duplicate.output, /listener .* unavailable/);
      assert.equal((await get(webOrigin, "/api/health/live")).status, 200);
      assert.equal((await get(apiOrigin, "/api/v1/health/live")).status, 200);
    });
  } finally { await stop(owned); }
  await t.test("stopping the owned development command releases both explicit listeners", async () => {
    await assertPortFree("127.0.0.1", api.port);
    await assertPortFree("127.0.0.1", web.port);
  });
});
