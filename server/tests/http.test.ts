import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type RequestOptions, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express from "express";
import { API_IDENTITY_PATH, API_SERVICE_ID, LIVENESS_PATH } from "@voltronix/crm-contracts";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { errorHandler, SafeHttpError } from "../src/http/errors.js";
import { privateResponse } from "../src/http/security.js";
import { createHttpLifecycle } from "../src/server.js";

const config = loadConfig({ CRM_API_ENVIRONMENT: "test", CRM_API_HOST: "127.0.0.1",
  CRM_API_PORT: "3002", APP_ORIGIN: "http://127.0.0.1:3001" });
const app = createApp(config);
const server = createServer(app);
const lifecycle = createHttpLifecycle(server);
before(async () => { server.listen(0, "127.0.0.1"); await once(server, "listening"); });
after(async () => { await lifecycle.stop(); });

async function call(path: string, options: RequestOptions = {}, payload?: string, target: Server = server) {
  const port = (target.address() as AddressInfo).port;
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, agent: false, ...options }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(3000, () => req.destroy(new Error("Owned test request timed out.")));
    req.on("error", reject);
    req.end(payload);
  });
}

test("liveness is process-only JSON with private security headers and no credentials", async () => {
  const result = await call(LIVENESS_PATH);
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { status: "running" });
  assert.match(result.headers["content-type"]!, /^application\/json/);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers.vary, "Cookie");
  assert.equal(result.headers["x-content-type-options"], "nosniff");
  assert.equal(result.headers["x-frame-options"], "DENY");
  assert.equal(result.headers["referrer-policy"], "no-referrer");
  assert.match(String(result.headers["content-security-policy"]), /default-src 'none'/);
  for (const key of ["x-powered-by", "etag", "set-cookie", "access-control-allow-origin", "strict-transport-security"]) {
    assert.equal(result.headers[key], undefined);
  }
});

test("HEAD is explicitly bodyless, other methods have a bounded 405 and no CORS grant", async () => {
  const head = await call(LIVENESS_PATH, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  for (const method of ["POST", "PATCH", "PUT", "DELETE", "OPTIONS"]) {
    const result = await call(LIVENESS_PATH, { method, headers: { "content-type": "application/json" } }, "synthetic-secret-marker");
    assert.equal(result.status, 405);
    assert.equal(result.headers.allow, "GET, HEAD");
    assert.deepEqual(JSON.parse(result.body), { error: "Method not permitted." });
    assert.equal(result.headers["access-control-allow-origin"], undefined);
  }
});

test("unknown, old and private asset routes do not forward or serve files", async () => {
  for (const path of ["/api/health/live", "/api/v1/health/live/",
    "/API/v1/health/live", "/.env.local", "/package.json", "/.local-data/backup.sql",
    "/include/dist/assets/json/file-upload.php", "/include/src/assets/json/file-upload.php"]) {
    const result = await call(path);
    assert.equal(result.status, 404);
    assert.deepEqual(JSON.parse(result.body), { error: "Not found." });
    assert.equal(result.headers["cache-control"], "no-store");
  }
});

test("extracted CRM routes fail closed without an explicitly composed database", async () => {
  const result = await call("/api/v1/jobs");
  assert.equal(result.status, 503);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers["set-cookie"], undefined);
});

test("foundation-only liveness never implies database readiness or changes authentication state", async () => {
  const result = await call("/api/v1/health/ready");
  assert.equal(result.status, 503);
  assert.deepEqual(JSON.parse(result.body), { status: "unavailable" });
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers["set-cookie"], undefined);
  assert.equal((await call(LIVENESS_PATH)).status, 200);
});

test("unconfigured instance identity refuses without a database or authentication side effect", async () => {
  const result = await call(API_IDENTITY_PATH);
  assert.equal(result.status, 503); assert.equal(result.headers["set-cookie"], undefined);
  assert.equal(result.headers["cache-control"], "no-store");
});

