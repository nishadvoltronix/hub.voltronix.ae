import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type IncomingHttpHeaders, type RequestOptions, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { authCookiePolicy, createAuthRouter, requireAuthenticated, requirePermissions, requireSessionMutation } from "../src/auth/http.js";
import { AuthError } from "../src/auth/errors.js";
import { SESSION_LIFETIME_MS, type AuthService } from "../src/auth/service.js";
import { digest, newToken } from "../src/auth/tokens.js";
import { createHttpLifecycle } from "../src/server.js";
import { createFixture } from "./helpers/auth-store.js";

// Every request below targets an owned loopback ephemeral server and an explicitly
// injected transient fixture. None exercises MySQL, a browser, TLS or a real user.
const origin = "http://127.0.0.1:3001";
const prefix = "/api/v1/auth";
const config = loadConfig({ CRM_API_ENVIRONMENT: "test", CRM_API_HOST: "127.0.0.1", CRM_API_PORT: "3002", APP_ORIGIN: origin });
type Fixture = ReturnType<typeof createFixture>;
interface Reply { status: number; headers: IncomingHttpHeaders; body: string }
async function withServer(app: ReturnType<typeof express>, work: (server: Server) => Promise<void>) {
  const server = createServer(app), lifecycle = createHttpLifecycle(server);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try { await work(server); } finally { await lifecycle.stop(); }
}
async function call(server: Server, path: string, options: RequestOptions = {}, payload?: string | Buffer | readonly Buffer[]): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as AddressInfo).port;
    const outgoing = request({ host: "127.0.0.1", port, path, agent: false, ...options }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("error", reject);
      incoming.on("end", () => resolve({ status: incoming.statusCode!, headers: incoming.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.setTimeout(3000, () => outgoing.destroy(new Error("Owned auth test request timed out.")));
    outgoing.on("error", reject);
    if (Array.isArray(payload)) { for (const chunk of payload) outgoing.write(chunk); outgoing.end(); }
    else outgoing.end(payload);
  });
}
function json(reply: Reply): Record<string, unknown> { return JSON.parse(reply.body) as Record<string, unknown>; }
function token(reply: Reply): string { const value = json(reply).csrfToken; assert.equal(typeof value, "string"); return value as string; }
function cookies(reply: Reply): string { return (reply.headers["set-cookie"] ?? []).map(value => value.split(";")[0]).join("; "); }
function sessionValue(cookie: string): string {
  const found = cookie.split("; ").find(pair => pair.startsWith("crm_session="));
  assert.ok(found); return found.slice("crm_session=".length);
}
function postHeaders(csrf: string, cookie = `crm_csrf=${csrf}`) {
  return { origin, cookie, "x-csrf-token": csrf, "content-type": "application/json" };
}
async function signIn(server: Server, fixture: Fixture, previous?: string) {
  const challenge = await call(server, `${prefix}/csrf`, previous ? { headers: { cookie: previous } } : {});
  assert.equal(challenge.status, 200);
  const csrf = token(challenge);
  const cookie = previous ? `${previous.split("; ").find(pair => pair.startsWith("crm_session="))}; crm_csrf=${csrf}` : cookies(challenge);
  const reply = await call(server, `${prefix}/login`, { method: "POST", headers: postHeaders(csrf, cookie) },
    JSON.stringify({ email: fixture.user.email, password: fixture.password }));
  assert.equal(reply.status, 200);
  return { reply, cookie: cookies(reply), csrf: token(reply) };
}
function assertFailure(reply: Reply, status: number, message: string): void {
  assert.equal(reply.status, status);
  assert.deepEqual(json(reply), { error: message });
  assert.equal(reply.headers["cache-control"], "no-store");
  assert.equal(reply.headers.vary, "Cookie");
  assert.equal(reply.headers["set-cookie"], undefined);
  assert.equal(reply.headers["access-control-allow-origin"], undefined);
}

test("default application exposes no usable auth store: all four routes fail closed with503", async () => {
  await withServer(createApp(config), async server => {
    for (const [name, method] of [["csrf", "GET"], ["login", "POST"], ["logout", "POST"], ["me", "GET"]]) {
      assertFailure(await call(server, `${prefix}/${name}`, { method }), 503, "The service is temporarily unavailable.");
    }
  });
});

test("injected HTTP lifecycle returns only public identity, rotates prior login and revokes logout", async () => {
  const fixture = createFixture();
  await withServer(createApp(config, { auth: fixture.service }), async server => {
    const first = await signIn(server, fixture);
    assert.deepEqual(json(first.reply).user, { localUserId: fixture.user.localUserId, externalUserId: fixture.user.externalUserId,
      username: fixture.user.username, email: fixture.user.email, permissions: ["leads.view"] });
    assert.deepEqual(Object.keys(json(first.reply)).sort(), ["csrfToken", "user"]);
    assert.ok(!first.reply.body.includes(fixture.user.passwordHash));
    assert.ok(!first.reply.body.includes(sessionValue(first.cookie)));
    for (const value of first.reply.headers["set-cookie"] ?? []) {
      assert.match(value, /; Max-Age=7200;/); assert.match(value, /; Path=\//);
      assert.match(value, /; HttpOnly/); assert.match(value, /; SameSite=Lax/);
      assert.doesNotMatch(value, /; (?:Domain|Secure)/);
    }
    const second = await signIn(server, fixture, first.cookie);
    assert.notEqual(sessionValue(second.cookie), sessionValue(first.cookie));
    assertFailure(await call(server, `${prefix}/me`, { headers: { cookie: first.cookie } }), 401, "Authentication required.");
    assert.equal((await call(server, `${prefix}/me`, { headers: { cookie: second.cookie } })).status, 200);
    const logout = await call(server, `${prefix}/logout?ignored=1`, { method: "POST", headers: postHeaders(second.csrf, second.cookie) }, "ignored non-JSON body");
    assert.equal(logout.status, 200); assert.deepEqual(json(logout), { signedOut: true });
    assert.equal(logout.headers["set-cookie"]?.length, 2);
    for (const value of logout.headers["set-cookie"] ?? []) assert.match(value, /=; Max-Age=0;/);
    assert.equal(fixture.snapshot().sessions.size, 0);
    assertFailure(await call(server, `${prefix}/me`, { headers: { cookie: second.cookie } }), 401, "Authentication required.");
  });
});

test("auth methods are explicit: csrf HEAD cannot rotate binding, me HEAD is bodyless, OPTIONS grants no CORS", async () => {
  const fixture = createFixture();
  await withServer(createApp(config, { auth: fixture.service }), async server => {
    const session = await signIn(server, fixture), before = fixture.snapshot();
    const head = await call(server, `${prefix}/csrf`, { method: "HEAD", headers: { cookie: session.cookie } });
    assert.equal(head.status, 405); assert.equal(head.headers.allow, "GET"); assert.equal(head.body, "");
    assert.equal(head.headers["set-cookie"], undefined); assert.deepEqual(fixture.snapshot(), before);
    const me = await call(server, `${prefix}/me`, { method: "HEAD", headers: { cookie: session.cookie } });
    assert.equal(me.status, 200); assert.equal(me.body, "");
    for (const [name, allow] of [["csrf", "GET"], ["login", "POST"], ["logout", "POST"], ["me", "GET, HEAD"]]) {
      for (const method of ["OPTIONS", "PATCH"]) {
        const result = await call(server, `${prefix}/${name}`, { method });
        assertFailure(result, 405, "Method not permitted."); assert.equal(result.headers.allow, allow);
      }
    }
    for (const path of [`${prefix}/login/`, "/API/v1/auth/login", "/api/auth/login"]) {
      assert.equal((await call(server, path, { method: "POST" })).status, 404);
    }
  });
});

test("source origin rules reject cross-site mutations and reads while preserving me read asymmetry", async () => {
  const fixture = createFixture(), csrf = newToken();
  await withServer(createApp(config, { auth: fixture.service }), async server => {
    for (const headers of [
      { ...postHeaders(csrf), origin: "http://unapproved.invalid", "x-forwarded-host": "127.0.0.1", "x-forwarded-proto": "https" },
      { ...postHeaders(csrf), origin: "null" }, { ...postHeaders(csrf), "sec-fetch-site": "cross-site" },
      { cookie: `crm_csrf=${csrf}`, "x-csrf-token": csrf, "content-type": "application/json" },
    ]) assertFailure(await call(server, `${prefix}/login`, { method: "POST", headers }, "{}"), 403, "Request not permitted.");
    assert.equal(fixture.store.calls.length, 0);
    for (const headers of [{ origin: "null" }, { "sec-fetch-site": "same-site" }, { "sec-fetch-site": "cross-site" }]) {
      assertFailure(await call(server, `${prefix}/csrf`, { headers }), 403, "Request not permitted.");
    }
    assert.equal((await call(server, `${prefix}/csrf?ignored=1`, { headers: { "sec-fetch-site": "none" } })).status, 200);
    const session = await signIn(server, fixture);
    assert.equal((await call(server, `${prefix}/me?ignored=1`, { headers: { cookie: session.cookie, origin: "http://unapproved.invalid", "sec-fetch-site": "cross-site" } })).status, 200);
    assert.equal((await call(server, `${prefix}/logout`, { method: "POST", headers: { ...postHeaders(session.csrf, session.cookie), "sec-fetch-site": "same-site" } })).status, 200);
  });
});

test("double-submit CSRF rejects missing, mismatched, malformed and duplicate headers before credential checks", async () => {
  const fixture = createFixture(), csrf = newToken();
  await withServer(createApp(config, { auth: fixture.service }), async server => {
    for (const headers of [
      { origin, "content-type": "application/json" },
      { ...postHeaders(csrf), "x-csrf-token": newToken() },
      { ...postHeaders(csrf), cookie: "crm_csrf=invalid" },
      { ...postHeaders(csrf), "x-csrf-token": [csrf, csrf] },
    ]) assertFailure(await call(server, `${prefix}/login`, { method: "POST", headers }, "{}"), 403, "Request not permitted.");
    assert.equal(fixture.store.calls.length, 0);
  });
});

test("login distinguishes strict request-shape validation400 from invalid credentials401", async () => {
  const fixture = createFixture(), csrf = newToken();
  await withServer(createApp(config, { auth: fixture.service }), async server => {
    for (const body of [null, [], {}, { email: 3, password: fixture.password },
      { email: fixture.user.email, password: fixture.password, role: "admin" },
      { email: "e".repeat(255), password: "p" }, { email: fixture.user.email, password: "p".repeat(1025) }]) {
      assertFailure(await call(server, `${prefix}/login`, { method: "POST", headers: postHeaders(csrf) }, JSON.stringify(body)), 400, "Invalid request.");
    }
    assert.equal(fixture.store.calls.length, 0);
    for (const body of [{ email: "invalid", password: "p" }, { email: fixture.user.email, password: "" },
      { email: fixture.user.email, password: "with\0nul" }, { email: fixture.user.email, password: "wrong" }]) {
      assertFailure(await call(server, `${prefix}/login`, { method: "POST", headers: postHeaders(csrf) }, JSON.stringify(body)), 401, "Invalid email or password.");
    }
    assert.equal(fixture.snapshot().sessions.size, 0);
    const reply = await call(server, `${prefix}/login?ignored=yes`, { method: "POST", headers: postHeaders(csrf) },
      JSON.stringify({ email: fixture.user.email.toUpperCase(), password: fixture.password }));
    assert.equal(reply.status, 200);
  });
});

test("JSON reader enforces media type, fatal UTF8 and both declared and streamed byte limits", async () => {
  const fixture = createFixture(), csrf = newToken();
  await withServer(createApp(config, { auth: fixture.service }), async server => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "application/json-patch+json"]) {
      assertFailure(await call(server, `${prefix}/login`, { method: "POST", headers: { ...postHeaders(csrf), "content-type": type } }, "{}"), 415, "Use an application/json request.");
    }
    for (const encoding of ["gzip", "deflate", "br", "gzip, identity"]) {
      assertFailure(await call(server, `${prefix}/login`, { method: "POST", headers: { ...postHeaders(csrf), "content-encoding": encoding } }, "{}"), 415, "Use an application/json request.");
    }
    for (const body of [Buffer.alloc(0), Buffer.from("{"), Buffer.from([0xff]), Buffer.concat([Buffer.from('{"email":"'), Buffer.from([0xc3, 0x28]), Buffer.from('","password":"p"}')])]) {
      assertFailure(await call(server, `${prefix}/login`, { method: "POST", headers: postHeaders(csrf) }, body), 400, "Invalid request.");
    }
    const declared = Buffer.alloc(8193, 32);
    const declaredResult = await call(server, `${prefix}/login`, { method: "POST", headers: { ...postHeaders(csrf), "content-length": declared.length } }, declared);
    assertFailure(declaredResult, 413, "Request is too large."); assert.equal(declaredResult.headers.connection, "close");
    const streamed = await call(server, `${prefix}/login`, { method: "POST", headers: { ...postHeaders(csrf), "transfer-encoding": "chunked" } }, [Buffer.alloc(4096, 32), Buffer.alloc(4097, 32)]);
    assertFailure(streamed, 413, "Request is too large."); assert.equal(streamed.headers.connection, "close");
    assert.equal(fixture.store.calls.length, 0);
    const payload = JSON.stringify({ email: fixture.user.email, password: fixture.password });
    const boundary = payload + " ".repeat(8192 - Buffer.byteLength(payload));
    assert.equal(Buffer.byteLength(boundary), 8192);
    assert.equal((await call(server, `${prefix}/login`, { method: "POST", headers: { ...postHeaders(csrf), "content-type": "Application/JSON; charset=utf-8", "content-encoding": "identity" } }, boundary)).status, 200);
  });
});

