import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseProbeConfig, probeRequests, runHttpProbes, type ProbeResponse } from "../scripts/staging/http-probe";
import { assertApprovedAddresses } from "../scripts/staging/https-transport";

const now = Date.parse("2026-10-10T10:00:00Z");
function fixture() {
  return { formatVersion: 1 as const, nonProductionApproved: true as const, approvalReference: "synthetic-review-only",
    artifactReference: "synthetic-artifact-only", expiresAt: "2026-10-10T11:00:00Z", origin: "https://staging.example.invalid",
    approvedAddresses: ["192.0.2.10"], canaries: [{ path: "/.local-data/staging-canary-synthetic.txt", installedEvidenceReference: "synthetic-no-placement" }] };
}
function response(id: string): ProbeResponse {
  const status = id.startsWith("private-canary-") ? 404 : id === "anonymous-identity" ? 401 : id === "cross-origin-csrf" ? 403 : 200;
  return { status, tlsAuthorized: true, tlsProtocol: "TLSv1.3", headers: { "cache-control": "no-store", vary: "Cookie",
    "x-content-type-options": "nosniff", "x-frame-options": "DENY",
    ...(["csrf-cookie", "forwarded-origin"].includes(id) ? { "set-cookie": [`__Host-crm_csrf=${"S".repeat(43)}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=7200`] } : {}) } };
}
test("staging configuration refuses credentials, non-HTTPS/altered origins, unknown fields and expired approvals", () => {
  assert.equal(parseProbeConfig(fixture(), now).origin, fixture().origin);
  for (const patch of [
    { origin: "http://staging.example.invalid" }, { origin: "https://user:password@staging.example.invalid" },
    { origin: "https://staging.example.invalid/" }, { origin: "https://staging.example.invalid?token=secret" },
    { origin: "https://192.0.2.10" }, { nonProductionApproved: false }, { approvalReference: "" },
    { expiresAt: "2026-10-10T09:00:00Z" }, { expiresAt: "2026-10-12T10:00:00Z" },
    { approvedAddresses: [] }, { approvedAddresses: ["staging.example.invalid"] }, { clientSecret: "synthetic-secret-never-print" },
  ]) assert.throws(() => parseProbeConfig({ ...fixture(), ...patch }, now), /Invalid or expired/);
});
test("canaries can address only declared harmless files, never real environment/database paths or redirected URLs", () => {
  for (const path of ["/.env.local", "/.local-data/development/crm.sqlite", "https://other.example.invalid/", "//other.example.invalid/",
    "/.local-data/../.env.local", "/.local-data/staging-canary-a.txt?token=secret", "/.local-data/%2e%2e/.env.local"]) {
    assert.throws(() => parseProbeConfig({ ...fixture(), canaries: [{ path, installedEvidenceReference: "synthetic" }] }, now));
  }
  assert.throws(() => parseProbeConfig({ ...fixture(), canaries: [...fixture().canaries, ...fixture().canaries] }, now));
  assert.throws(() => parseProbeConfig({ ...fixture(), canaries: [] }, now));
});
test("DNS acceptance requires every returned address to be explicitly approved before a socket may open", () => {
  assert.doesNotThrow(() => assertApprovedAddresses([{ address: "192.0.2.10", family: 4 }], fixture().approvedAddresses));
  for (const addresses of [[], [{ address: "192.0.2.20", family: 4 }], [{ address: "192.0.2.10", family: 4 }, { address: "192.0.2.20", family: 4 }]]) {
    assert.throws(() => assertApprovedAddresses(addresses, fixture().approvedAddresses));
  }
});
test("isolated probe success remains anonymous-only and never serializes cookie/header/body or approval values", async () => {
  const requests = [];
  const result = await runHttpProbes(fixture(), async (request) => {
    requests.push(request);
    return { ...response(request.id), headers: { ...response(request.id).headers, "x-secret": "synthetic-private-header" } };
  }, () => now);
  assert.equal(result.status, "PASS"); assert.equal(result.results.length, 6);
  assert.equal(requests.length, 6); assert.equal(result.stagingReady, false); assert.equal(result.authenticatedSessionsVerified, false);
  const serialized = JSON.stringify(result);
  for (const secret of ["S".repeat(43), "synthetic-private-header", "synthetic-review-only"]) assert.equal(serialized.includes(secret), false);
  assert.equal(probeRequests(fixture()).some((request) => "Cookie" in request.headers || "Authorization" in request.headers), false);
});
test("certificate errors, redirects, cache leaks and public private-canaries fail their gate instead of following or accepting", async () => {
  for (const patch of [{ tlsAuthorized: false }, { tlsProtocol: "TLSv1" }, { status: 302 }, { status: 200 }, { headers: {} }]) {
    const result = await runHttpProbes(fixture(), async (request) => ({ ...response(request.id), ...patch }), () => now);
    assert.equal(result.status, "FAIL");
  }
});
test("CSRF cookie flags reject unsafe domain, duplicate attributes, alternate paths and insecure variants", async () => {
  for (const tail of ["Secure; HttpOnly; Path=/; SameSite=Lax; Max-Age=7200; Domain = example.invalid",
    "Secure; HttpOnly; Path=/; Path=/other; SameSite=Lax; Max-Age=7200",
    "HttpOnly; Path=/; SameSite=Lax; Max-Age=7200", "Secure; HttpOnly; Path=/; SameSite=None; Max-Age=7200",
    "Secure=true; HttpOnly; Path=/; SameSite=Lax; Max-Age=7200"]) {
    const result = await runHttpProbes(fixture(), async (request) => ({ ...response(request.id), headers: { ...response(request.id).headers,
      "set-cookie": [`__Host-crm_csrf=${"S".repeat(43)}; ${tail}`] } }), () => now);
    assert.equal(result.status, "FAIL");
    assert.equal(result.results.find((entry) => entry.id === "csrf-cookie")?.checks?.csrfCookieFlags, false);
  }
});
test("errors are redacted, uncertain requests are not retried, and approval expiration stops subsequent probes", async () => {
  let calls = 0;
  const failed = await runHttpProbes(fixture(), async () => { calls++; throw new Error("synthetic-private-token"); }, () => now);
  assert.equal(calls, 1); assert.equal(failed.status, "FAIL"); assert.equal(JSON.stringify(failed).includes("synthetic-private-token"), false);
  let clockCalls = 0; calls = 0;
  const expired = await runHttpProbes(fixture(), async (request) => { calls++; return response(request.id); },
    () => ++clockCalls <= 2 ? now : now + 2 * 60 * 60 * 1000);
  assert.equal(calls, 1); assert.equal(expired.status, "FAIL");
});
test("CLI offline validation contacts no target and unsafe/default invocation fails without printing private configuration", () => {
  const ownedParent = resolve(tmpdir());
  const directory = mkdtempSync(join(ownedParent, "crm-staging-probe-test-"));
  try {
    const configPath = join(directory, "private-config.json");
    const config = { ...fixture(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    writeFileSync(configPath, JSON.stringify(config));
    const before = readFileSync(configPath);
    const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/verify-staging-http.ts", ...args], { encoding: "utf8", windowsHide: true });
    const validated = run(["--config", configPath, "--validate-only"]);
    assert.equal(validated.status, 0); const output = JSON.parse(validated.stdout);
    assert.equal(output.networkPerformed, false); assert.equal(output.approvalIndependentlyVerified, false);
    assert.equal(output.plannedGetRequests, 6); assert.deepEqual(readFileSync(configPath), before);
    for (const args of [[], ["--config", configPath], ["--config", configPath, "--execute-approved-probes", "--validate-only"]]) {
      const invalid = run(args); assert.equal(invalid.status, 1); assert.equal(invalid.stderr.includes(config.approvalReference), false);
    }
    mkdirSync(join(directory, "not-a-file"));
    assert.equal(run(["--config", join(directory, "not-a-file"), "--validate-only"]).status, 1);
  } finally {
    // Only this test's unique owned directory is removable; never a project/data path.
    assert.equal(dirname(resolve(directory)), ownedParent);
    assert.ok(directory.startsWith(join(ownedParent, "crm-staging-probe-test-")));
    rmSync(directory, { recursive: true, force: true });
  }
});
