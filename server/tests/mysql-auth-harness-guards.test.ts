import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { acknowledgement, HarnessRefusal, parseApproval, parseArguments, parseOwnership, parseProfile, parseReceipt,
  requireScopes, targetFor, type HarnessApproval, type Ownership, type RefusalCode } from "../scripts/mysql-auth/guard.js";
import { assertOrdinaryPath, canonicalJson, fingerprint, harnessDigest, HarnessFiles } from "../scripts/mysql-auth/files.js";
import { realHarness } from "../scripts/mysql-auth/runner.js";

// OFFLINE only. No profiles, databases, application hosts, browser or service are
// used. Files are synthetic JSON in exclusively owned temporary directories;
// native ACL verification is an injected policy seam, not a claimed host check.
const fixtureId = "00000000-0000-4000-8000-000000000011";
const otherId = "00000000-0000-4000-8000-000000000012";
const digest = "a".repeat(64), serverUuid = "12345678-1234-1234-1234-123456789012";
const now = Date.parse("2026-10-10T12:00:00.000Z");
function approvalInput(): HarnessApproval {
  return { version: 1, fixtureId, target: targetFor(fixtureId), approved: true, approvalReference: "Synthetic offline approval reference",
    validFrom: "2026-10-10T11:00:00.000Z", validUntil: "2026-10-10T13:00:00.000Z", serverUuid, harnessDigest: digest, exclusiveOperatorWindow: true,
    scopes: { provision: true, migrate: true, syntheticWrites: true, authentication: true, http: true, faultInjection: true, chromium: true, cleanupOwned: true } };
}
function ownershipInput(): Ownership {
  return { version: 1, fixtureId, target: targetFor(fixtureId), serverUuid, harnessDigest: digest, owner: "b".repeat(64), createdAt: "2026-10-10T12:00:00.000Z" };
}
function refusal(code: RefusalCode) {
  return (error: unknown) => error instanceof HarnessRefusal && error.code === code
    && error.message === "Isolated authentication verification refused; no fallback or automatic repair.";
}
function withFiles(work: (fixture: { root: string; files: HarnessFiles; privacyCalls: { path: string; fresh: boolean }[] }) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "crm-auth-harness-offline-"))), original = root;
  const privacyCalls: { path: string; fresh: boolean }[] = [];
  const files = new HarnessFiles(root, (path, fresh = false) => { privacyCalls.push({ path, fresh }); });
  try { work({ root, files, privacyCalls }); }
  finally {
    // Remove only this newly owned temporary root, never a computed workspace or
    // user path; native recursive removal does not follow directory junctions.
    assert.equal(isAbsolute(root), true);
    assert.equal(resolve(root), original);
    assert.equal(realpathSync(root), original);
    assert.equal(basename(root).startsWith("crm-auth-harness-offline-"), true);
    rmSync(root, { recursive: true, force: true });
  }
}

// Model a non-debug invocation without inheriting Node's test-worker inspector
// arguments. These scoped mocks never change an environment/configuration file.
function nonDebugProcess(t: TestContext) {
  t.mock.property(process, "env", { CRM_MYSQL_NETWORK_DISABLED: "1" });
  t.mock.property(process, "execArgv", []);
}

test("OFFLINE real harness accepts the entry-point root with a trailing separator before private operations", async t => {
  nonDebugProcess(t);
  // Use the same directory URL shape as the CLI. Hash only public package files;
  // stop at the first private operation without creating directories or profiles.
  const root = fileURLToPath(new URL("..", import.meta.url)), normalized = resolve(root);
  assert.equal(root, normalized + sep);
  const boundary = new Error("Synthetic stop before private directory operations");
  const container = t.mock.method(HarnessFiles.prototype, "ensureContainer", function(this: HarnessFiles, name: string) {
    assert.equal(this.root, normalized);
    assert.equal(name, ".local-data/approvals");
    throw boundary;
  });
  const write = t.mock.method(HarnessFiles.prototype, "writeNew", () => assert.fail("Unexpected private write"));
  const read = t.mock.method(HarnessFiles.prototype, "read", () => assert.fail("Unexpected private read"));
  try {
    await assert.rejects(realHarness(root)(["plan"]), error => error === boundary);
    assert.equal(container.mock.callCount(), 1);
    assert.equal(write.mock.callCount(), 0);
    assert.equal(read.mock.callCount(), 0);
  } finally { container.mock.restore(); write.mock.restore(); read.mock.restore(); }
});