test("ambiguous/malformed selected cookies fail400, decoded valid cookies work and other cookies have no authority", async () => {
  const fixture = createFixture();
  await withServer(createApp(config, { auth: fixture.service }), async server => {
    const session = await signIn(server, fixture), raw = sessionValue(session.cookie);
    for (const cookie of [`crm_session=${raw}; crm_session=${raw}`, `crm_session=${raw}; crm_session=${newToken()}`,
      "crm_session=%GG", "crm_session", `crm_session=${raw}; crm_csrf=%`, `crm_session=${raw}; crm_csrf=a; crm_csrf=a`]) {
      assertFailure(await call(server, `${prefix}/me`, { headers: { cookie } }), 400, "Invalid request.");
    }
    for (const cookie of ["crm_session=short", `crm_session="${raw}"`]) {
      assertFailure(await call(server, `${prefix}/me`, { headers: { cookie } }), 401, "Authentication required.");
    }
    const encoded = `%${raw.charCodeAt(0).toString(16)}${raw.slice(1)}`;
    assert.equal((await call(server, `${prefix}/me`, { headers: { cookie: `unrelated=%GG; crm_session=${encoded}` } })).status, 200);
    assert.equal((await call(server, `${prefix}/me`, { headers: { cookie: session.cookie, "x-forwarded-proto": "https" } })).status, 200);
  });
});