test("configured identity is GET-only static configuration, independent of database readiness and request host", async () => {
  let readinessCalls = 0;
  const identityConfig = loadConfig({ CRM_API_ENVIRONMENT: "production", CRM_API_HOST: "127.0.0.1",
    CRM_API_PORT: "3902", CRM_API_INSTANCE_ID: "hub-crm", APP_ORIGIN: "https://hub.example.invalid" });
  const identityServer = createServer(createApp(identityConfig, { readiness: async () => { readinessCalls++; return false; } }));
  const identityLifecycle = createHttpLifecycle(identityServer);
  identityServer.listen(0, "127.0.0.1"); await once(identityServer, "listening");
  try {
    const result = await call(API_IDENTITY_PATH, { headers: { host: "another.example.invalid", "x-forwarded-host": "another.example.invalid" } }, undefined, identityServer);
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), { service: API_SERVICE_ID, instanceId: "hub-crm", appOrigin: identityConfig.appOrigin });
    assert.equal(result.headers["set-cookie"], undefined); assert.equal(result.headers["cache-control"], "no-store");
    for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const denied = await call(API_IDENTITY_PATH, { method }, undefined, identityServer);
      assert.equal(denied.status, 405); assert.equal(denied.headers.allow, "GET");
    }
    assert.equal((await call(API_IDENTITY_PATH + "?secret=synthetic", {}, undefined, identityServer)).status, 400);
    assert.equal((await call(API_IDENTITY_PATH, { headers: { "content-length": "4" } }, "test", identityServer)).status, 400);
    assert.equal(readinessCalls, 0);
    assert.equal((await call("/api/v1/health/ready", {}, undefined, identityServer)).status, 503);
    assert.equal((await call("/api/v1/auth/me", {}, undefined, identityServer)).status, 503);
    assert.equal(readinessCalls, 1);
  } finally { await identityLifecycle.stop(); }
});

test("liveness rejects queries, GET bodies and chunked bodies before body parsing", async () => {
  for (const query of ["?token=synthetic-secret-marker", "?a=1&a=2", "?"]) {
    const result = await call(LIVENESS_PATH + query);
    assert.equal(result.status, 400);
    assert.deepEqual(JSON.parse(result.body), { error: "Invalid request." });
  }
  const body = await call(LIVENESS_PATH, { headers: { "content-length": "4" } }, "test");
  assert.equal(body.status, 400);
  const chunked = await call(LIVENESS_PATH, { headers: { "transfer-encoding": "chunked" } }, "test");
  assert.equal(chunked.status, 400);
});

test("origin and fetch metadata fail closed, forwarded headers cannot grant access", async () => {
  assert.equal((await call(LIVENESS_PATH, { headers: { origin: config.appOrigin, "sec-fetch-site": "same-origin" } })).status, 200);
  for (const headers of [
    { origin: "http://unapproved.invalid", "x-forwarded-host": "127.0.0.1", "x-forwarded-proto": "https" },
    { origin: "null" }, { origin: config.appOrigin, "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
  ]) {
    assert.equal((await call(LIVENESS_PATH, { headers })).status, 403);
  }
  assert.equal(app.get("trust proxy"), false);
  assert.equal(app.get("query parser"), false);
});

test("Express async failures and spoofed error objects never expose arbitrary details", async () => {
  const faultApp = express();
  faultApp.use(privateResponse);
  faultApp.get("/throw", async () => { throw new Error("synthetic-secret-marker SQL credential"); });
  faultApp.get("/spoof", (_req, _res, next) => next({ status: 401, message: "synthetic-secret-marker" }));
  faultApp.get("/mutated", (_req, _res, next) => {
    const error = new SafeHttpError("forbidden");
    error.message = "synthetic-secret-marker";
    next(error);
  });
  faultApp.use(errorHandler);
  const faultServer = createServer(faultApp);
  const faultLifecycle = createHttpLifecycle(faultServer);
  faultServer.listen(0, "127.0.0.1"); await once(faultServer, "listening");
  try {
    for (const path of ["/throw", "/spoof"]) {
      const result = await call(path, {}, undefined, faultServer);
      assert.equal(result.status, 500);
      assert.deepEqual(JSON.parse(result.body), { error: "Request failed." });
      assert.equal(result.headers["cache-control"], "no-store");
    }
    const result = await call("/mutated", {}, undefined, faultServer);
    assert.equal(result.status, 403);
    assert.deepEqual(JSON.parse(result.body), { error: "Request not permitted." });
  } finally { await faultLifecycle.stop(); }
});
