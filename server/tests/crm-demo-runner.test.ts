import assert from "node:assert/strict";
import test from "node:test";
import { createCrmDemoHarness, type CrmDemoEffects } from "../scripts/crm-demo/runner.js";
import { acknowledgement, CrmDemoRefusal, targetFor } from "../scripts/crm-demo/guard.js";
import type { MysqlWireConnection } from "../src/crm/db/mysql/driver.js";
import { mysqlMigrations } from "../src/crm/db/mysql/migrations.js";
import { expectedCrmDemoChecks } from "../scripts/crm-demo/cases.js";

const fixtureId = "12345678-1234-4234-8234-123456789abc", serverUuid = "12345678-1234-1234-8234-123456789abc";
const target = targetFor(fixtureId), base = `.local-data/test/crm-demo-${fixtureId}`, digest = "a".repeat(64);
const timestamp = Date.parse("2026-10-10T10:00:00Z"), approvalPath = `.local-data/approvals/crm-demo-${fixtureId}.json`;
const operatorPath = ".local-data/operators/mysql-auth-operator.json";
function rig(overrides: Partial<CrmDemoEffects> = {}) {
  const memory = new Map<string, unknown>(), events: string[] = [];
  memory.set(approvalPath, { version: 1, fixtureId, target, approved: true, approvalReference: "Offline fixture approval only",
    validFrom: "2026-10-10T09:59:00Z", validUntil: "2026-10-10T11:00:00Z", serverUuid, harnessDigest: digest,
    exclusiveOperatorWindow: true, scopes: { provision: true, migrate: true, syntheticWrites: true, authentication: true, crmWorkflows: true, http: true, chromium: false, retainDemoAccess: false } });
  memory.set(operatorPath, { provider: "mysql", environment: "development", host: "127.0.0.1", port: 3308,
    database: "crm_local_dev", user: "root", password: "offline-only-secret" });
  const files = { operatorPath, approvalPath: () => approvalPath, fixtureRoot: () => base,
    exists: (path: string) => memory.has(path),
    read: (path: string) => { if (!memory.has(path)) throw new CrmDemoRefusal("STATE"); return structuredClone(memory.get(path)); },
    writeNew: (path: string, value: unknown) => { if (memory.has(path)) throw new CrmDemoRefusal("STATE"); events.push(`file:${path.split("/").at(-1)}`); memory.set(path, structuredClone(value)); },
    ensureContainer: () => {}, createFixture: () => { if (memory.has(base)) throw new CrmDemoRefusal("OWNERSHIP"); memory.set(base, true); return base; } };
  let applied = 0, secrets = 0;
  const wire = (): MysqlWireConnection => ({ query: async () => [[], []], execute: async () => [[], []],
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {},
    end: async () => { events.push("end"); }, destroy: () => { events.push("destroy"); } });
  const effects: CrmDemoEffects = {
    connect: async config => { events.push(`connect:${config.user === "root" ? "operator" : config.user.slice(0, 6)}`); return wire(); },
    verifyConnection: async () => { events.push("pinned-identity"); }, observe: async () => { events.push("observe"); return { serverUuid }; },
    provision: async () => { events.push("provision"); }, scoped: async () => { events.push("scoped"); }, grants: async () => { events.push("grants"); },
    migrate: async () => { events.push("migrate"); return applied++ === 0 ? mysqlMigrations.length : 0; },
    verifySchema: async () => { events.push("empty-schema"); }, verifyRuntime: async () => { events.push("runtime"); },
    createFixture: async () => { events.push("fixture"); return {} as Awaited<ReturnType<CrmDemoEffects["createFixture"]>>; },
    cases: async options => { events.push("cases"); for (let index = 0; index < expectedCrmDemoChecks; index++) options.record(`synthetic repository check ${index}`, "mysql"); return expectedCrmDemoChecks; },
    http: async options => { events.push("http"); for (let index = 0; index < 5; index++) options.record(`synthetic HTTP check ${index}`, "http"); return 5; },
    chromium: async options => { events.push("chromium"); for (let index = 0; index < 6; index++) options.record(`synthetic browser check ${index}`, "chromium"); return 6; },
    demoAccess: () => ({ email: "synthetic@example.invalid", password: "synthetic-retained-secret", marker: "synthetic-marker", database: target.database, fixtureId }),
    createRuntime: () => { throw new Error("Unexpected runtime construction"); }, ...overrides,
  };
  const execute = createCrmDemoHarness({ files, effects, digest: () => digest, now: () => timestamp, uuid: () => fixtureId,
    secret: () => String(++secrets).repeat(64), owner: () => "b".repeat(64) });
  const provision = () => execute(["provision", "--fixture-id", fixtureId, acknowledgement]);
  const run = (...flags: string[]) => execute(["run", "--fixture-id", fixtureId, acknowledgement, ...flags]);
  return { memory, events, execute, provision, run };
}
function change(r: ReturnType<typeof rig>, path: string, values: Record<string, unknown>) {
  r.memory.set(path, { ...(r.memory.get(path) as Record<string, unknown>), ...values });
}
test("OFFLINE CRM plan creates one false approval only, no operator or connections, and never overwrites", async () => {
  const r = rig(); r.memory.delete(approvalPath); r.memory.delete(operatorPath);
  assert.equal((await r.execute(["plan"])).status, "PLAN_ONLY");
  assert.equal((r.memory.get(approvalPath) as {approved:boolean}).approved, false);
  assert.deepEqual(r.events, [`file:crm-demo-${fixtureId}.json`]); assert.equal(r.memory.has(operatorPath), false);
  await assert.rejects(() => r.execute(["plan"]));
});
test("OFFLINE CRM diagnosis performs zero effects and does not claim live verification", async () => {
  const r = rig(); assert.equal((await r.execute(["diagnose", "--fixture-id", fixtureId])).status, "OFFLINE_CONFIGURATION_PASS");
  assert.equal(r.events.length, 0);
});
test("OFFLINE CRM missing approval wrong target/profile source drift expiry or scopes refuse before mutations", async () => {
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
test("OFFLINE CRM existing private fixture cannot be adopted", async () => {
  const r = rig(); r.memory.set(base, true); await assert.rejects(r.provision); assert.equal(r.events.length, 0);
});
test("OFFLINE CRM provision orders ownership DDL idempotence grants drain and receipts, disables runtime candidate", async () => {
  const r = rig(); assert.equal((await r.provision()).status, "PROVISIONED");
  assert.ok(r.events.indexOf("file:ownership.json") < r.events.indexOf("connect:operator"));
  assert.ok(r.events.indexOf("provision") < r.events.indexOf("migrate"));
  assert.ok(r.events.lastIndexOf("migrate") < r.events.indexOf("grants"));
  assert.ok(r.events.lastIndexOf("end") < r.events.indexOf("file:provisioned.json"));
  assert.equal(r.events.filter(value => value === "migrate").length, 2);
  assert.equal((r.memory.get(`${base}/runtime-configuration.json`) as {approval:{approved:boolean}}).approval.approved, false);
  assert.ok(!r.events.includes("fixture"));
});
test("OFFLINE CRM server mismatch or insufficient grants fails closed retaining the claimed target", async () => {
  for (const overrides of [{ observe: async () => ({ serverUuid: "wrong" }) }, { scoped: async () => { throw new Error("private grants"); } }]) {
    const r = rig(overrides); await assert.rejects(r.provision, CrmDemoRefusal);
    assert.ok(r.memory.has(`${base}/provision-failed.json`)); assert.ok(!r.memory.has(`${base}/provisioned.json`));
  }
});
test("OFFLINE CRM DDL and migration failures never retry clean up or issue success", async () => {
  for (const overrides of [{ provision: async () => { throw new Error("private DDL details"); } }, { migrate: async () => 0 }]) {
    const r = rig(overrides); await assert.rejects(r.provision, error => error instanceof CrmDemoRefusal && !error.message.includes("private"));
    await assert.rejects(r.provision); assert.equal(r.events.filter(value => value === "connect:operator").length, 1);
    assert.ok(!r.memory.has(`${base}/provisioned.json`)); assert.ok(!r.events.includes("fixture"));
  }
});
test("OFFLINE CRM run rejects missing ownership receipt or changed profile before connection", async () => {
  for (const name of ["ownership.json", "provisioned.json", "runtime.json", "migration.json", "fixture.json"]) {
    const r = rig(); await r.provision(); r.events.length = 0;
    if (["runtime.json", "migration.json", "fixture.json"].includes(name)) change(r, `${base}/${name}`, { password: "changed" });
    else r.memory.delete(`${base}/${name}`);
    await assert.rejects(r.run); assert.equal(r.events.length, 0, name);
  }
});
test("OFFLINE CRM run claims one attempt, checks empty data before fixture, retains data and separates browser/recovery", async () => {
  const r = rig(); await r.provision(); r.events.length = 0; const result = await r.run();
  assert.equal(result.status, "PASS"); assert.ok(r.events.indexOf("file:attempt.json") < r.events.indexOf("connect:operator"));
  assert.ok(r.events.indexOf("empty-schema") < r.events.indexOf("fixture"));
  assert.equal((result as {chromium:string}).chromium, "NOT_RUN");
  assert.ok(!/offline-only-secret|password|cookie|token|serverUuid|harnessDigest/.test(JSON.stringify(result)));
  await assert.rejects(r.run); assert.equal(r.events.filter(value => value === "fixture").length, 1);
});
test("OFFLINE CRM run refuses unapproved data before synthetic writes and retains failed attempt", async () => {
  let calls = 0;
  const r = rig({ verifySchema: async () => { if (++calls > 2) throw new Error("unapproved data"); } });
  await r.provision(); r.events.length = 0; await assert.rejects(r.run);
  assert.ok(!r.events.includes("fixture")); assert.ok(r.memory.has(`${base}/failed.json`));
});
test("OFFLINE CRM workflow/HTTP failure retains every fixture and safe partial evidence", async () => {
  for (const key of ["cases", "http"] as const) {
    const r = rig({ [key]: async () => { throw new Error("private row detail"); } });
    await r.provision(); await assert.rejects(r.run, CrmDemoRefusal);
    assert.ok(r.memory.has(`${base}/failed.json`)); assert.ok(!r.memory.has(`${base}/complete.json`));
    assert.ok(!JSON.stringify(r.memory.get(`${base}/failed.json`)).includes("private row"));
    await assert.rejects(r.run);
  }
});
test("OFFLINE CRM approval revoked between stages prevents the next write stage", async () => {
  const r = rig({ provision: async () => { change(r, approvalPath, { approved: false }); } });
  await assert.rejects(r.provision, CrmDemoRefusal);
  assert.ok(!r.events.includes("migrate")); assert.ok(!r.events.includes("grants"));
  assert.ok(r.memory.has(`${base}/provision-failed.json`));
});
test("OFFLINE CRM zero checks or falsely reported totals cannot produce PASS", async () => {
  for (const overrides of [{ cases: async () => 0 }, { cases: async () => 1 }, { http: async () => 5 }]) {
    const r = rig(overrides); await r.provision(); await assert.rejects(r.run); assert.ok(!r.memory.has(`${base}/complete.json`));
  }
});
test("OFFLINE CRM unsupported cleanup reset and unapproved Chromium refuse before any file or wire effect", async () => {
  const r = rig();
  for (const args of [["reset"], ["run", "--fixture-id", fixtureId, acknowledgement, "--chromium"],
    ["run", "--fixture-id", fixtureId, acknowledgement, "--cleanup-owned-fixture"]]) await assert.rejects(() => r.execute(args));
  assert.equal(r.events.length, 0);
});

test("OFFLINE CRM approved optional Chromium requires all six checks and records separate evidence", async () => {
  const r = rig(); await r.provision();
  change(r, approvalPath, { scopes: { ...(r.memory.get(approvalPath) as {scopes:object}).scopes, chromium: true } });
  r.events.length = 0; const result = await r.run("--chromium");
  assert.equal((result as {chromium:string}).chromium, "PASS");
  assert.equal((result as {checks:unknown[]}).checks.length, expectedCrmDemoChecks + 5 + 6);
  assert.ok(r.events.indexOf("http") < r.events.indexOf("chromium"));
  assert.ok(!r.memory.has(`${base}/demo-access.json`));
});

test("OFFLINE CRM demo credentials are retained exclusively only after all approved tests and drain, never printed", async () => {
  const r = rig(); await r.provision();
  change(r, approvalPath, { scopes: { ...(r.memory.get(approvalPath) as {scopes:object}).scopes, retainDemoAccess: true } });
  r.events.length = 0; const result = await r.run("--retain-demo-access");
  assert.ok(r.events.indexOf("http") < r.events.indexOf("file:demo-access.json"));
  assert.ok(r.events.lastIndexOf("end") < r.events.indexOf("file:demo-access.json"));
  assert.ok(r.memory.has(`${base}/demo-access.json`));
  assert.equal((result as {demoAccessFile:string}).demoAccessFile, `${base}/demo-access.json`);
  assert.ok(!JSON.stringify(result).includes("synthetic-retained-secret"));
  assert.ok(!JSON.stringify(r.memory.get(`${base}/complete.json`)).includes("synthetic-retained-secret"));
});

test("OFFLINE CRM missing demo-access scope or failed checks cannot retain credentials", async () => {
  const missing = rig(); await missing.provision(); missing.events.length = 0;
  await assert.rejects(() => missing.run("--retain-demo-access")); assert.equal(missing.events.length, 0);
  for (const key of ["cases", "http", "chromium"] as const) {
    const r = rig({ [key]: async () => { throw new Error("synthetic-check-failure"); } }); await r.provision();
    change(r, approvalPath, { scopes: { ...(r.memory.get(approvalPath) as {scopes:object}).scopes, chromium: true, retainDemoAccess: true } });
    await assert.rejects(() => r.run("--chromium", "--retain-demo-access"));
    assert.ok(!r.memory.has(`${base}/demo-access.json`));
  }
});

test("OFFLINE CRM existing demo-access file is never overwritten even after successful checks", async () => {
  const r = rig(); await r.provision();
  change(r, approvalPath, { scopes: { ...(r.memory.get(approvalPath) as {scopes:object}).scopes, retainDemoAccess: true } });
  r.memory.set(`${base}/demo-access.json`, { original: true });
  await assert.rejects(() => r.run("--retain-demo-access"));
  assert.deepEqual(r.memory.get(`${base}/demo-access.json`), { original: true });
});