test("GET challenge rotates stored CSRF; stale bindings cannot log out an active session", async () => {
  const fixture = createFixture();
  await withServer(createApp(config, { auth: fixture.service }), async server => {
    const session = await signIn(server, fixture), challenge = await call(server, `${prefix}/csrf`, { headers: { cookie: session.cookie } });
    assert.equal(challenge.status, 200); assert.notEqual(token(challenge), session.csrf);
    assertFailure(await call(server, `${prefix}/logout`, { method: "POST", headers: postHeaders(session.csrf, session.cookie) }), 403, "Request not permitted.");
    assert.equal(fixture.snapshot().sessions.size, 1);
    const csrf = token(challenge), currentCookie = `crm_session=${sessionValue(session.cookie)}; crm_csrf=${csrf}`;
    assert.equal((await call(server, `${prefix}/logout`, { method: "POST", headers: postHeaders(csrf, currentCookie) })).status, 200);
    assert.equal(fixture.snapshot().sessions.size, 0);
  });
});

test("expired and disabled sessions can clear cookies while protected reads reject them", async () => {
  for (const mode of ["expired", "disabled"]) {
    const fixture = createFixture();
    await withServer(createApp(config, { auth: fixture.service }), async server => {
      const session = await signIn(server, fixture);
      if (mode === "expired") fixture.advance(SESSION_LIFETIME_MS);
      else await fixture.patchUser({ status: "disabled" });
      const unbound = newToken();
      const result = await call(server, `${prefix}/logout`, { method: "POST", headers: postHeaders(unbound, `crm_session=${sessionValue(session.cookie)}; crm_csrf=${unbound}`) });
      assert.equal(result.status, 200); assert.equal(fixture.snapshot().sessions.size, 0);
      assertFailure(await call(server, `${prefix}/me`, { headers: { cookie: session.cookie } }), 401, "Authentication required.");
    });
  }
});

