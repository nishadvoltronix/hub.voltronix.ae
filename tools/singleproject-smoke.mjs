// Explicit post-build integration: copy .env.example to a new root .env first.
// Only owned loopback ports/processes are used; no database is configured.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { assertPortFree, projectRoot } from "./run-hub.mjs";

const osEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|HOME|USERPROFILE)$/i.test(key)));
async function reserve() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { server, port: server.address().port };
}
function launch(command, overrides) {
  const child = spawn(process.execPath, ["tools/run-hub.mjs", command], { cwd: projectRoot,
    env: { ...osEnvironment, ...overrides }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
const get = (origin, path) => fetch(origin + path, { redirect: "manual", signal: AbortSignal.timeout(3_000) });

test("one command starts the built application from one root .env", { timeout: 60_000 }, async t => {
  assert.ok(existsSync(join(projectRoot, ".env")), "Create a new root .env from its safe template before this explicit smoke check.");
  const api = await reserve(), web = await reserve();
  const apiOrigin = `http://127.0.0.1:${api.port}`, webOrigin = `http://127.0.0.1:${web.port}`;
  // All required non-port settings MUST come from .env; inherited CRM settings
  // are removed. Ephemeral ports keep the smoke independent of other services.
  const overrides = { CRM_API_HOST: "127.0.0.1", CRM_API_PORT: String(api.port), CRM_WEB_HOST: "127.0.0.1",
    CRM_WEB_PORT: String(web.port), CRM_EXPRESS_ORIGIN: apiOrigin };
  await new Promise(resolve => api.server.close(resolve)); await new Promise(resolve => web.server.close(resolve));
  const owned = launch("start", overrides);
  try {
    const deadline = Date.now() + 35_000;
    let started = false;
    while (Date.now() < deadline && owned.child.exitCode === null) {
      try { if ((await get(webOrigin, "/api/health/live")).status === 200) { started = true; break; } } catch { /* startup */ }
      await delay(100);
    }
    assert.ok(started, owned.output);
    await t.test("both application listeners work and database readiness remains disabled", async () => {
      assert.equal((await get(apiOrigin, "/api/v1/health/live")).status, 200);
      const identity = await get(apiOrigin, "/api/v1/health/identity");
      assert.equal(identity.status, 200); assert.equal((await identity.json()).service, "hub-crm-api");
      assert.equal((await get(apiOrigin, "/api/v1/health/ready")).status, 503);
      assert.equal((await get(webOrigin, "/login")).status, 200);
      assert.equal((await get(webOrigin, "/api/auth/me")).status, 503);
    });
    await t.test("a second start refuses the occupied port without stopping the first application", async () => {
      const duplicate = launch("start", overrides);
      const [code] = await duplicate.ended;
      assert.equal(code, 1); assert.match(duplicate.output, /listener .* unavailable/);
      assert.equal((await get(webOrigin, "/api/health/live")).status, 200);
      assert.equal((await get(apiOrigin, "/api/v1/health/live")).status, 200);
    });
    await t.test("conflicting API origin is rejected before starting either process", async () => {
      const invalid = launch("start", { ...overrides, CRM_EXPRESS_ORIGIN: `http://127.0.0.1:${api.port === 4402 ? 4403 : 4402}` });
      const [code] = await invalid.ended;
      assert.equal(code, 1); assert.match(invalid.output, /CRM_EXPRESS_ORIGIN must match/);
    });
  } finally { await stop(owned); }
  await t.test("stopping the owned application releases both listeners", async () => {
    await assertPortFree("127.0.0.1", api.port);
    await assertPortFree("127.0.0.1", web.port);
  });
});
