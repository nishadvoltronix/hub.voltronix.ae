import assert from "node:assert/strict";
import test from "node:test";
import { acknowledgement, CrmDemoRefusal, parseApproval, parseArguments, parseOwnership, parseProfile, parseReceipt,
  requireScopes, targetFor } from "../scripts/crm-demo/guard.js";

const id = "01234567-89ab-4def-8123-456789abcdef", target = targetFor(id), now = Date.parse("2026-10-10T10:00:00Z"), digest = "a".repeat(64);
const approval = () => ({ version: 1, fixtureId: id, target, approved: true, approvalReference: "Offline fixture approval",
  validFrom: "2026-10-10T09:59:00Z", validUntil: "2026-10-10T11:00:00Z", serverUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  harnessDigest: digest, exclusiveOperatorWindow: true,
  scopes: { provision: true, migrate: true, syntheticWrites: true, authentication: true, crmWorkflows: true, http: true, chromium: true, retainDemoAccess: true } });
const profile = () => ({ provider: "mysql", environment: "test", host: target.host, port: target.port,
  database: target.database, user: target.runtimeUser, password: "synthetic-private-fixture" });
test("OFFLINE full CRM target names are deterministic and disjoint from every auth/application schema", () => {
  assert.equal(target.database, "crm_local_crm_0123456789ab4def8123456789abcdef");
  assert.equal(target.runtimeUser, "crm_r_0123456789ab4def81234567");
  assert.equal(target.migrationUser, "crm_m_0123456789ab4def81234567");
  assert.equal(target.fixtureUser, "crm_f_0123456789ab4def81234567");
  for (const value of ["crm_local_dev", id.toUpperCase(), id.replace("4def", "1def"), id + "x", ""]) assert.throws(() => targetFor(value), CrmDemoRefusal);
});
test("OFFLINE CRM argument grammar demands explicit writes and rejects cleanup or unrecognized modes", () => {
  assert.deepEqual(parseArguments(["plan"]), { mode: "plan" });
  assert.deepEqual(parseArguments(["diagnose", "--fixture-id", id]), { mode: "diagnose", fixtureId: id });
  for (const mode of ["provision", "run"]) {
    assert.equal(parseArguments([mode, "--fixture-id", id, acknowledgement]).mode, mode);
    assert.throws(() => parseArguments([mode, "--fixture-id", id]), CrmDemoRefusal);
    for (const flag of ["--cleanup-owned-fixture", ...(mode === "provision" ? ["--chromium"] : []), acknowledgement]) {
      assert.throws(() => parseArguments([mode, "--fixture-id", id, acknowledgement, flag]), CrmDemoRefusal);
    }
  }
  assert.equal(parseArguments(["run", "--fixture-id", id, acknowledgement, "--chromium"]).chromium, true);
  assert.equal(parseArguments(["run", "--fixture-id", id, acknowledgement, "--retain-demo-access", "--chromium"]).retainDemoAccess, true);
  assert.throws(() => parseArguments(["run", "--fixture-id", id, acknowledgement, "--retain-demo-access", "--retain-demo-access"]), CrmDemoRefusal);
  for (const args of [[], ["plan", "extra"], ["reset"], ["diagnose", "--fixture-id", id, acknowledgement]]) assert.throws(() => parseArguments(args), CrmDemoRefusal);
});
test("OFFLINE CRM approval pins exact target digest time and real scope, never booleans alone", () => {
  const valid = parseApproval(approval(), id, digest, now);
  for (const patch of [{ approved: false }, { approvalReference: "" }, { target: { ...target, database: "crm_local_dev" } },
    { harnessDigest: "b".repeat(64) }, { serverUuid: "placeholder" }, { exclusiveOperatorWindow: false },
    { validUntil: new Date(now).toISOString() }, { validFrom: new Date(now + 1).toISOString() },
    { validFrom: new Date(now - 86_400_000).toISOString() }, { unexpected: true }]) {
    assert.throws(() => parseApproval({ ...approval(), ...patch }, id, digest, now), CrmDemoRefusal);
  }
  for (const key of ["provision", "migrate"] as const) assert.throws(() => requireScopes({ ...valid, scopes: { ...valid.scopes, [key]: false } }, { mode: "provision", fixtureId: id }), CrmDemoRefusal);
  for (const key of ["syntheticWrites", "authentication", "crmWorkflows", "http"] as const) assert.throws(() => requireScopes({ ...valid, scopes: { ...valid.scopes, [key]: false } }, { mode: "run", fixtureId: id }), CrmDemoRefusal);
  assert.throws(() => requireScopes({ ...valid, scopes: { ...valid.scopes, chromium: false } }, { mode: "run", fixtureId: id, chromium: true }), CrmDemoRefusal);
  assert.throws(() => requireScopes({ ...valid, scopes: { ...valid.scopes, retainDemoAccess: false } }, { mode: "run", fixtureId: id, retainDemoAccess: true }), CrmDemoRefusal);
});
test("OFFLINE CRM profiles reject every server/application target or mismatched role without printing values", () => {
  assert.equal(parseProfile(profile(), target, "runtime").user, target.runtimeUser);
  for (const patch of [{ host: "localhost" }, { host: "::1" }, { host: "production.invalid" }, { port: 3306 },
    { database: "crm_local_dev" }, { database: "crm_local_auth_0123456789ab4def8123456789abcdef" },
    { user: target.migrationUser }, { environment: "development" }, { provider: "sqlite" }, { password: "" }, { socketPath: "x" }]) {
    assert.throws(() => parseProfile({ ...profile(), ...patch }, target, "runtime"), CrmDemoRefusal);
  }
  assert.equal(parseProfile({ ...profile(), environment: "development", database: "crm_local_dev", user: "root" }, target, "operator").user, "root");
});
test("OFFLINE CRM ownership and provision receipts require exact crypto owner, target, lineage and profile fingerprints", () => {
  const approved = parseApproval(approval(), id, digest, now);
  const input = { version: 1, fixtureId: id, target, serverUuid: approved.serverUuid, harnessDigest: digest, owner: "b".repeat(64), createdAt: new Date(now).toISOString() };
  const owned = parseOwnership(input, approved);
  for (const patch of [{ owner: "" }, { target: { ...target, runtimeUser: "root" } }, { harnessDigest: "c".repeat(64) },
    { createdAt: approved.validUntil }, { serverUuid: "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee" }]) assert.throws(() => parseOwnership({ ...input, ...patch }, approved), CrmDemoRefusal);
  const fingerprints = { runtime: "r".repeat(64), migration: "m".repeat(64), fixture: "f".repeat(64) };
  const receipt = { version: 1, owner: owned.owner, fixtureId: id, serverUuid: approved.serverUuid, phase: "provisioned", migrationApplied: 5, migrationRepeat: 0, profiles: fingerprints };
  parseReceipt(receipt, owned, fingerprints);
  for (const patch of [{ owner: "c".repeat(64) }, { migrationRepeat: 1 }, { migrationApplied: 0 }, { migrationApplied: 1 }, { profiles: { ...fingerprints, runtime: "changed" } }]) assert.throws(() => parseReceipt({ ...receipt, ...patch }, owned, fingerprints), CrmDemoRefusal);
});
