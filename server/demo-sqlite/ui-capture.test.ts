import assert from "node:assert/strict";
import test from "node:test";
import { allowedCaptureRequest } from "./ui-capture.js";

const origin = "http://127.0.0.1:3001";
test("UI capture allows normal local read navigation, prefetch and assets", () => {
  for (const path of ["/login", "/dashboard", "/deals/new", "/jobs/1", "/settings/users", "/api/auth/csrf", "/api/jobs/1",
    "/_next/static/chunks/main.js", "/legacy/css/style.css", "/assets/images/logo.png"]) {
    assert.equal(allowedCaptureRequest(origin, origin + path, "GET"), true);
  }
  assert.equal(allowedCaptureRequest(origin, origin + "/api/auth/login", "POST"), true);
});
test("UI capture refuses CRM mutations, arbitrary origins and private paths", () => {
  for (const [url, method] of [[origin + "/api/jobs/1/remarks", "PATCH"], [origin + "/api/settings/users", "POST"],
    [origin + "/api/auth/logout", "POST"], [origin + "/.env.local", "GET"], [origin + "/assets/%2e%2e/private", "GET"],
    ["http://127.0.0.1:3002/api/v1/jobs", "GET"], ["https://example.invalid", "GET"], ["file:///private", "GET"],
    ["http://synthetic:password@127.0.0.1:3001/jobs", "GET"]]) {
    assert.equal(allowedCaptureRequest(origin, url!, method!), false);
  }
});