test("fifth allowed account attempt is followed by sanitized429 with retry header and no cookie", async () => {
  const fixture = createFixture(), csrf = newToken();
  await withServer(createApp(config, { auth: fixture.service }), async server => {
    const body = JSON.stringify({ email: fixture.user.email, password: "incorrect" });
    for (let attempt = 0; attempt < 5; attempt++) {
      assertFailure(await call(server, `${prefix}/login`, { method: "POST", headers: postHeaders(csrf) }, body), 401, "Invalid email or password.");
    }
    const reply = await call(server, `${prefix}/login`, { method: "POST", headers: postHeaders(csrf) }, body);
    assertFailure(reply, 429, "Unable to sign in. Try again later."); assert.equal(reply.headers["retry-after"], "900");
  });
});

test("store failure rolls back prior-session replacement and returns503 without private details", async () => {
  const fixture = createFixture();
  await withServer(createApp(config, { auth: fixture.service }), async server => {
    const session = await signIn(server, fixture), before = fixture.snapshot().sessions;
    fixture.failNext("deleteSession");
    const result = await call(server, `${prefix}/login`, { method: "POST", headers: postHeaders(session.csrf, session.cookie) },
      JSON.stringify({ email: fixture.user.email, password: fixture.password }));
    assertFailure(result, 503, "The service is temporarily unavailable.");
    assert.deepEqual(fixture.snapshot().sessions, before);
    assert.ok(!result.body.includes("synthetic-private-store-failure"));
    assert.equal((await call(server, `${prefix}/me`, { headers: { cookie: session.cookie } })).status, 200);
    fixture.failNext("updateSessionCsrf");
    assertFailure(await call(server, `${prefix}/csrf`, { headers: { cookie: session.cookie } }), 503, "The service is temporarily unavailable.");
    assert.deepEqual(fixture.snapshot().sessions, before);
  });
});