test("OFFLINE real harness retains junction-root and outside-root refusal", t => withFiles(({ root }) => {
  nonDebugProcess(t);
  const destination = join(root, "public-package"), alias = join(root, "linked-package");
  mkdirSync(destination); symlinkSync(destination, alias, "junction");
  assert.throws(() => realHarness(alias + sep), refusal("PRIVATE_FILE"));
  assert.throws(() => assertOrdinaryPath(root, resolve(root, "..")), refusal("PRIVATE_FILE"));
}));

test("OFFLINE harness accepts explicit live acknowledgement only for provision/run modes", () => {
  assert.deepEqual(parseArguments(["plan"]), { mode: "plan", chromium: false, cleanup: false });
  assert.deepEqual(parseArguments(["diagnose", "--fixture-id", fixtureId]), { mode: "diagnose", fixtureId, chromium: false, cleanup: false });
  assert.deepEqual(parseArguments(["provision", "--fixture-id", fixtureId, acknowledgement]), { mode: "provision", fixtureId, chromium: false, cleanup: false });
  assert.deepEqual(parseArguments(["run", acknowledgement, "--fixture-id", fixtureId, "--chromium", "--cleanup-owned-fixture"]),
    { mode: "run", fixtureId, chromium: true, cleanup: true });
});

test("OFFLINE harness refuses missing opt-in, ambiguous flags, uncontrolled targets and unsupported commands", () => {
  const variants = [[], ["start"], ["plan", "--fixture-id", fixtureId], ["run"], ["provision", "--fixture-id", fixtureId],
    ["run", "--fixture-id", fixtureId], ["diagnose", "--fixture-id", fixtureId, acknowledgement],
    ["provision", "--fixture-id", fixtureId, acknowledgement, "--chromium"],
    ["diagnose", "--fixture-id", fixtureId, "--cleanup-owned-fixture"],
    ["run", "--fixture-id", fixtureId, acknowledgement, acknowledgement],
    ["run", "--fixture-id", fixtureId, acknowledgement, "--fixture-id", otherId],
    ["run", "--fixture-id", fixtureId, acknowledgement, "--host", "localhost"],
    ["run", "--fixture-id", fixtureId, acknowledgement, "--chromium", "--chromium"],
    ["run", acknowledgement, "--fixture-id"], ["run", acknowledgement, "--fixture-id", fixtureId, "--cleanup"]];
  for (const args of variants) assert.throws(() => parseArguments(args), refusal("ARGUMENTS"));
  assert.throws(() => parseArguments(["run", acknowledgement, "--fixture-id", "crm_local_dev"]), refusal("TARGET"));
});

test("OFFLINE UUID target derivation is fixed, immutable and cannot select old app or browser schemas", () => {
  const target = targetFor(fixtureId);
  assert.equal(target.host, "127.0.0.1"); assert.equal(target.port, 3308);
  assert.equal(target.database, "crm_local_auth_00000000000040008000000000000011");
  assert.equal(target.runtimeUser, "auth_r_000000000000400080000000");
  assert.equal(Object.isFrozen(target), true);
  for (const id of ["", "../" + fixtureId, fixtureId.toUpperCase().replace("00000011", "ABCDEF11"), fixtureId.replace("4000", "3000"),
    fixtureId.replace("8000", "7000"), "crm_local_dev", fixtureId + "\n"]) assert.throws(() => targetFor(id), refusal("TARGET"));
});

