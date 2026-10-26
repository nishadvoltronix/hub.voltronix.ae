import assert from "node:assert/strict";
import test from "node:test";
import { createHarness, type HarnessEffects } from "../scripts/mysql-auth/runner.js";
import { acknowledgement, targetFor, HarnessRefusal } from "../scripts/mysql-auth/guard.js";
import type { MysqlAuthWireConnection } from "../src/db/mysql/driver.js";

const fixtureId = "12345678-1234-4234-8234-123456789abc", serverUuid = "12345678-1234-1234-8234-123456789abc";
const target = targetFor(fixtureId), base = `.local-data/test/mysql-auth-${fixtureId}`;
const digest = "a".repeat(64), timestamp = Date.parse("2026-10-10T10:00:00Z");
const approvalPath = `.local-data/approvals/mysql-auth-${fixtureId}.json`;
const operatorPath = ".local-data/operators/mysql-auth-operator.json";
function rig(overrides: Partial<HarnessEffects> = {}) {
  const memory = new Map<string, unknown>(), events: string[] = [];
  memory.set(approvalPath, { version: 1, fixtureId, target, approved: true, approvalReference: "Offline fixture approval only",
    validFrom: "2026-10-10T09:59:00Z", validUntil: "2026-10-10T11:00:00Z", serverUuid, harnessDigest: digest,
    exclusiveOperatorWindow: true, scopes: { provision: true, migrate: true, syntheticWrites: true, authentication: true,
      http: true, faultInjection: true, chromium: true, cleanupOwned: true } });
  memory.set(operatorPath, { provider: "mysql", environment: "development", host: "127.0.0.1", port: 3308,
    database: "crm_local_dev", user: "root", password: "offline-only-secret" });
  const files = {
    operatorPath, approvalPath: () => approvalPath, fixtureRoot: () => base,
    exists: (path: string) => memory.has(path),
    read: (path: string) => { if (!memory.has(path)) throw new HarnessRefusal("PRIVATE_FILE"); return structuredClone(memory.get(path)); },
    writeNew: (path: string, value: unknown) => { if (memory.has(path)) throw new HarnessRefusal("STATE"); events.push(`file:${path.split("/").at(-1)}`); memory.set(path, structuredClone(value)); },
    ensureContainer: () => {},
    createFixture: () => { if (memory.has(base)) throw new HarnessRefusal("OWNERSHIP"); memory.set(base, true); return base; },
  };
  let applied = 0, secrets = 0;
  const wire = (): MysqlAuthWireConnection => ({ query: async () => [[], []], execute: async () => [[], []],
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {},
    end: async () => { events.push("end"); }, destroy: () => { events.push("destroy"); } });
  const effects: HarnessEffects = {
    connect: async config => { events.push(`connect:${config.user === "root" ? "operator" : config.user.slice(0, 6)}`); return wire(); },
    verifyConnection: async () => { events.push("pinned-identity"); },
    observe: async () => { events.push("observe"); return { serverUuid }; },
    provision: async () => { events.push("provision"); }, scoped: async () => { events.push("scoped"); },
    grants: async () => { events.push("grants"); },
    migrate: async () => { events.push("migrate"); return applied++ === 0 ? 1 : 0; },
    verifySchema: async () => { events.push("empty-schema"); }, verifyRuntime: async () => { events.push("runtime"); },
    createFixture: async () => {
      events.push("fixture"); const identity = { id: "1", email: "synthetic@example.invalid" };
      return { fixtureId: fixtureId.replaceAll("-", ""), database: target.database, password: "synthetic-secret", permissionId: "1",
        allowed: identity, denied: identity, bcryptA: identity, bcryptY: identity, concurrent: identity,
        httpAllowed: identity, httpDenied: { id: "2", email: "denied@example.invalid" } };
    },
    cases: async options => { events.push("cases"); for (let index = 0; index < 15; index++) options.record(`case-${index}`, "mysql"); return { checks: 15 }; },
    browser: async options => { events.push("browser"); const count = options.browser ? 10 : 6;
      for (let index = 0; index < count; index++) options.record(`http-${index}`, index < 6 ? "http" : "chromium"); return count; },
    cleanup: async () => { events.push("cleanup"); return { deletedRows: 10 }; }, ...overrides,
  };
  const execute = createHarness({ files, effects, digest: () => digest, now: () => timestamp, uuid: () => fixtureId,
    secret: () => String(++secrets).repeat(64), owner: () => "b".repeat(64) });
  const provision = () => execute(["provision", "--fixture-id", fixtureId, acknowledgement]);
  const run = (...extra: string[]) => execute(["run", "--fixture-id", fixtureId, acknowledgement, ...extra]);
  return { memory, events, files, execute, provision, run };
}
function change(r: ReturnType<typeof rig>, path: string, values: Record<string, unknown>) {
  r.memory.set(path, { ...(r.memory.get(path) as Record<string, unknown>), ...values });
}
test("plan emits unapproved templates only, no connection, and never overwrites", async () => {
  const r = rig(); r.memory.delete(approvalPath); r.memory.delete(operatorPath);
  const result = await r.execute(["plan"]);
  assert.equal(result.status, "PLAN_ONLY"); assert.equal((r.memory.get(approvalPath) as {approved:boolean}).approved, false);
  assert(!r.events.some(event => event.startsWith("connect")));
  await assert.rejects(() => r.execute(["plan"]));
});
test("diagnose validates only offline files and presence without effects", async () => {
  const r = rig(); const result = await r.execute(["diagnose", "--fixture-id", fixtureId]);
  assert.equal(result.status, "OFFLINE_CONFIGURATION_PASS"); assert.equal(r.events.length, 0);
});
test("missing opt-in/approval and changed target refuse before files/connection mutations", async () => {
  for (const scenario of ["ack", "missing", "false", "target", "profile", "digest", "expired", "scope"]) {
    const r = rig();
    if (scenario === "missing") r.memory.delete(approvalPath);
    if (scenario === "false") change(r, approvalPath, { approved: false });
    if (scenario === "target") change(r, approvalPath, { target: { ...target, database: "crm_local_dev" } });
    if (scenario === "profile") change(r, operatorPath, { database: "crm_nextjs_development" });
    if (scenario === "digest") change(r, approvalPath, { harnessDigest: "f".repeat(64) });
    if (scenario === "expired") change(r, approvalPath, { validUntil: "2026-10-10T10:00:00Z" });
    if (scenario === "scope") change(r, approvalPath, { scopes: { ...(r.memory.get(approvalPath) as {scopes:object}).scopes, migrate: false } });
    await assert.rejects(() => scenario === "ack" ? r.execute(["provision", "--fixture-id", fixtureId]) : r.provision());
    assert.equal(r.events.length, 0, scenario);
  }
});
test("existing fixture directory is never adopted or overwritten", async () => {
  const r = rig(); r.memory.set(base, true); await assert.rejects(r.provision); assert.equal(r.events.length, 0);
});
test("provision orders ownership before connection, DDL before migration/grants and drain before receipt", async () => {
  const r = rig(); const result = await r.provision(); assert.equal(result.status, "PROVISIONED");
  assert(r.events.indexOf("file:ownership.json") < r.events.indexOf("connect:operator"));
  assert(r.events.indexOf("provision") < r.events.indexOf("migrate"));
  assert(r.events.lastIndexOf("migrate") < r.events.indexOf("grants"));
  assert(r.events.lastIndexOf("end") < r.events.indexOf("file:provisioned.json"));
  assert.equal(r.events.filter(event => event === "migrate").length, 2);
});
test("operator instance mismatch refuses before DDL and retains private failed receipt", async () => {
  const r = rig({ observe: async () => ({ serverUuid: "unexpected" }) });
  await assert.rejects(r.provision); assert(!r.events.includes("provision"));
  assert(r.memory.has(`${base}/provision-failed.json`)); assert(!r.memory.has(`${base}/provisioned.json`));
});
test("partial DDL failure never retries, cleans up, migrates or issues a ready receipt", async () => {
  const r = rig({ provision: async () => { throw new Error("private raw error"); } });
  await assert.rejects(r.provision, error => error instanceof HarnessRefusal && !error.message.includes("private raw"));
  assert(!r.events.includes("migrate")); assert(!r.events.includes("cleanup"));
  await assert.rejects(r.provision); assert.equal(r.events.filter(event => event === "connect:operator").length, 1);
});
test("unexpected migration count or insufficient runtime grants never certifies provisioning", async () => {
  for (const effects of [{ migrate: async () => 0 }, { verifyRuntime: async () => { throw new Error(); } }]) {
    const r = rig(effects); await assert.rejects(r.provision); assert(!r.memory.has(`${base}/provisioned.json`));
  }
});
test("run requires unchanged ownership, receipt and every profile before connecting", async () => {
  for (const path of ["ownership.json", "provisioned.json", "runtime.json", "migration.json", "fixture.json"]) {
    const r = rig(); await r.provision(); r.events.length = 0;
    if (path.endsWith("json") && ["runtime.json", "migration.json", "fixture.json"].includes(path)) change(r, `${base}/${path}`, { password: "changed-profile" });
    else r.memory.delete(`${base}/${path}`);
    await assert.rejects(r.run); assert.equal(r.events.length, 0, path);
  }
});
test("run claims attempt before connection, verifies empty schema before writes, and retains rows by default", async () => {
  const r = rig(); await r.provision(); r.events.length = 0;
  const result = await r.run(); assert.equal(result.status, "PASS");
  assert(r.events.indexOf("file:attempt.json") < r.events.indexOf("connect:operator"));
  assert(r.events.indexOf("empty-schema") < r.events.indexOf("fixture"));
  assert(!r.events.includes("cleanup")); assert(r.memory.has(`${base}/complete.json`));
  await assert.rejects(r.run); assert.equal(r.events.filter(event => event === "fixture").length, 1);
});
test("existing data and missing fixture ownership refuse before fixture DML or cleanup", async () => {
  let checks = 0;
  const r = rig({ verifySchema: async () => { if (++checks > 1) throw new Error("unapproved data"); } });
  await r.provision(); r.events.length = 0; await assert.rejects(() => r.run("--cleanup-owned-fixture"));
  assert(!r.events.includes("fixture")); assert(!r.events.includes("cleanup")); assert(r.memory.has(`${base}/failed.json`));
});
test("browser and owned-row cleanup require their own approval scopes", async () => {
  for (const [flag, key] of [["--chromium", "chromium"], ["--cleanup-owned-fixture", "cleanupOwned"]]) {
    const r = rig(); await r.provision(); r.events.length = 0;
    const approval = r.memory.get(approvalPath) as {scopes:object};
    change(r, approvalPath, { scopes: { ...approval.scopes, [key!]: false } });
    await assert.rejects(() => r.run(flag!)); assert.equal(r.events.length, 0);
  }
});
test("successful chromium path cleans only after all tests, records aggregate counts and suppresses secrets", async () => {
  const r = rig(); await r.provision(); r.events.length = 0;
  const result = await r.run("--chromium", "--cleanup-owned-fixture");
  assert(r.events.indexOf("browser") < r.events.indexOf("cleanup"));
  assert.equal((result as {checks:unknown[]}).checks.length, 25);
  assert(!/synthetic-secret|offline-only-secret|password|token|cookie|harnessDigest|serverUuid/.test(JSON.stringify(result)));
});
test("failed case, browser or cleanup retains target and single-use attempt, no automatic retry", async () => {
  for (const key of ["cases", "browser", "cleanup"] as const) {
    const r = rig({ [key]: async () => { throw new Error("secret raw details"); } });
    await r.provision(); r.events.length = 0; await assert.rejects(() => r.run("--cleanup-owned-fixture"));
    assert(!r.memory.has(`${base}/complete.json`)); assert(r.memory.has(`${base}/failed.json`));
    if (key !== "cleanup") assert(!r.events.includes("cleanup"));
    await assert.rejects(r.run);
    assert(!JSON.stringify(r.memory.get(`${base}/failed.json`)).includes("secret raw details"));
  }
});
test("connection identity failure destroys its own socket and does not provision", async () => {
  const r = rig({ verifyConnection: async () => { throw new Error(); } });
  await assert.rejects(r.provision); assert(r.events.includes("destroy")); assert(!r.events.includes("provision"));
});
test("drain failure is not certified as success", async () => {
  const connection: MysqlAuthWireConnection = { execute: async () => [[], []], query: async () => [[], []], beginTransaction: async () => {},
    commit: async () => {}, rollback: async () => {}, end: async () => { throw new Error(); }, destroy: () => {} };
  const r = rig({ connect: async () => connection }); await assert.rejects(r.provision);
  assert(!r.memory.has(`${base}/provisioned.json`)); assert(r.memory.has(`${base}/provision-failed.json`));
});