test("permission middleware checks fresh grants on each request, with no cached user or role bypass", async () => {
  const fixture = createFixture(), app = express();
  app.use(createAuthRouter(origin, fixture.service));
  app.get("/protected", requireAuthenticated(fixture.service, origin), (_req, res) => res.json({ allowed: true }));
  app.get("/restricted", requirePermissions(fixture.service, ["leads.view", "items.view"], origin), (_req, res) => res.json({ allowed: true }));
  app.get("/unconfigured", requirePermissions(fixture.service, [], origin), (_req, res) => res.json({ allowed: true }));
  await withServer(app, async server => {
    assertFailure(await call(server, "/protected"), 401, "Authentication required.");
    const session = await signIn(server, fixture);
    assert.equal((await call(server, "/protected", { headers: { cookie: session.cookie } })).status, 200);
    assertFailure(await call(server, "/restricted", { headers: { cookie: session.cookie } }), 403, "Access denied.");
    await fixture.setGrants(["leads.view", "items.view"]);
    assert.equal((await call(server, "/restricted", { headers: { cookie: session.cookie } })).status, 200);
    await fixture.setGrants(["items.view"]);
    assertFailure(await call(server, "/restricted", { headers: { cookie: session.cookie } }), 403, "Access denied.");
    assertFailure(await call(server, "/unconfigured", { headers: { cookie: session.cookie } }), 503, "The service is temporarily unavailable.");
    await fixture.patchUser({ passwordHash: "changed-synthetic-password-hash" });
    assertFailure(await call(server, "/protected", { headers: { cookie: session.cookie } }), 401, "Authentication required.");
  });
});

test("protected mutation helper requires live identity, exact origin and session-bound CSRF", async () => {
  const fixture = createFixture(), app = express(); let mutations = 0;
  app.use(createAuthRouter(origin, fixture.service));
  app.post("/mutation", requireSessionMutation(fixture.service, origin), (_req, res) => { mutations++; res.json({ allowed: true }); });
  await withServer(app, async server => {
    const csrf = newToken();
    assertFailure(await call(server, "/mutation", { method: "POST", headers: postHeaders(csrf) }), 401, "Authentication required.");
    const session = await signIn(server, fixture);
    assertFailure(await call(server, "/mutation", { method: "POST", headers: { ...postHeaders(session.csrf, session.cookie), origin: "null" } }), 403, "Request not permitted.");
    const unbound = newToken();
    assertFailure(await call(server, "/mutation", { method: "POST", headers: postHeaders(unbound, `crm_session=${sessionValue(session.cookie)}; crm_csrf=${unbound}`) }), 403, "Request not permitted.");
    assert.equal(mutations, 0);
    assert.equal((await call(server, "/mutation", { method: "POST", headers: postHeaders(session.csrf, session.cookie) })).status, 200);
    assert.equal(mutations, 1);
  });
});