test("OFFLINE approval binds exact target, fixture, source digest and a bounded current time window", () => {
  assert.equal(parseApproval(approvalInput(), fixtureId, digest, now).approved, true);
  const variants: unknown[] = [null, {}, { ...approvalInput(), approved: false }, { ...approvalInput(), exclusiveOperatorWindow: false },
    { ...approvalInput(), fixtureId: otherId }, { ...approvalInput(), harnessDigest: "c".repeat(64) },
    { ...approvalInput(), target: { ...targetFor(fixtureId), host: "localhost" } },
    { ...approvalInput(), target: { ...targetFor(fixtureId), port: 3306 } },
    { ...approvalInput(), target: { ...targetFor(fixtureId), database: "crm_local_dev" } },
    { ...approvalInput(), target: { ...targetFor(fixtureId), runtimeUser: targetFor(fixtureId).migrationUser } },
    { ...approvalInput(), serverUuid: "not-approved" }, { ...approvalInput(), approvalReference: "ref\nunsafe" },
    { ...approvalInput(), extra: true }, { ...approvalInput(), scopes: { ...approvalInput().scopes, globalPrivileges: true } },
    { ...approvalInput(), validFrom: "2026-10-10T12:00:00.001Z" }, { ...approvalInput(), validUntil: "2026-10-10T12:00:00.000Z" },
    { ...approvalInput(), validFrom: "2026-10-09T10:59:59.999Z" }, { ...approvalInput(), validUntil: "not-a-date" }];
  for (const value of variants) assert.throws(() => parseApproval(value, fixtureId, digest, now), refusal("APPROVAL"));
  for (const time of [NaN, Infinity, -Infinity]) assert.throws(() => parseApproval(approvalInput(), fixtureId, digest, time), refusal("APPROVAL"));
  assert.throws(() => parseApproval(approvalInput(), fixtureId, "d".repeat(64), now), refusal("APPROVAL"));
  const atStart = Date.parse(approvalInput().validFrom);
  assert.equal(parseApproval(approvalInput(), fixtureId, digest, atStart).approved, true);
});

test("OFFLINE scopes require approval for each provisioning and write/browser/cleanup action", () => {
  const provision = parseArguments(["provision", "--fixture-id", fixtureId, acknowledgement]);
  const run = parseArguments(["run", "--fixture-id", fixtureId, acknowledgement, "--chromium", "--cleanup-owned-fixture"]);
  requireScopes(approvalInput(), provision); requireScopes(approvalInput(), run);
  for (const key of ["provision", "migrate"] as const) {
    const approval = approvalInput(); approval.scopes[key] = false;
    assert.throws(() => requireScopes(approval, provision), refusal("APPROVAL"));
  }
  for (const key of ["syntheticWrites", "authentication", "http", "faultInjection", "chromium", "cleanupOwned"] as const) {
    const approval = approvalInput(); approval.scopes[key] = false;
    assert.throws(() => requireScopes(approval, run), refusal("APPROVAL"));
  }
  const minimal = approvalInput(); minimal.scopes.chromium = false; minimal.scopes.cleanupOwned = false;
  requireScopes(minimal, parseArguments(["run", "--fixture-id", fixtureId, acknowledgement]));
});

test("OFFLINE profiles bind dedicated identity and refuse SQLite, wrong host/port/database or role reuse", () => {
  const target = targetFor(fixtureId);
  const make = (kind: "runtime" | "migration" | "fixture") => ({ provider: "mysql", environment: "test", host: "127.0.0.1", port: 3308,
    database: target.database, user: target[`${kind}User`], password: "Synthetic-offline-profile-value" });
  for (const kind of ["runtime", "migration", "fixture"] as const) {
    const config = parseProfile(make(kind), target, kind);
    assert.equal(config.user, target[`${kind}User`]); assert.equal(Object.isFrozen(config), true);
  }
  const operator = { ...make("fixture"), environment: "development", database: "crm_local_dev", user: "root" };
  assert.equal(parseProfile(operator, target, "operator").user, "root");
  for (const changes of [{ provider: "sqlite" }, { host: "localhost" }, { host: "192.0.2.1" }, { port: 3306 },
    { environment: "development", database: "crm_local_dev" }, { database: targetFor(otherId).database },
    { user: target.migrationUser }, { user: "root" }, { password: "" }, { extra: "ignored-profile-key" }]) {
    assert.throws(() => parseProfile({ ...make("runtime"), ...changes }, target, "runtime"), refusal("TARGET"));
  }
  assert.throws(() => parseProfile(make("runtime"), target, "operator"), refusal("TARGET"));
  assert.throws(() => parseProfile({ ...operator, user: "migration" }, target, "operator"), refusal("TARGET"));
});

test("OFFLINE ownership markers bind approval identity and creation time before any fixture mutation", () => {
  const approval = approvalInput();
  assert.equal(parseOwnership(ownershipInput(), approval).fixtureId, fixtureId);
  for (const changes of [{ owner: "short" }, { owner: "b".repeat(64) + "\n" }, { fixtureId: otherId },
    { serverUuid: "12345678-1234-1234-1234-123456789013" }, { harnessDigest: "c".repeat(64) },
    { target: targetFor(otherId) }, { createdAt: "2026-10-10T10:59:59.999Z" }, { createdAt: approval.validUntil },
    { createdAt: "invalid" }, { extra: true }]) assert.throws(() => parseOwnership({ ...ownershipInput(), ...changes }, approval), refusal("OWNERSHIP"));
  assert.equal(parseOwnership({ ...ownershipInput(), createdAt: approval.validFrom }, approval).createdAt, approval.validFrom);
});

