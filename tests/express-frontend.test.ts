import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { frontendBackend, requireNextDatabase } from "../src/server/config/frontend-backend";
import { expressUrl, forwardToExpress, isAuthUser, readExpress } from "../src/server/express-bridge";
import { hasDashboardAccess } from "../src/server/presentation-permissions";
import { hasDashboardAccess as legacyDashboardAccess } from "../src/server/dashboard/service";
import { LARGE_LOG_ATTACHMENT_LIMIT, TASK_ATTACHMENT_LIMIT } from "@voltronix/crm-contracts";

const environment = { CRM_FRONTEND_BACKEND: "express", CRM_EXPRESS_ORIGIN: "http://127.0.0.1:3101", APP_ORIGIN: "http://127.0.0.1:3001" };
const token = "a".repeat(43), otherToken = "b".repeat(43);
function request(path: string, init?: RequestInit) { return new Request(environment.APP_ORIGIN + path, init); }
function files(root: string): string[] { return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]); }

test("OFFLINE Express frontend is explicit opt-in and invalid configuration cannot choose old database", () => {
  assert.deepEqual(frontendBackend({}), { mode: "nextjs" });
  assert.doesNotThrow(() => requireNextDatabase({}));
  assert.equal(frontendBackend(environment).mode, "express");
  assert.throws(() => requireNextDatabase(environment), /Direct frontend database access is disabled/);
  for (const config of [{ CRM_FRONTEND_BACKEND: "wrong" }, { CRM_FRONTEND_BACKEND: "express" },
    { CRM_EXPRESS_ORIGIN: environment.CRM_EXPRESS_ORIGIN }, { ...environment, CRM_EXPRESS_ORIGIN: undefined }]) {
    assert.throws(() => frontendBackend(config), /Invalid frontend backend configuration/);
    assert.throws(() => requireNextDatabase(config));
  }
});

test("OFFLINE upstream rejects external, credentialed, redirected, low-port and self-loop configuration", () => {
  for (const origin of ["http://localhost:3101", "https://127.0.0.1:3101", "http://example.invalid:3101",
    "http://127.0.0.1:80", "http://127.0.0.1:3101/", "http://synthetic:synthetic@127.0.0.1:3101",
    "http://127.0.0.1:3101?x=1", environment.APP_ORIGIN]) {
    assert.throws(() => frontendBackend({ ...environment, CRM_EXPRESS_ORIGIN: origin }));
  }
  for (const appOrigin of ["https://127.0.0.1", "https://localhost", "https://crm.localhost", "https://crm.example.invalid:8443", "https://crm.example.invalid/",
    "https://crm.example.invalid:443", "https://CRM.example.invalid", "https://crm.example.invalid.", "https://crm.example.invalid?x=1",
    "https://crm.example.invalid#fragment", "https://synthetic:synthetic@crm.example.invalid", "https://bad_label.example.invalid"]) {
    assert.throws(() => frontendBackend({ ...environment, APP_ORIGIN: appOrigin }));
  }
});

