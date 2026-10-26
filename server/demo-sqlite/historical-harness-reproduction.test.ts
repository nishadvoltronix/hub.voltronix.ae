import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { preservedPath } from "../../tools/preservation-paths.mjs";
import test from "node:test";
import { originalWorkerStatusOptions, reproduceHistoricalPmLabelFailure } from "./historical-harness-reproduction.js";
import { sourceWorkerStatusLabels } from "./source-worker-status-labels.js";

const source = readFileSync(preservedPath(fileURLToPath(new URL("../../", import.meta.url)), "application/views/Jobs/Job_Details_User.php"), "utf8");
function receipt() {
  return { status: "FAIL", checks: [...Array.from({ length: 22 }, (_, index) => ({ name: `Synthetic previous pass ${index}`, status: "PASS" })),
    { name: "User 8: PM recorded details and original status labels", status: "FAIL" }],
    diagnostic: "Expected values to be strictly equal:\n+ actual - expected\n\n+ 'Completed'\n- 'COMPLETED'\n" };
}
test("retained PM assertion reproduction expects the old harness to fail and corrected source mapping to pass", () => {
  const failed = receipt(), before = JSON.stringify(failed);
  const result = reproduceHistoricalPmLabelFailure(failed, source);
  assert.equal(result.oldAssertionResult, "EXPECTED FAIL"); assert.equal(result.correctedMappingResult, "PASS");
  assert.equal(result.historicalStatus, "FAIL"); assert.equal(result.departments.length, 5);
  assert.equal(JSON.stringify(failed), before);
});
test("five original PHP controls distinguish exact completion values and department-specific display case", () => {
  const options = originalWorkerStatusOptions(source);
  for (const [department, value, label] of [["Civil", "Completed", "COMPLETED"], ["PM", "Completed", "Completed"],
    ["Switchgear", "Completed", "Completed"], ["Maintenance", "Complete", "Complete"], ["Electrical", "Complete", "COMPLETE"]] as const) {
    const original = options[department]!.find(option => option.value === value)!;
    assert.equal(original.label, sourceWorkerStatusLabels(department)[value]);
    assert.equal(original.label, label);
  }
});
test("reproduction rejects unrelated/rewritten failures and refuses changed PHP label evidence", () => {
  for (const change of [
    (value: ReturnType<typeof receipt>) => { value.status = "PASS"; },
    (value: ReturnType<typeof receipt>) => { value.checks.at(-1)!.name = "Different failure"; },
    (value: ReturnType<typeof receipt>) => { value.diagnostic = "Different diagnostic"; },
    (value: ReturnType<typeof receipt>) => { value.checks[0]!.status = "FAIL"; },
  ]) { const value = receipt(); change(value); assert.throws(() => reproduceHistoricalPmLabelFailure(value, source)); }
  assert.throws(() => reproduceHistoricalPmLabelFailure(receipt(), source.replace(/(<option value="Completed">)Completed(<\/option>)/g, "$1COMPLETED$2")));
});
