import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { API_IDENTITY_PATH, API_SERVICE_ID } from "@voltronix/crm-contracts";
import { frontendBackend } from "../src/server/config/frontend-backend";
import { forwardToExpress, readExpress } from "../src/server/express-bridge";

const environment = { CRM_FRONTEND_BACKEND: "express", CRM_EXPRESS_ORIGIN: "http://127.0.0.1:3902",
  APP_ORIGIN: "https://hub.example.invalid", CRM_API_INSTANCE_ID: "hub-crm", NODE_ENV: "production" };
const identity = { service: API_SERVICE_ID, instanceId: environment.CRM_API_INSTANCE_ID, appOrigin: environment.APP_ORIGIN };
const cookie = "__Host-crm_session=" + "a".repeat(43);

function browserRequest(method = "POST") {
  return new Request(environment.APP_ORIGIN + "/api/auth/login", { method, headers: {
    cookie, origin: environment.APP_ORIGIN, "content-type": "application/json", authorization: "synthetic-browser-value",
    "x-csrf-token": "synthetic-csrf", "x-forwarded-host": "unapproved.example.invalid",
  }, ...(method === "GET" || method === "HEAD" ? {} : { body: '{"password":"synthetic-test-only"}' }) });
}

function assertPreflight(url: RequestInfo | URL, init?: RequestInit) {
  assert.equal(url, environment.CRM_EXPRESS_ORIGIN + API_IDENTITY_PATH);
  assert.equal(init?.method, "GET"); assert.equal(init?.body, undefined);
  assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store"); assert.equal(init?.credentials, "omit");
  assert.deepEqual([...new Headers(init?.headers)], [["accept", "application/json"]]);
  assert.ok(init?.signal);
}

test("OFFLINE HTTPS requires explicit instance identity and supports only canonical loopback upstreams", () => {
  for (const instanceId of [undefined, "", "HUB", "x y", "x".repeat(65), "x\nsecret-marker"]) {
    assert.throws(() => frontendBackend({ ...environment, CRM_API_INSTANCE_ID: instanceId }), /Invalid frontend backend configuration/);
  }
  const ipv6 = frontendBackend({ ...environment, CRM_EXPRESS_ORIGIN: "http://[::1]:3902" });
  assert.equal(ipv6.mode, "express");
  for (const origin of ["http://[::]:3902", "http://[0:0:0:0:0:0:0:1]:3902", "http://localhost:3902", "http://127.0.0.2:3902"]) {
    assert.throws(() => frontendBackend({ ...environment, CRM_EXPRESS_ORIGIN: origin }));
  }
  assert.throws(() => frontendBackend({ CRM_API_INSTANCE_ID: "hub-crm" }));
});

test("OFFLINE identity mismatch prevents login bodies and all cookie-bearing methods reaching another service", async () => {
  const wrong = [null, [], {}, { status: "running" }, { ...identity, service: "other-api" },
    { ...identity, instanceId: "another-crm" }, { ...identity, appOrigin: "https://another.example.invalid" },
    { ...identity, extra: "unreviewed" }, { ...identity, appOrigin: identity.appOrigin + "/" }];
  for (const method of ["GET", "HEAD", "POST", "PATCH", "DELETE"]) for (const body of wrong) {
    let calls = 0; const request = browserRequest(method);
    const response = await forwardToExpress(request, environment, async (url, init) => {
      calls++; assertPreflight(url, init); return Response.json(body);
    });
    assert.equal(response.status, 503); assert.equal(calls, 1); assert.equal(request.bodyUsed, false);
    assert.equal(response.headers.has("set-cookie"), false);
    assert.deepEqual(await response.json(), { error: "The service is temporarily unavailable." });
  }
});

test("OFFLINE unavailable, malformed, oversized and redirecting identity responses fail closed", async () => {
  const responses = [
    () => Response.json(identity, { status: 503 }), () => new Response("not json", { headers: { "content-type": "application/json" } }),
    () => new Response(JSON.stringify(identity), { headers: { "content-type": "text/html" } }),
    () => new Response("x".repeat(4097), { headers: { "content-type": "application/json" } }),
    () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:3903" } }),
    () => Response.json(identity, { headers: { "set-cookie": "unexpected=value" } }),
    () => { throw new Error("synthetic-private-detail"); },
  ];
  for (const createResponse of responses) {
    let calls = 0;
    const response = await forwardToExpress(browserRequest(), environment, async (url, init) => {
      calls++; assertPreflight(url, init); return createResponse();
    });
    assert.equal(calls, 1); assert.equal(response.status, 503);
    assert.equal((await response.text()).includes("synthetic-private-detail"), false);
  }
});

test("OFFLINE matching identity precedes each authenticated request without caching or changing browser CSRF", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push(String(url));
    if (calls.length % 2 === 1) { assertPreflight(url, init); return Response.json(identity); }
    assert.equal(url, environment.CRM_EXPRESS_ORIGIN + "/api/v1/auth/login");
    assert.equal(init?.method, "POST");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("cookie"), cookie); assert.equal(headers.get("origin"), environment.APP_ORIGIN);
    assert.equal(headers.get("x-csrf-token"), "synthetic-csrf"); assert.equal(headers.has("authorization"), false);
    assert.equal(await new Response(init?.body).text(), '{"password":"synthetic-test-only"}');
    return Response.json({ error: "Request not permitted." }, { status: 403 });
  };
  for (let i = 0; i < 2; i++) assert.equal((await forwardToExpress(browserRequest(), environment, fetcher)).status, 403);
  assert.equal(calls.length, 4);
});

test("OFFLINE SSR and explicit local identity use the same gate without forwarding their cookies on failure", async () => {
  let calls = 0;
  await assert.rejects(readExpress("/api/jobs", cookie, environment, async (url, init) => {
    calls++; assertPreflight(url, init); return Response.json({ ...identity, instanceId: "other" });
  }), error => error instanceof Error && "status" in error && error.status === 503);
  assert.equal(calls, 1);
  const response = await forwardToExpress(browserRequest(), { ...environment, APP_ORIGIN: "http://127.0.0.1:3901" },
    async (url, init) => { assertPreflight(url, init); return Response.json(identity); });
  assert.equal(response.status, 503);
});

test("LOOPBACK identity timeout covers stalled response bodies before any protected request", async () => {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    calls.push(request.url!);
    assert.equal(request.headers.cookie, undefined); assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.origin, undefined); assert.equal(request.headers["x-csrf-token"], undefined);
    response.writeHead(200, { "content-type": "application/json" }); response.write('{"service":');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const started = performance.now();
    const response = await forwardToExpress(browserRequest(), { ...environment,
      CRM_EXPRESS_ORIGIN: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    assert.equal(response.status, 503); assert.deepEqual(calls, [API_IDENTITY_PATH]);
    assert.ok(performance.now() - started < 6000);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