test("OFFLINE completed provisioning receipt binds owner, server, profiles and migration idempotence", () => {
  const owned = ownershipInput(), profiles = { runtime: "r".repeat(64), migration: "m".repeat(64), fixture: "f".repeat(64) };
  const receipt = { version: 1, owner: owned.owner, fixtureId, serverUuid, phase: "provisioned", migrationApplied: 1, migrationRepeat: 0, profiles };
  assert.equal(parseReceipt(receipt, owned, profiles).phase, "provisioned");
  for (const changes of [{ owner: "c".repeat(64) }, { fixtureId: otherId }, { serverUuid: "12345678-1234-1234-1234-123456789013" },
    { phase: "attempted" }, { migrationApplied: 0 }, { migrationRepeat: 1 }, { profiles: { ...profiles, runtime: profiles.fixture } }, { extra: true }]) {
    assert.throws(() => parseReceipt({ ...receipt, ...changes }, owned, profiles), refusal("OWNERSHIP"));
  }
});

test("OFFLINE files allow only contained private paths and fresh exclusive fixture creation", () => withFiles(({ root, files, privacyCalls }) => {
  assert.equal(files.exists(files.approvalPath(fixtureId)), false);
  const relativeRoot = files.createFixture(fixtureId);
  assert.equal(relativeRoot, `.local-data/test/mysql-auth-${fixtureId}`);
  assert.equal(files.exists(relativeRoot), true);
  assert.throws(() => files.createFixture(fixtureId), refusal("OWNERSHIP"));
  for (const name of [".env.local", "../nextjs/.env.local", ".local-data/test/../../outside", ".local-data/test\\outside", "G:/outside",
    ".local-data/test", ".local-data/operators/x:stream", ".local-data/test/embedded\0name"]) assert.throws(() => files.path(name), refusal("PRIVATE_FILE"));
  assert.throws(() => assertOrdinaryPath(root, resolve(root, "..")), refusal("PRIVATE_FILE"));
  assert.equal(privacyCalls.filter(call => call.fresh).length, 3);
  files.ensureContainer(".local-data/test");
  assert.equal(privacyCalls.filter(call => call.fresh).length, 3);
}));

test("OFFLINE private files are canonical, bounded and cannot overwrite existing evidence", () => withFiles(({ files }) => {
  files.ensureContainer(".local-data/approvals"); const path = files.approvalPath(fixtureId);
  files.writeNew(path, { synthetic: true });
  assert.deepEqual(files.read(path), { synthetic: true });
  assert.equal(readFileSync(files.path(path), "utf8"), canonicalJson({ synthetic: true }));
  assert.throws(() => files.writeNew(path, { replaced: true }), refusal("STATE"));
  assert.deepEqual(files.read(path), { synthetic: true });
  const tooLarge = files.approvalPath(otherId);
  assert.throws(() => files.writeNew(tooLarge, { synthetic: "x".repeat(16_384) }), refusal("STATE"));
  assert.equal(files.exists(tooLarge), false);
}));

test("OFFLINE reader refuses duplicate keys, ambiguous JSON, malformed or oversized content and hardlinks", () => withFiles(({ files }) => {
  files.ensureContainer(".local-data/approvals"); const path = files.approvalPath(fixtureId), disk = files.path(path);
  for (const content of ['{"a":1,"a":2}', '{"a":1}', "null trailing", "\uFEFF{}", "x".repeat(16_385)]) {
    writeFileSync(disk, content, { mode: 0o600 }); assert.throws(() => files.read(path), refusal("PRIVATE_FILE"));
  }
  writeFileSync(disk, canonicalJson({ synthetic: true }).replaceAll("\n", "\r\n"));
  assert.deepEqual(files.read(path), { synthetic: true });
  const second = files.path(files.approvalPath(otherId)); linkSync(disk, second);
  assert.throws(() => files.read(path), refusal("PRIVATE_FILE"));
  assert.throws(() => files.read(files.approvalPath(otherId)), refusal("PRIVATE_FILE"));
}));

