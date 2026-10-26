import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backendRoot, privateDirectory, readPrivate, workspaceRoot, writePrivateNew } from "./storage.js";
import { sourceWorkerStatusLabels } from "./source-worker-status-labels.js";

const historicalDirectory = "remaining-parity-6095bae2-fd50-476e-b89c-a5e92e2394dd";
const historicalCanonicalSha256 = "d580b4065e44d61161facb3e25ea0eeb985ed6433b3f75cccf68223a72401593";
const pmFailure = "User 8: PM recorded details and original status labels";
const diagnostic = "Expected values to be strictly equal:\n+ actual - expected\n\n+ 'Completed'\n- 'COMPLETED'\n";
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
type HistoricalReceipt = { status: string; checks: { name: string; status: string }[]; diagnostic: string };
const statusFields = { Electrical: "Electric_Status", Civil: "Civil_Status", PM: "PM_Status", Switchgear: "Switchgear_Status", Maintenance: "Maintenance_Status" };

export function originalWorkerStatusOptions(source: string) {
  return Object.fromEntries(Object.entries(statusFields).map(([department, field]) => {
    const select = source.match(new RegExp(`<select[^>]*name="${field}"[^>]*>([\\s\\S]*?)<\\/select>`));
    assert.ok(select, `Missing original ${department} status control`);
    const options = [...select[1]!.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map(match => ({ value: match[1]!, label: match[2]! }));
    assert.ok(options.length > 0);
    return [department, [...new Map(options.map(option => [option.value, option])).values()]];
  }));
}

export function reproduceHistoricalPmLabelFailure(receipt: HistoricalReceipt, originalSource: string) {
  assert.equal(receipt.status, "FAIL");
  assert.equal(receipt.checks.filter(check => check.status === "PASS").length, 22);
  assert.deepEqual(receipt.checks.filter(check => check.status !== "PASS"), [{ name: pmFailure, status: "FAIL" }]);
  assert.equal(receipt.diagnostic, diagnostic);
  const options = originalWorkerStatusOptions(originalSource);
  const actual = options.PM!.find(option => option.value === "Completed")!.label;
  // This is an expected failure of the old assertion, not a passing old run.
  assert.throws(() => assert.equal(actual, "COMPLETED"), error => error instanceof assert.AssertionError && error.message === diagnostic);
  const departments = Object.entries(options).map(([department, choices]) => {
    const labels = sourceWorkerStatusLabels(department);
    const compared = choices.filter(option => labels[option.value] !== undefined);
    assert.ok(compared.length > 0);
    for (const option of compared) assert.equal(option.label, labels[option.value], `${department}: ${option.value}`);
    return { department, compared, status: "PASS" };
  });
  return { historicalStatus: "FAIL", historicalPassed: 22, historicalFailed: 1, oldAssertionResult: "EXPECTED FAIL",
    correctedMappingResult: "PASS", actualPmLabel: actual, erroneousGenericLabel: "COMPLETED", departments };
}

export function runHistoricalHarnessReproduction(args: readonly string[]) {
  assert.deepEqual(args, ["--read-only"]);
  const evidence = privateDirectory(["evidence"]), historicalPath = join(evidence, historicalDirectory, "receipt.json");
  const original = readFileSync(historicalPath), receipt = readPrivate(historicalPath) as HistoricalReceipt;
  assert.equal(digest(JSON.stringify(receipt)), historicalCanonicalSha256);
  const sourcePath = join(workspaceRoot, "application/views/Jobs/Job_Details_User.php"), source = readFileSync(sourcePath);
  const result = reproduceHistoricalPmLabelFailure(receipt, source.toString("utf8"));
  const harnessPath = join(backendRoot, "demo-sqlite/remaining-parity-browser.ts"), harness = readFileSync(harnessPath);
  assert.match(harness.toString("utf8"), /const labels = sourceWorkerStatusLabels\(identity\.department\);/);
  assert.ok(readFileSync(historicalPath).equals(original));
  assert.ok(readFileSync(sourcePath).equals(source));
  const directory = privateDirectory(["evidence", "historical-harness-reproduction-" + randomUUID()], true);
  const output = { status: "PASS", checkedAtUtc: new Date().toISOString(), scope: "Isolated PHP-source/assertion reproduction; no browser, database or authentication",
    checks: ["Original fixed receipt remains FAIL 22/1", "Old generic PM assertion reproduces the exact retained failure",
      "Corrected harness map matches all five original PHP status controls", "Original receipt and PHP bytes unchanged"].map(name => ({ name, status: "PASS" })),
    result, historicalReceipt: historicalPath, historicalReceiptSha256: digest(original), historicalCanonicalSha256,
    originalSource: sourcePath, originalSourceSha256: digest(source), currentHarnessSha256: digest(harness),
    databaseWrites: 0, authenticationAttempts: 0, browserLaunches: 0, historicalFailureReclassified: false };
  const outputPath = join(directory, "receipt.json"); writePrivateNew(outputPath, output);
  return { status: output.status, receipt: outputPath, passed: output.checks.length, failed: 0, historicalStatus: result.historicalStatus,
    oldAssertionResult: result.oldAssertionResult, databaseWrites: 0, authenticationAttempts: 0 };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(runHistoricalHarnessReproduction(process.argv.slice(2)))); }
  catch { console.error("Historical reproduction refused or failed; original receipts/source were not modified."); process.exitCode = 1; }
}
