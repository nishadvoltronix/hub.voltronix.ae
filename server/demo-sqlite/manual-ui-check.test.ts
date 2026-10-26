import assert from "node:assert/strict";
import test from "node:test";
import { allowedManualUiRequest, compactManualUiMetrics, manualUiScreenName } from "./manual-ui-check.js";
import type { CaptureMetrics } from "./ui-capture.js";

test("manual UI audit permits local UI reads and normal authentication only", () => {
  for (const department of ["Electrical", "Civil", "PM", "Switchgear", "Maintenance"])
    assert.equal(manualUiScreenName(`/departments/${department}/jobs`), `departments-${department.toLowerCase()}-jobs`);
  for (const path of ["/login", "/account", "/dashboard", "/settings/users", "/deals/new", "/api/auth/me", "/api/auth/csrf", "/api/capabilities", "/api/items", "/_next/static/chunks/app.js", "/legacy/assets/images/voltronix_logo.png"])
    assert.equal(allowedManualUiRequest("http://127.0.0.1:3001" + path, "GET"), true, path);
  for (const path of ["/api/auth/login", "/api/auth/logout"])
    assert.equal(allowedManualUiRequest("http://127.0.0.1:3001" + path, "POST"), true);
  for (const segment of ["[department]", "%5Bdepartment%5D", "%5bdepartment%5d"])
    assert.equal(allowedManualUiRequest(`http://127.0.0.1:3001/_next/static/chunks/app/departments/${segment}/jobs/page-a123.js`, "GET"), true);
  const metrics: CaptureMetrics[] = Array.from({ length: 84 }, () => ({ screen: "departments-electrical-jobs", viewport: "desktop",
    width: 1440, height: 1000, documentWidth: 1440, selectors: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`fixture-${i}`, null])) }));
  assert.ok(Buffer.byteLength(JSON.stringify(metrics)) > 262144, "reproduce the full audit's verbose receipt limit");
  const compact = compactManualUiMetrics(metrics);
  assert.equal(compact.length, 84);
  assert.ok(Buffer.byteLength(JSON.stringify({ metrics: compact }, null, 2)) < 32768, "leave room for pages and screenshots in the bounded private receipt");
  assert.deepEqual(compact[0], { screen: "departments-electrical-jobs", viewport: "desktop", width: 1440, height: 1000, documentWidth: 1440 });
});
test("manual UI audit refuses business mutation, secrets, external hosts and alternate schemes", () => {
  assert.throws(() => manualUiScreenName("/unexpected"));
  for (const method of ["POST", "PUT", "PATCH", "DELETE"])
    for (const path of ["/api/items", "/api/deals", "/api/settings/users/1", "/api/jobs/1/status"])
      assert.equal(allowedManualUiRequest("http://127.0.0.1:3001" + path, method), false);
  for (const value of ["https://example.com/login", "file:///secret", "http://127.0.0.1:3002/api/v1/jobs", "http://user:pass@127.0.0.1:3001/login",
    "http://127.0.0.1:3001/.env", "http://127.0.0.1:3001/legacy/assets/.env", "http://127.0.0.1:3001/api/jobs%2f1", "http://127.0.0.1:3001/legacy/assets/file.php"])
    assert.equal(allowedManualUiRequest(value, "GET"), false);
  assert.equal(allowedManualUiRequest("http://127.0.0.1:3001/api/auth/login?next=secret", "POST"), false);
  for (const segment of ["%255Bdepartment%255D", "%2e%2e", "%5Bunknown%5D", "[department]%2fsecret"])
    assert.equal(allowedManualUiRequest(`http://127.0.0.1:3001/_next/static/chunks/app/${segment}/page.js`, "GET"), false);
});
