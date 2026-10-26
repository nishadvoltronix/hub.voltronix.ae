/// <reference lib="dom" />
// Playwright's test-tool declarations use DOM types; scripts are excluded from
// the backend build, whose runtime remains Node-only.
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { createApp } from "../../src/app.js";
import { requirePermissions } from "../../src/auth/http.js";
import type { AuthService } from "../../src/auth/service.js";
import { validateMysqlAuthConfig, type MysqlAuthConfig } from "../../src/db/mysql/config.js";
import { createHttpLifecycle } from "../../src/server.js";

/** Test tooling only. No main/CLI, profile loading, listener, browser or connection
 * at import time. The guarded owner must prove approval, fresh schema, grants and
 * fixture ownership before calling this function with its tracked composition.
 */
export interface SyntheticIdentity { email: string; password: string }
export interface HttpBrowserOptions {
  runtimeConfig: MysqlAuthConfig;
  identities: { allowed: SyntheticIdentity; denied: SyntheticIdentity };
  record: (name: string, kind: "http" | "chromium") => void;
  browser: boolean;
  /** Required owner-tracked real adapter factory: no untracked/default store. */
  createAuthentication: () => { auth: AuthService; close: () => Promise<void> };
}
export interface OwnedHttpTarget { readonly origin: string; close: () => Promise<void> }
export interface HttpBrowserEffects {
  open: (options: HttpBrowserOptions) => Promise<OwnedHttpTarget>;
  http: (target: OwnedHttpTarget, options: HttpBrowserOptions) => Promise<number>;
  chromium: (target: OwnedHttpTarget, options: HttpBrowserOptions) => Promise<number>;
}
export class HttpBrowserHarnessError extends Error {
  constructor() { super("Isolated authentication HTTP/browser verification refused or failed; private diagnostics were suppressed."); }
}

/** Node/Playwright debug tracing can print HTTP credentials even when the
 * harness never logs them. Fail before listener/adapter/browser construction.
 */
export function assertNoHarnessDebug(environment: Readonly<Record<string, string | undefined>>, execArguments: readonly string[]): void {
  if (["NODE_DEBUG", "NODE_DEBUG_NATIVE", "DEBUG", "PWDEBUG", "NODE_OPTIONS"].some(name => Boolean(environment[name]))
    || execArguments.some(value => /^--inspect(?:[=-]|$)/.test(value))) throw new HttpBrowserHarnessError();
}

function check(condition: unknown): asserts condition { if (!condition) throw new HttpBrowserHarnessError(); }
function ownedOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === value && url.protocol === "http:" && url.hostname === "127.0.0.1"
      && /^\d{4,5}$/.test(url.port) && Number(url.port) >= 1024 && Number(url.port) <= 65535;
  } catch { return false; }
}
function validateOptions(input: HttpBrowserOptions): HttpBrowserOptions {
  const configuration = validateMysqlAuthConfig(input.runtimeConfig);
  check(configuration.environment === "test");
  const suffix = configuration.database.replace(/^crm_local_auth_/, "");
  check(configuration.user === `auth_r_${suffix.slice(0, 24)}`);
  check(typeof input.record === "function" && typeof input.createAuthentication === "function" && typeof input.browser === "boolean");
  const identities = Object.fromEntries((["allowed", "denied"] as const).map(key => {
    const identity = input.identities[key];
    check(typeof identity?.email === "string" && /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.invalid$/.test(identity.email)
      && identity.email.length <= 254 && typeof identity.password === "string" && identity.password.length >= 1
      && identity.password.length <= 1024 && !identity.password.includes("\0"));
    return [key, Object.freeze({ email: identity.email, password: identity.password })];
  })) as HttpBrowserOptions["identities"];
  check(identities.allowed.email.toLowerCase() !== identities.denied.email.toLowerCase());
  return Object.freeze({ ...input, runtimeConfig: configuration, identities: Object.freeze(identities) });
}

