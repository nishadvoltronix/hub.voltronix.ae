import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { allowedIsolatedBrowserRequest, isolatedChildEnvironment, isolatedOrigin } from "./isolated-browser.js";

test("isolated browser permits only selected loopback origin and bounded API mutations", () => {
  for (const [path, method] of [["/login", "GET"], ["/api/auth/login", "POST"], ["/api/jobs/1/status", "PATCH"], ["/api/settings/users/1/permissions", "PUT"]])
    assert.equal(allowedIsolatedBrowserRequest(isolatedOrigin + path, method!), true);
  for (const [url, method] of [["http://127.0.0.1:3001/api/auth/login", "POST"], ["https://example.invalid", "GET"],
    [isolatedOrigin + "/api/items", "DELETE"], [isolatedOrigin + "/login", "POST"], [isolatedOrigin + "/api/items?other=1", "POST"],
    ["http://user:pass@127.0.0.1:3101/api/items", "GET"], [isolatedOrigin + "/api/%2fsecret", "GET"]])
    assert.equal(allowedIsolatedBrowserRequest(url!, method!), false);
});
test("isolated child configuration drops credentials/debug and cannot select active demo or MySQL", () => {
  const result = isolatedChildEnvironment({ PATH: "synthetic", DATABASE_URL: "sensitive sentinel", MYSQL_PASSWORD: "sensitive sentinel",
    CRM_EXPRESS_ORIGIN: "http://127.0.0.1:3002", CRM_RUNTIME_PROFILE: "production", NODE_OPTIONS: "--inspect" });
  assert.equal(result.PATH, "synthetic"); assert.equal(result.APP_ORIGIN, isolatedOrigin); assert.equal(result.CRM_EXPRESS_ORIGIN, "http://127.0.0.1:3102");
  for (const key of ["DATABASE_URL", "MYSQL_PASSWORD", "CRM_RUNTIME_PROFILE", "NODE_OPTIONS"]) assert.equal(result[key], undefined);
  assert.equal(result.CRM_MYSQL_NETWORK_DISABLED, "1"); assert.equal(result.NEXT_TELEMETRY_DISABLED, "1");
});
test("isolated browser runtime opens only an in-memory fixture and has no handoff, file export or active demo invocation", () => {
  const source = readFileSync(new URL("./isolated-browser.ts", import.meta.url), "utf8");
  assert.match(source, /new Database\(":memory:"\)/);
  assert.doesNotMatch(source, /\b(?:openDemo|readPrivate|writePrivateNew|openDatabase|writeFileSync|rmSync|unlinkSync)\(/);
  assert.doesNotMatch(source, /from ["']\.\/storage/);
  assert.match(source, /--synthetic-in-memory-only/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /else ownedDatabase\?\.close\(\)/);
  assert.match(source, /"\.env\.production\.local"/);
});
