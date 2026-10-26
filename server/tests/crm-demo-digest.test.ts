import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { crmDemoDigest, crmDemoDigestPaths } from "../scripts/crm-demo/digest.js";

test("OFFLINE CRM approval digest covers the root app, server, contracts and PDF assets", () => {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  assert.match(crmDemoDigest(root), /^[a-f0-9]{64}$/);
  for (const name of ["src", "next.config.ts", "package-lock.json", "server/assets", "tsconfig.server.json", "tsconfig.server.build.json",
    "resources/quotation-pdf", "shared/contracts/src", "shared/contracts/tsconfig.json"]) assert.ok(crmDemoDigestPaths.includes(name));
  assert.equal(crmDemoDigestPaths.includes("shared/contracts/package-lock.json"), false);
  assert.ok(crmDemoDigestPaths.every(name => !/(?:\.env|\.local-data|node_modules|dist|\.next|application|system)/.test(name)));
});

test("OFFLINE CRM digest accepts the normalized CLI root shape without printing a fingerprint", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  assert.equal(crmDemoDigest(root), crmDemoDigest(resolve(root)));
});