/** Effect injection exists solely for offline harness-contract tests. Fake tests
 * do not start HTTP/Chromium or substitute a runtime authentication store.
 */
export function createHttpBrowserRunner(effects: HttpBrowserEffects) {
  return async (input: HttpBrowserOptions): Promise<number> => {
    let target: OwnedHttpTarget | undefined;
    let result: number | undefined;
    let failed = false;
    try {
      const options = validateOptions(input);
      target = await effects.open(options);
      check(ownedOrigin(target.origin));
      let checks = await effects.http(target, options);
      check(Number.isSafeInteger(checks) && checks > 0);
      if (options.browser) {
        const browserChecks = await effects.chromium(target, options);
        check(Number.isSafeInteger(browserChecks) && browserChecks > 0);
        checks += browserChecks;
      }
      result = checks;
    } catch { failed = true; }
    if (target) { try { await target.close(); } catch { failed = true; } }
    if (failed || result === undefined) throw new HttpBrowserHarnessError();
    return result;
  };
}

const probe = "/__auth-harness/permission";
const pagePath = "/__auth-harness/login";
const scriptPath = "/__auth-harness/client.js";
/** Pure browser-network allowlist. Never follows arbitrary app URLs or accepts
 * an origin merely because it looks local; only this owned listener and paths.
 */
export function isOwnedBrowserRequest(origin: string, requestUrl: string): boolean {
  if (!ownedOrigin(origin)) return false;
  try {
    const url = new URL(requestUrl);
    return url.origin === origin && !url.username && !url.password && !url.search && !url.hash
      && [probe, pagePath, scriptPath, "/api/v1/auth/csrf", "/api/v1/auth/login", "/api/v1/auth/me", "/api/v1/auth/logout"].includes(url.pathname);
  } catch { return false; }
}
const pageHtml = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Isolated authentication test</title></head><body>'
  + '<form id="login"><label>Email<input id="email" type="email" autocomplete="off"></label><label>Password<input id="password" type="password" autocomplete="off"></label><button type="submit">Sign in</button></form>'
  + '<button id="logout" type="button">Sign out</button><output id="status" data-testid="status">ready</output><script src="' + scriptPath + '"></script></body></html>';
// Synthetic values stay only in the DOM/request memory; there is no console,
// trace, screenshot, persisted storage state or server-side request logging.
const pageScript = `"use strict";
const status = document.getElementById("status");
async function csrf() { const r = await fetch("/api/v1/auth/csrf", {cache:"no-store"}); if(r.status!==200) throw Error(); return (await r.json()).csrfToken; }
document.getElementById("login").addEventListener("submit", async event => {
 event.preventDefault(); status.textContent="pending";
 try { const token=await csrf(); const r=await fetch("/api/v1/auth/login", {method:"POST",headers:{"content-type":"application/json","x-csrf-token":token},body:JSON.stringify({email:document.getElementById("email").value,password:document.getElementById("password").value})});
 document.getElementById("password").value=""; if(r.status!==200) throw Error();
 const me=await fetch("/api/v1/auth/me", {cache:"no-store"}); if(me.status!==200) throw Error();
 const permission=await fetch("${probe}", {cache:"no-store"}); status.textContent=permission.status===200?"allowed":permission.status===403?"denied":"failed";
 } catch { status.textContent="failed"; }
});
document.getElementById("logout").addEventListener("click", async () => {
 status.textContent="pending";
 try { const token=await csrf(); const r=await fetch("/api/v1/auth/logout", {method:"POST",headers:{"x-csrf-token":token}});
 const me=await fetch("/api/v1/auth/me", {cache:"no-store"}); status.textContent=r.status===200&&me.status===401?"signed-out":"failed";
 } catch { status.textContent="failed"; }
});`;

