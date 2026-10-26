import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type IncomingHttpHeaders, type RequestOptions, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { createMysqlAuthStore } from "../src/auth/mysql-store.js";
import { createAuthService } from "../src/auth/service.js";
import { newToken } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config.js";
import { createMysqlAuthDatabase } from "../src/db/mysql/database.js";
import { createHttpLifecycle } from "../src/server.js";

// The Express listener is owned ephemeral loopback. The MySQL connector is an
// injected rejection: no MySQL connection, profile, schema, user or record exists.
const origin = "http://127.0.0.1:3001";
const apiConfig = loadConfig({ CRM_API_ENVIRONMENT: "test", CRM_API_HOST: "127.0.0.1", CRM_API_PORT: "3002", APP_ORIGIN: origin });
const privateMarker = "synthetic-private-connection-detail";
interface Reply { status: number; headers: IncomingHttpHeaders; body: string }
async function call(server: Server, path: string, options: RequestOptions = {}, payload?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port: (server.address() as AddressInfo).port,
      path: `/api/v1/auth/${path}`, agent: false, ...options }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("error", reject);
      incoming.on("end", () => resolve({ status: incoming.statusCode!, headers: incoming.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.setTimeout(3000, () => outgoing.destroy(new Error("Owned offline outage request timed out.")));
    outgoing.on("error", reject);
    outgoing.end(payload);
  });
}
async function withOutage(work: (server: Server, attempts: () => number) => Promise<void>) {
  let attempts = 0;
  const database = createMysqlAuthDatabase({ provider: "mysql", environment: "test", host: "127.0.0.1", port: 3308,
    database: "crm_local_auth_00000000000040008000000000000000", user: "synthetic_auth_fixture", password: privateMarker }, {
    connect: async () => { attempts++; throw new Error(privateMarker); },
  });
  const auth = createAuthService(createMysqlAuthStore(database));
  const server = createServer(createApp(apiConfig, { auth })), lifecycle = createHttpLifecycle(server);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try { await work(server, () => attempts); }
  finally { await lifecycle.stop(); await database.close(); }
}
function failure(reply: Reply, status = 503) {
  assert.equal(reply.status, status);
  assert.deepEqual(JSON.parse(reply.body), { error: status === 503 ? "The service is temporarily unavailable." : "Authentication required." });
  assert.equal(reply.headers["set-cookie"], undefined);
  assert.equal(reply.headers["cache-control"], "no-store");
  assert.equal(reply.headers.vary, "Cookie");
  assert.equal(JSON.stringify(reply).includes(privateMarker), false);
  assert.equal(reply.body.includes("mysql"), false);
}

test("offline MySQL connector outage allows anonymous challenge but login fails closed without cookies or retry", async () => {
  await withOutage(async (server, attempts) => {
    const challenge = await call(server, "csrf", { headers: { origin } });
    assert.equal(challenge.status, 200);
    assert.equal(attempts(), 0);
    const { csrfToken } = JSON.parse(challenge.body) as { csrfToken: string };
    assert.match(csrfToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(challenge.headers["set-cookie"]?.length, 1);
    assert.match(challenge.headers["set-cookie"]![0]!, /^crm_csrf=/);
    const login = await call(server, "login", { method: "POST", headers: {
      origin, cookie: `crm_csrf=${csrfToken}`, "x-csrf-token": csrfToken, "content-type": "application/json",
    } }, JSON.stringify({ email: "outage@example.invalid", password: "Synthetic unused login password" }));
    failure(login);
    assert.equal(attempts(), 1);
    assert.equal(login.body.includes(csrfToken), false);
  });
});

test("offline MySQL connector outage cannot authenticate valid-shaped sessions or silently use a fallback", async () => {
  await withOutage(async (server, attempts) => {
    failure(await call(server, "me", { headers: { cookie: "crm_session=malformed" } }), 401);
    assert.equal(attempts(), 0);
    const session = newToken();
    const me = await call(server, "me", { headers: { cookie: `crm_session=${session}` } });
    failure(me);
    assert.equal(attempts(), 1);
    assert.equal(me.body.includes(session), false);
    const refresh = await call(server, "csrf", { headers: { origin, cookie: `crm_session=${session}` } });
    failure(refresh);
    assert.equal(attempts(), 2);
  });
});

test("offline MySQL connector outage does not claim logout or clear cookies when revocation cannot be verified", async () => {
  await withOutage(async (server, attempts) => {
    const session = newToken(), csrf = newToken();
    const logout = await call(server, "logout", { method: "POST", headers: {
      origin, cookie: `crm_session=${session}; crm_csrf=${csrf}`, "x-csrf-token": csrf,
    } });
    failure(logout);
    assert.equal(attempts(), 1);
    assert.equal(logout.body.includes(session), false);
    assert.equal(logout.body.includes(csrf), false);
    assert.equal(logout.body.includes("signedOut"), false);
  });
});