test("OFFLINE junction ancestors are refused before private reads/writes and existing-file aliases", () => withFiles(({ root, files }) => {
  files.ensureContainer(".local-data/test");
  const destination = join(root, "synthetic-junction-target"); mkdirSync(destination);
  writeFileSync(join(destination, "record.json"), canonicalJson({ synthetic: true }));
  symlinkSync(destination, files.path(".local-data/test/junction"), "junction");
  assert.throws(() => files.read(".local-data/test/junction/record.json"), refusal("PRIVATE_FILE"));
  assert.throws(() => files.exists(".local-data/test/junction/record.json"), refusal("PRIVATE_FILE"));
  assert.throws(() => files.writeNew(".local-data/test/junction/new.json", { synthetic: true }), refusal("STATE"));
  assert.equal(existsSync(join(destination, "new.json")), false);
}));

test("OFFLINE injected privacy failures stop before credential content and never modify existing policy", () => withFiles(({ root, files }) => {
  files.ensureContainer(".local-data/operators");
  const existing = files.operatorPath; files.writeNew(existing, { synthetic: true });
  const rejecting = new HarnessFiles(root, () => { throw new Error("Synthetic private ACL diagnostic"); });
  assert.throws(() => rejecting.read(existing), refusal("PRIVATE_FILE"));
  assert.throws(() => rejecting.writeNew(".local-data/operators/new.json", { synthetic: true }), refusal("STATE"));
  assert.equal(existsSync(files.path(".local-data/operators/new.json")), false);
  assert.deepEqual(files.read(existing), { synthetic: true });
  const attempts: boolean[] = [];
  const inspectionOnly = new HarnessFiles(root, (_path, fresh = false) => { attempts.push(fresh); });
  inspectionOnly.ensureContainer(".local-data/operators");
  assert.deepEqual(attempts, [false, false]);
}));

test("OFFLINE private file policy cannot bypass an unprotected local-data ancestor", () => withFiles(({ root, files }) => {
  files.ensureContainer(".local-data/operators"); files.writeNew(files.operatorPath, { synthetic: true });
  const ancestor = join(root, ".local-data"), inspected: string[] = [];
  const rejectingAncestor = new HarnessFiles(root, path => {
    inspected.push(path);
    if (path === ancestor) throw new Error("Synthetic ancestor policy refusal");
  });
  assert.throws(() => rejectingAncestor.read(files.operatorPath), refusal("PRIVATE_FILE"));
  assert.deepEqual(inspected, [ancestor]);
  inspected.length = 0;
  assert.throws(() => rejectingAncestor.writeNew(".local-data/operators/new.json", { synthetic: true }), refusal("STATE"));
  assert.deepEqual(inspected, [ancestor]);
  assert.equal(existsSync(files.path(".local-data/operators/new.json")), false);
  assert.deepEqual(files.read(files.operatorPath), { synthetic: true });
}));

test("OFFLINE canonical fingerprints and source digest bind retained content without printing values", () => withFiles(({ root }) => {
  assert.equal(canonicalJson({ version: 1 }), '{\n  "version": 1\n}\n');
  assert.equal(fingerprint({ version: 1 }) === fingerprint({ version: 1 }), true);
  assert.equal(fingerprint({ version: 1 }) === fingerprint({ version: 2 }), false);
  const server = join(root, "server"); mkdirSync(server);
  for (const path of ["src", "scripts", "tests"]) { mkdirSync(join(server, path)); writeFileSync(join(server, path, "synthetic.ts"), "export {};\n"); }
  for (const path of ["package.json", "package-lock.json", "tsconfig.server.json", "tsconfig.server.build.json"]) writeFileSync(join(root, path), "{}\n");
  const initial = harnessDigest(server);
  assert.equal(harnessDigest(server) === initial, true);
  writeFileSync(join(server, "scripts", "synthetic.ts"), "export const synthetic = true;\n");
  assert.equal(harnessDigest(server) === initial, false);
  const changed = harnessDigest(server);
  writeFileSync(join(root, "tsconfig.server.json"), '{"compilerOptions":{}}\n');
  assert.equal(harnessDigest(server) === changed, false);
  linkSync(join(root, "package.json"), join(server, "src", "linked.json"));
  assert.throws(() => harnessDigest(server), refusal("PRIVATE_FILE"));
}));