test("OFFLINE every existing API method/path maps to the versioned origin without activating old handlers", () => {
  const target = frontendBackend(environment); assert.equal(target.mode, "express");
  if (target.mode !== "express") assert.fail();
  let methods = 0;
  for (const file of files(resolve("src/app/api")).filter(file => file.endsWith("route.ts"))) {
    const path = file.replaceAll("\\", "/").split("/src/app")[1]!.replace("/route.ts", "").replace(/\[[^\]]+\]/g, "1");
    for (const method of readFileSync(file, "utf8").matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) {
      assert.ok(method[1]);
      assert.equal(expressUrl(target, path), environment.CRM_EXPRESS_ORIGIN + path.replace(/^\/api\//, "/api/v1/"));
      methods++;
    }
  }
  assert.equal(methods, 70);
  assert.equal(expressUrl(target, "/api/capabilities"), environment.CRM_EXPRESS_ORIGIN + "/api/v1/capabilities");
  assert.equal(expressUrl(target, "/api/deals?query=fixture&page=2"), environment.CRM_EXPRESS_ORIGIN + "/api/v1/deals?query=fixture&page=2");
  assert.equal(expressUrl(target, "/api/v1/auth/me"), environment.CRM_EXPRESS_ORIGIN + "/api/v1/auth/me");
});

test("OFFLINE upstream path rejects host overrides, PHP, encoded separators and traversal", () => {
  const target = frontendBackend(environment); if (target.mode !== "express") assert.fail();
  for (const path of ["https://example.invalid/api/auth/me", "//example.invalid/api/auth/me", "/api/../private", "/api/a/%2f", "/api/a.php", "/api/a\\b", "/private", "/api/a#fragment"]) {
    assert.throws(() => expressUrl(target, path));
  }
  assert.equal(expressUrl(target, "/api/jobs?page=2&search=A%20B"), environment.CRM_EXPRESS_ORIGIN + "/api/v1/jobs?page=2&search=A%20B");
});

test("OFFLINE bridge preserves CSRF/origin, filters unrelated cookies and untrusted proxy headers", async () => {
  let calls = 0;
  const response = await forwardToExpress(request("/api/auth/login", { method: "POST", headers: {
    "content-type": "application/json", origin: environment.APP_ORIGIN, "x-csrf-token": token, "sec-fetch-site": "same-origin",
    cookie: `unrelated=private-marker; crm_csrf=${token}`, "x-forwarded-host": "example.invalid", authorization: "synthetic-marker",
  }, body: JSON.stringify({ email: "synthetic@example.invalid", password: "synthetic-test-only" }) }), environment, async (input, init) => {
    calls++; assert.equal(input, environment.CRM_EXPRESS_ORIGIN + "/api/v1/auth/login");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("origin"), environment.APP_ORIGIN); assert.equal(headers.get("x-csrf-token"), token);
    assert.equal(headers.get("cookie"), `crm_csrf=${token}`); assert.equal(headers.has("authorization"), false);
    assert.equal(headers.has("x-forwarded-host"), false); assert.equal(init?.redirect, "manual"); assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal); assert.ok(init?.body instanceof ReadableStream);
    await new Response(init?.body).arrayBuffer();
    const result = Response.json({ csrfToken: otherToken });
    result.headers.append("set-cookie", `crm_session=${token}; Max-Age=7200; Path=/; Expires=Sat, 10 Oct 2026 12:00:00 GMT; HttpOnly; SameSite=Lax`);
    result.headers.append("set-cookie", `crm_csrf=${otherToken}; Max-Age=7200; Path=/; HttpOnly; SameSite=Lax`);
    return result;
  });
  assert.equal(calls, 1); assert.equal(response.status, 200); assert.equal(response.headers.getSetCookie().length, 2);
  assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(response.headers.get("vary"), "Cookie");
});

test("OFFLINE bridge preserves duplicate selected cookies for backend rejection", async () => {
  const response = await forwardToExpress(request("/api/auth/me", { headers: { cookie: `crm_session=${token}; crm_session=${otherToken}` } }), environment, async (_, init) => {
    assert.equal(new Headers(init?.headers).get("cookie"), `crm_session=${token}; crm_session=${otherToken}`);
    return Response.json({ error: "Invalid request." }, { status: 400 });
  });
  assert.equal(response.status, 400);
});

test("OFFLINE bridge outages never invoke a fallback and never reveal internal failures", async () => {
  let calls = 0;
  const response = await forwardToExpress(request("/api/jobs"), environment, async () => {
    calls++; throw new Error("Synthetic credential marker must never escape");
  });
  assert.equal(calls, 1); assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "The service is temporarily unavailable." });
});

test("OFFLINE disabled or malformed bridge configuration performs zero upstream calls", async () => {
  for (const env of [{}, { ...environment, CRM_EXPRESS_ORIGIN: "http://example.invalid:3101" }]) {
    const response = await forwardToExpress(request("/api/auth/me"), env, async () => assert.fail("Unexpected network call"));
    assert.equal(response.status, 503);
  }
});

test("OFFLINE redirects are not followed or exposed to the browser", async () => {
  const response = await forwardToExpress(request("/api/auth/me"), environment, async () => new Response(null, { status: 302, headers: { location: "https://example.invalid" } }));
  assert.equal(response.status, 503); assert.equal(response.headers.has("location"), false);
});

test("OFFLINE unsafe backend cookies are rejected while logout deletion survives", async () => {
  for (const cookie of [`crm_session=${token}; Path=/; SameSite=Lax`, `crm_session=${token}; Path=/; HttpOnly; SameSite=Lax; Domain=127.0.0.1`,
    `other=${token}; Path=/; HttpOnly; SameSite=Lax`, `crm_session=${token}; Path=/wrong; HttpOnly; SameSite=Lax`]) {
    const response = await forwardToExpress(request("/api/auth/csrf"), environment, async () => Response.json({}, { headers: { "set-cookie": cookie } }));
    assert.equal(response.status, 503); assert.equal(response.headers.has("set-cookie"), false);
  }
  const response = await forwardToExpress(request("/api/auth/logout", { method: "POST" }), environment, async () => Response.json({ signedOut: true }, { headers: {
    "set-cookie": "crm_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax",
  } }));
  assert.equal(response.status, 200); assert.equal(response.headers.getSetCookie().length, 1);
});

