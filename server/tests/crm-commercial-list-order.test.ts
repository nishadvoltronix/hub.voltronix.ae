import assert from "node:assert/strict";
import test from "node:test";
import { productListOrder, quotationListOrder } from "../src/crm/commercial/list-order.js";

test("commercial order clauses allow only reviewed fields/directions with deterministic ties", () => {
  assert.equal(productListOrder("updatedAt", "desc"), "updated_at DESC,product_id ASC");
  assert.equal(quotationListOrder("assignedName", "asc", "mysql"), "u.username ASC,q.id DESC");
  assert.match(quotationListOrder("assignedName", "asc", "sqlite", true), /^CASE WHEN l.task_id IS NOT NULL THEN local_owner.username ELSE u.username END ASC,q.id DESC,q.origin ASC$/);
  for (const sort of ["constructor", "__proto__", "name; DELETE FROM products"]) {
    assert.throws(() => productListOrder(sort as "name", "asc"), /Invalid list ordering/);
    assert.throws(() => quotationListOrder(sort as "subtotal", "asc", "sqlite"), /Invalid list ordering/);
  }
  assert.throws(() => productListOrder("name", "desc; DROP TABLE users" as "desc"), /Invalid list ordering/);
});

test("quotation Amount SQL compares canonical nonnegative decimal strings without float coercion", () => {
  const sqlite = quotationListOrder("subtotal", "asc", "sqlite", true), mysql = quotationListOrder("subtotal", "desc", "mysql");
  assert.match(sqlite, /instr\(json_extract\(q.totals_json,'\$\.subtotal'\),'\.'\)-1 END ASC/);
  assert.match(mysql, /LENGTH\(SUBSTRING_INDEX\(JSON_UNQUOTE\(JSON_EXTRACT\(q.totals_json,'\$\.subtotal'\)\),'\.',1\)\) DESC/);
  assert.doesNotMatch(sqlite + mysql, /FLOAT|DOUBLE|REAL|DECIMAL\(/i);
});
