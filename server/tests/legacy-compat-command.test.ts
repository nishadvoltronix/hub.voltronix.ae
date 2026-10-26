import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { LegacyInspectionError, legacySnapshotByteLimit, legacySnapshotPath, readLegacySnapshot,
  runLegacyInspection } from "../scripts/legacy-compat/command.js";
import { syntheticChildEnvironment } from "./helpers/child-environment.js";

function temporary(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "crm-offline-legacy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, legacySnapshotPath);
  mkdirSync(dirname(path), { recursive: true });
  return { root, path };
}
function redacted(error: unknown): boolean {
  assert.ok(error instanceof LegacyInspectionError);
  assert.doesNotMatch(error.message, /synthetic-private-marker|password|token-value/);
  assert.equal(error.cause, undefined);
  return true;
}

test("OFFLINE plans and argument refusals never request a file or connection", () => {
  let reads = 0;
  const refuseRead = () => { reads++; throw new Error("synthetic-private-marker"); };
  for (const mode of ["plan", "queries"]) {
    const result = runLegacyInspection([mode], refuseRead);
    assert.equal(result.exitCode, 0);
    assert.match(JSON.stringify(result.output), /ONLY/);
  }
  for (const args of [[], ["connect"], ["apply"], ["assess", "arbitrary-file"], ["plan", "--password=synthetic-private-marker"]]) {
    const result = runLegacyInspection(args, refuseRead);
    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(JSON.stringify(result.output), /synthetic-private-marker/);
  }
  assert.equal(reads, 0);
});

test("OFFLINE assessment sanitizes missing, invalid and secret-bearing input errors", () => {
  for (const read of [() => { throw new Error("synthetic-private-marker"); }, () => ({ password: "synthetic-private-marker" })]) {
    const result = runLegacyInspection(["assess"], read);
    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(JSON.stringify(result.output), /synthetic-private-marker/);
  }
});

test("OFFLINE reader inspects private ancestors/file and leaves canonical input unchanged", t => {
  const { root, path } = temporary(t), value = { synthetic: true };
  const bytes = JSON.stringify(value, null, 2).replace(/\n/g, "\r\n") + "\r\n";
  writeFileSync(path, bytes);
  const before = statSync(path), privacy: string[] = [];
  assert.deepEqual(readLegacySnapshot(root, path => { privacy.push(path); }), value);
  assert.deepEqual(privacy, [join(root, ".local-data"), join(root, ".local-data/operators"), path]);
  assert.equal(readFileSync(path, "utf8"), bytes);
  assert.equal(statSync(path).mtimeMs, before.mtimeMs);
});

test("OFFLINE reader rejects failed privacy inspection without automatically changing permissions", t => {
  const { root, path } = temporary(t);
  writeFileSync(path, "{}\n");
  assert.throws(() => readLegacySnapshot(root, () => { throw new Error("synthetic-private-marker"); }), redacted);
  assert.equal(readFileSync(path, "utf8"), "{}\n");
});

test("OFFLINE reader rejects duplicate keys, noncanonical, malformed and oversized files", t => {
  const { root, path } = temporary(t);
  for (const source of ["", "not-json", '{"synthetic":true}', '{\n  "a": 1,\n  "a": 2\n}', "{\"synthetic-private-marker\":"] ) {
    writeFileSync(path, source);
    assert.throws(() => readLegacySnapshot(root, () => {}), redacted);
  }
  truncateSync(path, legacySnapshotByteLimit + 1);
  assert.throws(() => readLegacySnapshot(root, () => {}), redacted);
});

test("OFFLINE reader refuses hard links and directory/file confusion", t => {
  const { root, path } = temporary(t);
  writeFileSync(path, "{}\n");
  linkSync(path, join(root, "second-link.json"));
  assert.throws(() => readLegacySnapshot(root, () => {}), redacted);
  const directoryFixture = temporary(t);
  mkdirSync(directoryFixture.path);
  assert.throws(() => readLegacySnapshot(directoryFixture.root, () => {}), redacted);
});

test("OFFLINE CLI works from an unrelated cwd without loading its dotenv or runtime settings", t => {
  const { root } = temporary(t);
  writeFileSync(join(root, ".env"), "INVALID_CONFIG=synthetic-private-marker\n");
  const checker = fileURLToPath(new URL("../scripts/check-legacy.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), checker, "plan"], {
    cwd: root, env: syntheticChildEnvironment({ CRM_MYSQL_NETWORK_DISABLED: "1", CRM_RUNTIME_SOURCE: "synthetic-private-marker" }),
    encoding: "utf8", timeout: 20_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /synthetic-private-marker/);
  const output = JSON.parse(result.stdout) as { status: string; deploymentReady: boolean };
  assert.equal(output.status, "PREPARATION_ONLY");
  assert.equal(output.deploymentReady, false);
});