async function openOwnedTarget(options: HttpBrowserOptions): Promise<OwnedHttpTarget> {
  const authentication = options.createAuthentication();
  let handler: ReturnType<typeof express> | undefined;
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 10000, headersTimeout: 5000, keepAliveTimeout: 1000 },
    (incoming, response) => {
      if (!handler) { response.writeHead(503, { "Cache-Control": "no-store" }); response.end(); return; }
      handler(incoming, response);
    });
  const lifecycle = createHttpLifecycle(server);
  let closed: Promise<void> | undefined;
  const close = () => closed ??= (async () => {
    try { await lifecycle.stop(); } finally { await authentication.close(); }
  })();
  // Consume listener errors without raw output. Subsequent requests fail safely.
  server.on("error", () => { handler = undefined; });
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = () => reject(new HttpBrowserHarnessError());
      server.once("error", failed);
      server.listen(0, "127.0.0.1", () => { server.off("error", failed); resolve(); });
    });
    const port = (server.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    check(ownedOrigin(origin));
    const app = express();
    app.disable("x-powered-by"); app.disable("etag"); app.set("trust proxy", false);
    app.use((incoming, response, next) => {
      if (incoming.headers.host !== `127.0.0.1:${port}`) { response.status(400).end(); return; }
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
      next();
    });
    app.get(pagePath, (_request, response) => { response.type("html").send(pageHtml); });
    app.get(scriptPath, (_request, response) => { response.type("application/javascript").send(pageScript); });
    app.get(probe, requirePermissions(authentication.auth, ["dashboard.view"], origin), (_request, response) => { response.json({ permitted: true }); });
    app.use(createApp({ environment: "test", host: "127.0.0.1", port, appOrigin: origin }, { auth: authentication.auth }));
    handler = app;
    return { origin, close };
  } catch {
    await close();
    throw new HttpBrowserHarnessError();
  }
}

interface Reply { status: number; headers: IncomingHttpHeaders; json: Record<string, unknown> }
async function call(target: OwnedHttpTarget, path: string, method = "GET", cookie?: string, csrf?: string, body?: unknown): Promise<Reply> {
  check(ownedOrigin(target.origin) && path.startsWith("/") && !path.startsWith("//"));
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = request({ hostname: "127.0.0.1", port: Number(new URL(target.origin).port), path, method, agent: false,
      headers: { ...(cookie ? { cookie } : {}), ...(method === "POST" ? { origin: target.origin } : {}),
        ...(csrf ? { "x-csrf-token": csrf } : {}), ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) } }, incoming => {
      const chunks: Buffer[] = []; let length = 0;
      incoming.on("data", (chunk: Buffer) => { length += chunk.length; if (length > 32768) incoming.destroy(new HttpBrowserHarnessError()); else chunks.push(chunk); });
      incoming.on("error", () => reject(new HttpBrowserHarnessError()));
      incoming.on("end", () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          check(json && typeof json === "object" && !Array.isArray(json));
          resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, json });
        } catch { reject(new HttpBrowserHarnessError()); }
      });
    });
    outgoing.setTimeout(15000, () => outgoing.destroy(new HttpBrowserHarnessError()));
    outgoing.on("error", () => reject(new HttpBrowserHarnessError())); outgoing.end(payload);
  });
}
function cookieJar(reply: Reply): string { return (reply.headers["set-cookie"] ?? []).map(value => value.split(";")[0]).join("; "); }
function csrfToken(reply: Reply): string { check(typeof reply.json.csrfToken === "string" && /^[a-zA-Z0-9_-]{43}$/.test(reply.json.csrfToken)); return reply.json.csrfToken; }
function privateReply(reply: Reply, status: number): void {
  check(reply.status === status && reply.headers["cache-control"] === "no-store");
}
async function httpChecks(target: OwnedHttpTarget, options: HttpBrowserOptions): Promise<number> {
  let count = 0;
  const record = (name: string) => { options.record(name, "http"); count++; };
  privateReply(await call(target, "/api/v1/auth/me"), 401);
  privateReply(await call(target, probe), 401); record("anonymous-access-denied");
  for (const key of ["allowed", "denied"] as const) {
    const challenge = await call(target, "/api/v1/auth/csrf"); privateReply(challenge, 200);
    const signedIn = await call(target, "/api/v1/auth/login", "POST", cookieJar(challenge), csrfToken(challenge), options.identities[key]);
    privateReply(signedIn, 200);
    check((signedIn.headers["set-cookie"] ?? []).length === 2);
    for (const cookie of signedIn.headers["set-cookie"] ?? []) check(/; HttpOnly(?:;|$)/i.test(cookie) && /; SameSite=Lax(?:;|$)/i.test(cookie) && /; Path=\/(?:;|$)/i.test(cookie) && !/; Domain=/i.test(cookie));
    const jar = cookieJar(signedIn);
    privateReply(await call(target, "/api/v1/auth/me", "GET", jar), 200);
    privateReply(await call(target, probe, "GET", jar), key === "allowed" ? 200 : 403);
    record(`${key}-login-session-permission`);
    privateReply(await call(target, "/api/v1/auth/logout", "POST", jar), 403);
    privateReply(await call(target, "/api/v1/auth/logout", "POST", jar, csrfToken(signedIn)), 200);
    privateReply(await call(target, "/api/v1/auth/me", "GET", jar), 401); record(`${key}-csrf-logout-replay`);
  }
  const challenge = await call(target, "/api/v1/auth/csrf"); privateReply(challenge, 200);
  privateReply(await call(target, "/api/v1/auth/login", "POST", cookieJar(challenge), csrfToken(challenge),
    { email: options.identities.allowed.email, password: options.identities.allowed.password === "deliberately-wrong" ? "different-wrong-value" : "deliberately-wrong" }), 401);
  record("invalid-password-denied"); return count;
}