test("OFFLINE declared and streamed oversized requests are refused without unbounded buffering", async () => {
  const declared = await forwardToExpress(request("/api/leads/1/attachments", { method: "POST", headers: { "content-length": "999999999" } }), environment,
    async () => assert.fail("Oversized declared request must not be forwarded"));
  assert.equal(declared.status, 413);
  const streamed = await forwardToExpress(request("/api/leads/1/attachments", { method: "POST", body: new Uint8Array(16_384_000 + 32_769) }), environment,
    async (_, init) => { await new Response(init?.body).arrayBuffer(); return Response.json({}); });
  assert.equal(streamed.status, 413);
});

test("OFFLINE department bridge matches source request boundaries and keeps unrelated routes narrow", async () => {
  for (const department of ["Electrical", "Civil", "PM", "Switchgear", "Maintenance"]) {
    const maximum = (department === "PM" ? TASK_ATTACHMENT_LIMIT : LARGE_LOG_ATTACHMENT_LIMIT) + 32_768;
    const path = `/api/departments/${department}/jobs/1/logs`; let read = 0;
    const allowed = await forwardToExpress(request(path, { method: "POST", body: new Uint8Array(maximum) }), environment, async (_, init) => { read = (await new Response(init?.body).arrayBuffer()).byteLength; return Response.json({}); });
    assert.equal(allowed.status, 200); assert.equal(read, maximum);
    const denied = await forwardToExpress(request(path, { method: "POST", body: new Uint8Array(maximum + 1) }), environment, async (_, init) => { await new Response(init?.body).arrayBuffer(); return Response.json({}); });
    assert.equal(denied.status, 413);
    assert.equal((await forwardToExpress(request(path, { method: "POST", headers: { "content-length": String(maximum + 1) } }), environment, async () => assert.fail("Declared oversize must not forward"))).status, 413);
  }
});

test("OFFLINE private binary responses and authorization statuses retain their data/headers", async () => {
  const bytes = Uint8Array.from([0, 255, 127, 10]);
  const response = await forwardToExpress(request("/api/quotations/1/pdf"), environment, async () => new Response(bytes, { headers: {
    "content-type": "application/pdf", "content-disposition": 'attachment; filename="synthetic.pdf"', "access-control-allow-origin": "*", "x-powered-by": "marker",
    "content-security-policy": "sandbox; default-src 'none'", "cache-control": "private, no-store",
  } }));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("content-security-policy"), "sandbox; default-src 'none'");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.has("access-control-allow-origin"), false); assert.equal(response.headers.has("x-powered-by"), false);
  for (const status of [401, 403, 404, 409, 413, 415, 429, 503]) {
    const failure = await forwardToExpress(request("/api/jobs"), environment, async () => Response.json({ error: "Safe synthetic failure" }, { status }));
    assert.equal(failure.status, status);
  }
});

test("OFFLINE attachment preview bridge preserves current cookies, inline isolation and denied responses for GET and HEAD", async () => {
  const paths = ["/api/attachments/550e8400-e29b-41d4-a716-446655440000/preview", "/api/log-attachments/550e8400-e29b-41d4-a716-446655440000/preview"];
  const bytes = new TextEncoder().encode("<script>inert synthetic text</script>");
  for (const path of paths) for (const method of ["GET", "HEAD"]) {
    const response = await forwardToExpress(request(path, { method, headers: { cookie: `crm_session=${token}`, origin: environment.APP_ORIGIN } }), environment, async (url, init) => {
      assert.equal(url, environment.CRM_EXPRESS_ORIGIN + path.replace("/api/", "/api/v1/"));
      assert.equal(init?.method, method); assert.equal(new Headers(init?.headers).get("cookie"), `crm_session=${token}`);
      assert.equal(new Headers(init?.headers).get("origin"), environment.APP_ORIGIN);
      return new Response(method === "HEAD" ? null : bytes, { headers: { "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'inline; filename="fixture.txt"', "content-security-policy": "sandbox; default-src 'none'", "cache-control": "private, no-store" } });
    });
    assert.equal(response.status, 200); assert.match(response.headers.get("content-disposition")!, /^inline;/);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(response.headers.get("content-security-policy"), "sandbox; default-src 'none'");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("vary"), "Cookie");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), method === "HEAD" ? new Uint8Array() : bytes);
  }
  for (const path of paths) for (const status of [401, 403, 404, 415, 503]) {
    const response = await forwardToExpress(request(path), environment, async () => Response.json({ error: "Safe refusal" }, { status }));
    assert.equal(response.status, status); assert.equal(response.headers.has("content-disposition"), false);
    assert.deepEqual(await response.json(), { error: "Safe refusal" });
  }
});