test("HTTPS cookie policy is deterministic server configuration; this is serialization evidence only", async () => {
  const httpsOrigin = "https://fixture.example.invalid", policy = authCookiePolicy(httpsOrigin);
  assert.equal(policy.sessionCookie, "__Host-crm_session"); assert.equal(policy.csrfCookie, "__Host-crm_csrf");
  assert.deepEqual(policy.options, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_LIFETIME_MS });
  for (const invalid of ["https://fixture.example.invalid/", "https://user:secret@fixture.example.invalid", "http://fixture.example.invalid", "file:///test", "invalid"]) {
    assert.throws(() => authCookiePolicy(invalid), AuthError);
  }
  const fixture = createFixture(), app = express();
  app.use(createAuthRouter(httpsOrigin, fixture.service));
  await withServer(app, async server => {
    const challenge = await call(server, `${prefix}/csrf`, { headers: { origin: httpsOrigin, "x-forwarded-proto": "http" } });
    assert.equal(challenge.status, 200);
    const value = challenge.headers["set-cookie"]?.[0]; assert.ok(value);
    assert.match(value, /^__Host-crm_csrf=/); assert.match(value, /; Secure/); assert.match(value, /; HttpOnly/);
    assert.doesNotMatch(value, /; Domain=/);
    assert.equal(fixture.snapshot().sessions.size, 0);
  });
});

test("an aborted partial JSON stream leaves no auth mutation or unhandled late error", async () => {
  const fixture = createFixture(), app = express(), csrf = newToken();
  let received!: () => void, closed!: () => void;
  const firstChunk = new Promise<void>(resolve => { received = resolve; });
  const requestClosed = new Promise<void>(resolve => { closed = resolve; });
  app.use((incoming, _outgoing, next) => {
    if (incoming.path === `${prefix}/login`) {
      incoming.once("data", received);
      incoming.once("close", closed);
    }
    next();
  });
  app.use(createAuthRouter(origin, fixture.service));
  await withServer(app, async server => {
    const outgoing = request({ host: "127.0.0.1", port: (server.address() as AddressInfo).port,
      path: `${prefix}/login`, method: "POST", headers: { ...postHeaders(csrf), "content-length": 100 }, agent: false });
    outgoing.on("error", () => {});
    outgoing.setTimeout(3000, () => outgoing.destroy());
    outgoing.write('{"email":');
    await firstChunk;
    outgoing.destroy();
    await requestClosed;
    assert.equal(fixture.store.calls.length, 0);
    assert.equal(fixture.snapshot().sessions.size, 0);
    assert.equal((await call(server, `${prefix}/csrf`)).status, 200);
  });
});

test("unknown and mutated auth errors never trust arbitrary status/message fields", async () => {
  for (const error of [new Error("synthetic-private-error"), { status: 418, message: "synthetic-private-error" },
    Object.assign(new AuthError("denied"), { status: 418, message: "synthetic-private-error" })]) {
    const fixture = createFixture();
    const service: AuthService = { ...fixture.service, authenticate: async () => { throw error; } };
    await withServer(createApp(config, { auth: service }), async server => {
      const result = await call(server, `${prefix}/me`, { headers: { cookie: `crm_session=${newToken()}` } });
      assertFailure(result, error instanceof AuthError ? 403 : 503, error instanceof AuthError ? "Access denied." : "The service is temporarily unavailable.");
    });
  }
});

test("anonymous logout needs CSRF but creates no session and clears selected cookies", async () => {
  const fixture = createFixture(), csrf = newToken();
  await withServer(createApp(config, { auth: fixture.service }), async server => {
    assertFailure(await call(server, `${prefix}/logout`, { method: "POST", headers: { origin } }), 403, "Request not permitted.");
    const reply = await call(server, `${prefix}/logout`, { method: "POST", headers: postHeaders(csrf) });
    assert.equal(reply.status, 200); assert.equal(reply.headers["set-cookie"]?.length, 2);
    assert.equal(fixture.snapshot().sessions.size, 0); assert.equal(fixture.store.calls.length, 0);
    assert.equal(fixture.snapshot().sessions.has(digest(csrf)), false);
  });
});