async function chromiumChecks(target: OwnedHttpTarget, options: HttpBrowserOptions): Promise<number> {
  check(ownedOrigin(target.origin));
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, args: ["--disable-background-networking", "--disable-component-update", "--disable-domain-reliability", "--disable-sync", "--no-first-run", "--safebrowsing-disable-auto-update", "--disable-default-apps", "--metrics-recording-only", "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication"] });
  let count = 0;
  try {
    for (const key of ["allowed", "denied"] as const) {
      const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
      try {
        context.setDefaultTimeout(15000);
        await context.route("**/*", route => {
          if (isOwnedBrowserRequest(target.origin, route.request().url())) return route.continue();
          return route.abort("blockedbyclient");
        });
        await context.routeWebSocket("**/*", socket => socket.close());
        const page = await context.newPage();
        await page.goto(`${target.origin}${pagePath}`, { waitUntil: "domcontentloaded" });
        await page.getByLabel("Email", { exact: true }).fill(options.identities[key].email);
        await page.getByLabel("Password", { exact: true }).fill(options.identities[key].password);
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        await page.locator(`#status:has-text("${key}")`).waitFor();
        check(await page.getByTestId("status").textContent() === key);
        options.record(`${key}-browser-login-permission`, "chromium"); count++;
        await page.getByRole("button", { name: "Sign out", exact: true }).click();
        await page.locator('#status:has-text("signed-out")').waitFor();
        check(await page.getByTestId("status").textContent() === "signed-out");
        options.record(`${key}-browser-logout`, "chromium"); count++;
      } finally { await context.close(); }
    }
    return count;
  } finally { await browser.close(); }
}

/** Caller must be the approved guarded owner. This export has no CLI bypass. */
export async function runHttpBrowser(options: HttpBrowserOptions): Promise<number> {
  assertNoHarnessDebug(process.env, process.execArgv);
  return createHttpBrowserRunner({ open: openOwnedTarget, http: httpChecks, chromium: chromiumChecks })(options);
}