test("OFFLINE oversized upstream response fails safely", async () => {
  const response = await forwardToExpress(request("/api/jobs/export"), environment, async () => new Response(new Uint8Array(20 * 1024 * 1024 + 1)));
  assert.equal(response.status, 503);
});

test("OFFLINE HEAD and empty success bodies stay bodyless", async () => {
  const head = await forwardToExpress(request("/api/auth/me", { method: "HEAD" }), environment, async () => Response.json({ synthetic: true }));
  assert.equal(head.status, 200); assert.equal(await head.text(), "");
  const empty = await forwardToExpress(request("/api/jobs"), environment, async () => new Response(null, { status: 204 }));
  assert.equal(empty.status, 204); assert.equal(await empty.text(), "");
});

test("OFFLINE SSR reads forward only auth cookies and propagate authorization versus unavailable responses", async () => {
  const result = await readExpress<{ id: string }>("/api/jobs/1", `crm_session=${token}; unrelated=value`, environment, async (input, init) => {
    assert.equal(input, environment.CRM_EXPRESS_ORIGIN + "/api/v1/jobs/1");
    assert.equal(new Headers(init?.headers).get("cookie"), `crm_session=${token}`);
    return Response.json({ id: "1" });
  });
  assert.equal(result.id, "1");
  for (const status of [401, 403, 404, 503]) {
    await assert.rejects(readExpress("/api/jobs/1", "", environment, async () => Response.json({}, { status })), error =>
      error instanceof Error && "status" in error && error.status === status);
  }
  await assert.rejects(readExpress("/api/jobs/1", "", environment, async () => new Response("<html>unexpected</html>")));
});

test("OFFLINE auth identity accepts only the public wire projection", () => {
  const user = { localUserId: "1", externalUserId: null, username: "Synthetic", email: "fixture@example.invalid", permissions: ["dashboard.view"] };
  assert.equal(isAuthUser(user), true);
  for (const value of [null, [], { ...user, password: "synthetic" }, { ...user, localUserId: "invalid" }, { ...user, permissions: [1] }]) assert.equal(isAuthUser(value), false);
});

test("OFFLINE dashboard presentation predicate preserves the existing grant semantics", () => {
  const keys = ["dashboard.view", "sales_dashboard.view", "electric_dashboard.view", "civil_dashboard.view",
    "pm_dashboard.view", "switchgear_dashboard.view", "maintenance_dashboard.view", "leads.view", "users.write"];
  for (const grants of [[], ...keys.map(key => [key]), keys]) assert.equal(hasDashboardAccess(grants), legacyDashboardAccess(grants));
});

test("OFFLINE page static runtime graph excludes database services and backend source; old readers are explicit deferred branch only", () => {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return; seen.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || node.importClause?.isTypeOnly) continue;
      if (node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
        && !node.importClause.name && node.importClause.namedBindings.elements.every(item => item.isTypeOnly)) continue;
      const spec = node.moduleSpecifier.text;
      assert.doesNotMatch(spec, /backend[\\/]|mysql2|better-sqlite3/);
      if (!spec.startsWith(".") && !spec.startsWith("@/")) continue;
      const stem = spec.startsWith("@/") ? resolve("src", spec.slice(2)) : resolve(dirname(file), spec);
      const next = [stem + ".ts", stem + ".tsx", join(stem, "index.ts")].find(candidate => {
        try { return readFileSync(candidate).byteLength > 0; } catch { return false; }
      });
      if (!next) continue;
      assert.doesNotMatch(next.replaceAll("\\", "/"), /\/server\/(?:db\/|(?:auth|dashboard|leads|jobs|departments|commercial|settings)\/service\.ts)/);
      visit(next);
    }
  };
  for (const file of files(resolve("src/app")).filter(file => /(?:page|layout)\.tsx$/.test(file))) visit(file);
  assert.ok(seen.size > 20);
  const auth = readFileSync("src/server/frontend-auth.ts", "utf8"), records = readFileSync("src/server/frontend-records.ts", "utf8");
  assert.match(auth, /mode === "nextjs"\) return \(await import\("\.\/web-auth"\)\)/);
  assert.match(records, /mode === "express"\) return await readExpress/);
  assert.match(readFileSync("src/server/db/index.ts", "utf8"), /requireNextDatabase\(process\.env\)/);
});
