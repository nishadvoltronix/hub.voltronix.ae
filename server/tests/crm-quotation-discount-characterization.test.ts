import assert from "node:assert/strict";
import test from "node:test";
import { historicalDiscountEditBlocked, inspectQuotationRules, parseSavedQuotationInput } from "../src/crm/commercial/quotations.js";

// Financial impact examples only. Neither diagnostic interpretation authorizes
// a discounted edit or changes the preserved percentage-create-v1 policy.
const examples = [
  { name: "extended base 200", quantity: "2", rate: "100", header: "0", adjustment: "0",
    percentage: ["180.00", "9.00", "189.00"], flat: ["190.00", "9.50", "199.50"] },
  { name: "absolute header discount and signed adjustment", quantity: "2", rate: "100", header: "5", adjustment: "-1",
    percentage: ["180.00", "8.75", "182.75"], flat: ["190.00", "9.25", "193.25"] },
  { name: "base below 100 reverses the impact", quantity: "1", rate: "50", header: "0", adjustment: "0",
    percentage: ["45.00", "2.25", "47.25"], flat: ["40.00", "2.00", "42.00"] },
  { name: "coincident totals do not resolve ambiguous units", quantity: "1", rate: "100", header: "0", adjustment: "0",
    percentage: ["90.00", "4.50", "94.50"], flat: ["90.00", "4.50", "94.50"] },
  { name: "flat diagnostic can become negative before the taxable floor", quantity: "1", rate: "5", header: "0", adjustment: "0",
    percentage: ["4.50", "0.23", "4.73"], flat: ["-5.00", "0.00", "0.00"] },
  { name: "upper accepted line discount has different units", quantity: "2", rate: "100", header: "0", adjustment: "0",
    percentage: ["0.00", "0.00", "0.00"], flat: ["100.00", "5.00", "105.00"], itemDiscount: "100" },
] as const;

for (const example of examples) test(`DISCOUNT DECISION characterization: ${example.name}`, () => {
  const quote = parseSavedQuotationInput({ subject: "Synthetic rule comparison", kindAttention: "Synthetic reviewer",
    discount: example.header, adjustment: example.adjustment,
    items: [{ productId: "101", productName: "Synthetic example", description: "No persisted CRM record",
      uom: "NOS", quantity: example.quantity, unitPrice: example.rate,
      itemDiscount: "itemDiscount" in example ? example.itemDiscount : "10" }] }, "percentage-create-v1");
  const result = inspectQuotationRules(quote);
  for (const [actual, expected] of [[result.formAndCreate, example.percentage], [result.editServer, example.flat]] as const) {
    assert.deepEqual([actual.subtotal, actual.vatAmount, actual.grandTotal], expected);
  }
  assert.equal(result.hasAmbiguousEditDiscount, true);
  assert.equal(result.remoteAmountUsesSubtotal, true);
  assert.equal(historicalDiscountEditBlocked(quote, "percentage-create-v1"), true);
});

test("DISCOUNT DECISION characterization: multiple lines retain each original interpretation", () => {
  const quote = { subject: "Synthetic two-line comparison", kindAttention: "Synthetic reviewer", discount: "0", adjustment: "0",
    items: [
      { productId: "101", productName: "First synthetic item", description: "No saved record", uom: "NOS",
        quantity: "2", unitPrice: "100", itemDiscount: "10" },
      { productId: "102", productName: "Second synthetic item", description: "No saved record", uom: "NOS",
        quantity: "1", unitPrice: "50", itemDiscount: "10" },
    ] };
  const { formAndCreate, editServer } = inspectQuotationRules(quote);
  assert.deepEqual([formAndCreate.lineTotals, formAndCreate.subtotal, formAndCreate.vatAmount, formAndCreate.grandTotal],
    [["180.00", "45.00"], "225.00", "11.25", "236.25"]);
  assert.deepEqual([editServer.lineTotals, editServer.subtotal, editServer.vatAmount, editServer.grandTotal],
    [["190.00", "40.00"], "230.00", "11.50", "241.50"]);
});

test("DISCOUNT DECISION characterization: subtotal adds exact fractional lines before display rounding", () => {
  const quote = { subject: "Synthetic rounding tie", kindAttention: "Synthetic reviewer", discount: "0", adjustment: "0",
    items: ["101", "102"].map((productId) => ({ productId, productName: "Fractional synthetic item",
      description: "No saved record", uom: "NOS", quantity: "0.5", unitPrice: "0.01", itemDiscount: "0" })) };
  const { formAndCreate, editServer } = inspectQuotationRules(quote);
  for (const result of [formAndCreate, editServer]) {
    assert.deepEqual(result.exactLineTotals, ["0.005", "0.005"]);
    assert.deepEqual(result.lineTotals, ["0.01", "0.01"]);
    assert.equal(result.subtotal, "0.01");
    assert.equal(result.vatAmount, "0.00");
    assert.equal(result.grandTotal, "0.01");
  }
});
