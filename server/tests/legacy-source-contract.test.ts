import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceContract, sourceContractEvidence } from "../scripts/legacy-compat/source-contract.js";

function entry(table: string) {
  const result = sourceContract.find(value => value.table === table);
  assert.ok(result, `Missing source inventory for ${table}`);
  return result;
}

test("source inventory never claims recovered DDL, full schema or runtime compatibility", () => {
  assert.equal(sourceContractEvidence.kind, "source-reference");
  assert.equal(sourceContractEvidence.authoritativeDdl, false);
  assert.equal(sourceContractEvidence.completeSchema, false);
  assert.equal(sourceContractEvidence.runtimeCompatibilityVerified, false);
  assert.ok(sourceContractEvidence.unknowns.some(value => /password algorithm/.test(value)));
  assert.ok(sourceContractEvidence.unknowns.some(value => /transaction\/locking/.test(value)));
  assert.ok(sourceContractEvidence.unknowns.some(value => /nullability/.test(value)));
  assert.ok(sourceContractEvidence.unknowns.some(value => /deployed PHP revision/.test(value)));
});

test("essential source entries have unique identifier-only columns and logical PHP references", () => {
  assert.equal(sourceContract.length, 20);
  assert.equal(new Set(sourceContract.map(value => value.table)).size, sourceContract.length);
  for (const value of sourceContract) {
    assert.match(value.table, /^[a-z][a-z_]*$/);
    assert.ok(value.columns.length > 0);
    assert.equal(new Set(value.columns).size, value.columns.length);
    for (const column of value.columns) assert.match(column, /^[A-Za-z_][A-Za-z_0-9]*$/);
    assert.ok(value.semantics.length > 0);
    assert.ok(value.sourceRefs.length > 0);
    for (const source of value.sourceRefs) {
      assert.match(source.file, /^application\/(controllers|models|libraries)\/[A-Za-z_][A-Za-z_0-9]*\.php$/);
      assert.ok(Number.isSafeInteger(source.line) && source.line > 0);
      assert.match(source.symbol, /^[A-Za-z_][A-Za-z_0-9]*$/);
      assert.doesNotMatch(source.file, /admincrm_old|config|schema\.sql/i);
      assert.doesNotMatch(source.symbol, /(?:\d|_old)$/);
    }
    assert.deepEqual(Object.keys(value).sort(), ["category", "columns", "semantics", "sourceRefs", "table"]);
  }
});

test("identity domains and legacy/new quotation storage stay distinct", () => {
  assert.ok(entry("users").columns.includes("id"));
  assert.ok(entry("users").columns.includes("user_id"));
  assert.match(entry("tasks").semantics, /assigned_to refers to users\.user_id, not users\.id/);
  assert.match(entry("job_attachments").semantics, /tasks\.zoho_crm_id, not the local task id/);
  assert.ok(entry("tasks").columns.includes("Assign_Department"));
  assert.ok(entry("tasks").columns.includes("subject"));
  assert.ok(entry("proposal_items").columns.includes("quote_number"));
  assert.equal(entry("proposal_items").columns.includes("quotation_id"), false);
  assert.equal(sourceContract.some(value => value.table === "crm_quotations"), false);
  assert.equal(sourceContract.some(value => value.table === "proposals"), false);
});

test("five legacy log tables and local payment assignment are not normalized by inventory", () => {
  assert.deepEqual(sourceContract.filter(value => value.category === "department-logs").map(value => value.table),
    ["electric", "civil", "pm", "switchgear", "maintenance"]);
  assert.ok(entry("electric").columns.includes("File"));
  assert.ok(entry("civil").columns.includes("Civil_File"));
  assert.ok(entry("pm").columns.includes("PM_Created_At"));
  assert.ok(entry("accounts").columns.includes("received_amount"));
  assert.match(entry("accounts").semantics, /NOT Zoho customer Accounts/);
  assert.equal(sourceContract.some(value => value.table === "crm_department_work_logs"), false);
});

test("legacy files and product cache do not inherit new runtime columns or tables", () => {
  assert.deepEqual(entry("task_attachment").columns, ["task_id", "user_id", "file_name", "created_at"]);
  for (const column of ["content", "content_sha256", "uploaded_by", "media_type"]) {
    assert.equal(entry("task_attachment").columns.includes(column), false);
  }
  assert.ok(entry("job_attachments").columns.includes("file_path"));
  assert.equal(sourceContract.some(value => value.table === "products"), false);
  assert.ok(entry("zoho_products").columns.includes("zoho_product_id"));
  assert.equal(sourceContract.some(value => value.table === "zoho_tokens"), false);
  assert.equal(sourceContract.some(value => value.columns.includes("version") || value.columns.includes("grants_version")), false);
});

test("inventory and provenance are deeply immutable", () => {
  assert.ok(Object.isFrozen(sourceContract));
  assert.ok(Object.isFrozen(sourceContractEvidence));
  assert.ok(Object.isFrozen(sourceContractEvidence.unknowns));
  for (const value of sourceContract) {
    assert.ok(Object.isFrozen(value));
    assert.ok(Object.isFrozen(value.columns));
    assert.ok(Object.isFrozen(value.sourceRefs));
    for (const source of value.sourceRefs) assert.ok(Object.isFrozen(source));
  }
  assert.equal(Reflect.set(entry("users"), "table", "different"), false);
  assert.equal(Reflect.set(entry("users").columns, "0", "different"), false);
  assert.equal(Reflect.set(sourceContractEvidence, "runtimeCompatibilityVerified", true), false);
});
