import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { allowedAnonymousRequest, ANONYMOUS_PROTECTED_APIS, ANONYMOUS_PROTECTED_PAGES, ANONYMOUS_PROTECTED_FILES,
  ANONYMOUS_SCOPE_LIMITS } from "./anonymous-browser.js";
import { UI_CAPTURE_VIEWPORTS } from "./ui-capture.js";

const origin = "http://127.0.0.1:3001";
test("Anonymous verifier permits only explicit local public assets and protected reads", () => {
  for (const path of ["/login", "/", "/dashboard", "/settings/users/departments", "/api/auth/me", "/api/capabilities",
    "/api/jobs", "/_next/static/chunks/app.js", "/legacy/assets/css/style.css", "/legacy/assets/fonts/phosphor.woff2"])
    assert.equal(allowedAnonymousRequest(origin + path, "GET"), true);
  assert.equal(allowedAnonymousRequest(origin + "/login", "HEAD"), true);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
    for (const path of ["/api/auth/login", "/api/auth/logout", "/api/items", "/api/settings/users", "/api/jobs"])
      assert.equal(allowedAnonymousRequest(origin + path, method), false);
});

test("Anonymous verifier excludes credential endpoints private paths external services and executable legacy assets", () => {
  for (const path of ["/api/auth/csrf", "/api/auth/login", "/api/auth/logout", "/api/settings/users/15", "/api/unknown", "/api/leads",
    "/.env", "/legacy/assets/.env", "/legacy/assets/script.js", "/assets/private.json", "/include/config.php", "/legacy/assets/%2e%2e/private"])
    assert.equal(allowedAnonymousRequest(origin + path, "GET"), false);
  for (const url of ["https://example.invalid/login", "http://127.0.0.1:3002/api/v1/auth/me", "file:///private",
    "http://synthetic:synthetic@127.0.0.1:3001/login", "http://localhost:3001/login"])
    assert.equal(allowedAnonymousRequest(url, "GET"), false);
});

test("Every anonymous API refusal targets an existing exported GET route", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/app");
  const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
  const routes = files(join(root, "api")).filter(file => file.endsWith("route.ts")
    && /export\s+(?:async\s+)?function\s+GET\b/.test(readFileSync(file, "utf8")))
    .map(file => new RegExp("^/" + relative(root, dirname(file)).replaceAll("\\", "/")
      .split("/").map(segment => /^\[\w+\]$/.test(segment) ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/") + "$"));
  for (const endpoint of ANONYMOUS_PROTECTED_APIS) {
    assert.equal(routes.some(route => route.test(endpoint)), true,
      "Anonymous API inventory must name an existing GET route.");
  }
  assert.equal(new Set(ANONYMOUS_PROTECTED_APIS).size, ANONYMOUS_PROTECTED_APIS.length);
});

test("Anonymous file/history coverage cannot imply credential availability or permit mutation", () => {
  assert.equal(ANONYMOUS_PROTECTED_FILES.length, 5);
  for (const path of ANONYMOUS_PROTECTED_FILES) {
    assert.ok(ANONYMOUS_PROTECTED_APIS.includes(path));
    for (const method of ["GET", "HEAD"]) assert.equal(allowedAnonymousRequest(origin + path, method), true);
    for (const method of ["POST", "PATCH", "DELETE"]) assert.equal(allowedAnonymousRequest(origin + path, method), false);
  }
  for (const department of ["Electrical", "Civil", "PM", "Switchgear", "Maintenance"])
    assert.ok(ANONYMOUS_PROTECTED_APIS.includes(`/api/departments/${department}/jobs/1/logs`));
  assert.match(ANONYMOUS_SCOPE_LIMITS[0], /credential availability is not inspected/);
  assert.doesNotMatch(ANONYMOUS_SCOPE_LIMITS.join(" "), /currently unavailable/);
});

test("Reference and anonymous screenshots use identical desktop tablet and mobile dimensions", () => {
  assert.deepEqual(UI_CAPTURE_VIEWPORTS.map(({ width, height }) => [width, height]), [[1440, 1000], [768, 1024], [390, 844], [360, 844]]);
  assert.equal(new Set(UI_CAPTURE_VIEWPORTS.map(viewport => viewport.name)).size, 4);
});

test("Anonymous page inventory covers every current page and all five department route variants", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/app");
  const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
  const pages = files(root).filter(file => file.endsWith("page.tsx")).map(file => "/" + relative(root, dirname(file)).replaceAll("\\", "/")
    .replace("[department]", "Electrical").replace(/\[(?:id|taskId)\]/g, "1")).filter(page => page !== "/login");
  const captured = [...new Set(ANONYMOUS_PROTECTED_PAGES.map(page => page.replace(/^\/departments\/[^/]+\//, "/departments/Electrical/")))];
  assert.deepEqual(captured.sort(), pages.sort());
  for (const department of ["Electrical", "Civil", "PM", "Switchgear", "Maintenance"])
    for (const suffix of ["", "/1"]) assert.equal(ANONYMOUS_PROTECTED_PAGES.includes(`/departments/${department}/jobs${suffix}`), true);
});
