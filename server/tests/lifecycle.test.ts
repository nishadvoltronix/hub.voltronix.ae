import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer, get } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { createHttpLifecycle, startServer } from "../src/server.js";
import { syntheticChildEnvironment } from "./helpers/child-environment.js";

test("compiled app/server import and composition have no listener or outbound network side effects", () => {
  const script = `
    import net from 'node:net';
    net.Server.prototype.listen = () => { throw new Error('Unexpected listener'); };
    net.Socket.prototype.connect = () => { throw new Error('Unexpected outbound connection'); };
    const {createApp} = await import('./dist/app.js');
    await import('./dist/server.js');
    createApp({environment:'test',host:'127.0.0.1',port:3002,appOrigin:'http://127.0.0.1:3001'});
    console.log('composition-only-pass');
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: syntheticChildEnvironment(), encoding: "utf8", timeout: 5000, windowsHide: true,
  });
  assert.equal(child.status, 0);
  assert.equal(child.stdout.trim(), "composition-only-pass");
  assert.equal(child.stderr, "");
});

for (const [label, overrides] of [
  ["invalid host", { CRM_API_HOST: "synthetic-secret-marker" }],
  ["missing environment", { CRM_API_ENVIRONMENT: "" }],
  ["missing host", { CRM_API_HOST: "" }],
  ["missing port", { CRM_API_PORT: "" }],
  ["missing origin", { APP_ORIGIN: "" }],
] as const) {
  test(`explicit compiled CLI rejects ${label} with exact key-only diagnostics`, () => {
    const child = spawnSync(process.execPath, ["dist/cli.js"], { encoding: "utf8", timeout: 5000, windowsHide: true,
      // Explicit values (including blanks) override server/.env. Do not let
      // local defaults fill a missing setting or select the MySQL runtime.
      env: syntheticChildEnvironment(Object.assign({ CRM_API_ENVIRONMENT: "test", CRM_API_HOST: "127.0.0.1", CRM_API_PORT: "3002",
        APP_ORIGIN: "http://127.0.0.1:3001", CRM_RUNTIME_ENABLE: "", CRM_RUNTIME_PROFILE: "",
      }, overrides)) });
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, "");
    assert.equal(child.stderr.includes("synthetic-secret-marker"), false);
    assert.equal(child.stderr,
      "Local API startup failed. Check CRM_API_ENVIRONMENT, CRM_API_HOST, CRM_API_PORT, APP_ORIGIN and explicit Zoho settings. Process settings override server/.env.\n");
  });
}

test("shutdown drains an active response and repeated stop shares completion", async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const permitted = new Promise<void>(resolve => { release = resolve; });
  const server = createServer(async (_request, response) => { entered(); await permitted; response.end("complete"); });
  const lifecycle = createHttpLifecycle(server);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const response = new Promise<string>((resolve, reject) => {
    get({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, agent: false }, result => {
      let body = "";
      result.on("data", chunk => { body += String(chunk); });
      result.on("end", () => resolve(body));
      result.on("error", reject);
    }).on("error", reject);
  });
  await started;
  const stopped = lifecycle.stop(1000);
  assert.strictEqual(lifecycle.stop(1000), stopped);
  let finished = false; void stopped.then(() => { finished = true; });
  await delay(20); assert.equal(finished, false);
  release();
  assert.equal(await response, "complete");
  await stopped;
  assert.equal(server.listening, false);
});

test("shutdown deadline destroys only this server's unfinished socket", async () => {
  const server = createServer();
  const lifecycle = createHttpLifecycle(server);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const socket = connect({ host: "127.0.0.1", port: (server.address() as AddressInfo).port });
  await once(socket, "connect");
  socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n");
  const closed = once(socket, "close");
  await lifecycle.stop(40);
  await closed;
  assert.equal(socket.destroyed, true);
  assert.equal(server.listening, false);
});

test("explicit listener is loopback-bound with timeouts and sanitized address-in-use failure", async () => {
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = (reservation.address() as AddressInfo).port;
  const config = loadConfig({ CRM_API_ENVIRONMENT: "test", CRM_API_HOST: "127.0.0.1",
    CRM_API_PORT: String(port), APP_ORIGIN: "http://127.0.0.1:3001" });
  let released = 0;
  const release = async () => { released++; };
  try { await assert.rejects(startServer(config, {}, release), { message: "Local API listener unavailable." }); }
  finally { await new Promise<void>(resolve => reservation.close(() => resolve())); }
  assert.equal(released, 1);
  const instance = await startServer(config, {}, release);
  try {
    assert.equal((instance.server.address() as AddressInfo).address, "127.0.0.1");
    assert.equal(instance.server.requestTimeout, 10_000);
    assert.equal(instance.server.headersTimeout, 5_000);
    assert.equal(instance.server.keepAliveTimeout, 1_000);
    assert.equal(instance.server.maxRequestsPerSocket, 100);
  } finally {
    const stopped = instance.stop();
    assert.equal(instance.stop(), stopped);
    await stopped;
  }
  assert.equal(released, 2);
});

test("post-listen errors stop the owned listener without throwing or exposing the error", async () => {
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const instance = await startServer(loadConfig({ CRM_API_ENVIRONMENT: "test", CRM_API_HOST: "127.0.0.1",
    CRM_API_PORT: String(port), APP_ORIGIN: "http://127.0.0.1:3001" }));
  const closed = new Promise<void>(resolve => instance.server.once("close", () => resolve()));
  instance.server.emit("error", new Error("synthetic-secret-marker"));
  await closed;
  assert.equal(instance.failed, true);
  assert.equal(instance.server.listening, false);
});

test("actual listener bounds stalled request headers and rejects oversized headers", { timeout: 12000 }, async () => {
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const instance = await startServer(loadConfig({ CRM_API_ENVIRONMENT: "test", CRM_API_HOST: "127.0.0.1",
    CRM_API_PORT: String(port), APP_ORIGIN: "http://127.0.0.1:3001" }));
  const raw = async (headers: string) => {
    const socket = connect({ host: "127.0.0.1", port });
    try {
      await once(socket, "connect");
      return await new Promise<string>((resolve, reject) => {
        let body = "";
        socket.setTimeout(8500, () => { socket.destroy(); reject(new Error("Header deadline not enforced.")); });
        socket.on("data", chunk => { body += String(chunk); });
        socket.on("error", reject);
        socket.on("close", () => resolve(body));
        socket.write(headers);
      });
    } finally { socket.destroy(); }
  };
  try {
    assert.match(await raw("GET /api/v1/health/live HTTP/1.1\r\nHost: 127.0.0.1\r\n"), /^HTTP\/1.1 408/);
    const oversized = await raw(`GET /api/v1/health/live HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Test: ${"x".repeat(17000)}\r\n\r\n`);
    assert.match(oversized, /^HTTP\/1.1 431/);
    assert.equal(oversized.includes("xxxxxxxx"), false);
  } finally { await instance.stop(); }
});

test("stop before listen is safe and invalid drain limits fail closed", async () => {
  const lifecycle = createHttpLifecycle(createServer());
  for (const deadline of [0, -1, 5001, NaN]) await assert.rejects(lifecycle.stop(deadline), /Invalid shutdown deadline/);
  await lifecycle.stop();
});
