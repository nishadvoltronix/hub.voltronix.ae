import assert from "node:assert/strict";
import test from "node:test";
import { assertPersistenceReceipt, hasLocalRecordWorkflow, hasRemoteWorkflow, type CrmWriteCapabilities } from "@voltronix/crm-contracts";
import { createLocalWriteState } from "../src/components/crm/local-write-state";
import { hasRemoteQuotationRows } from "../src/server/commercial/edit-access";
import { parseQuotationInput } from "../src/server/commercial/quotations";

const remote: CrmWriteCapabilities = { persistence: "zoho", integrationAvailable: true, remoteWorkflow: true,
  localWorkflow: true, productCreate: true, dealCreate: true, leadNotes: true };

test("remote presentation requires the full explicit capability and keeps local MySQL provenance", () => {
  assert.equal(hasRemoteWorkflow(remote), true);
  for (const value of [undefined, { ...remote, integrationAvailable: false }, { ...remote, remoteWorkflow: undefined },
    { ...remote, persistence: "local-mysql" as const }]) assert.equal(hasRemoteWorkflow(value), false);
  assert.equal(hasLocalRecordWorkflow(remote, "local-mysql"), true);
  assert.equal(hasLocalRecordWorkflow(remote, "local-demo"), false);
  assert.equal(hasLocalRecordWorkflow(remote, "zoho"), false);
  assert.equal(hasLocalRecordWorkflow({ ...remote, localWorkflow: false }, "local-mysql"), false);
});

test("HTTP success cannot certify a different provider, operation or an unverified Zoho write", () => {
  const expected = { operationId: "owned-operation", persistence: "zoho" as const };
  assert.doesNotThrow(() => assertPersistenceReceipt({ ...expected, remoteVerified: true }, expected));
  for (const value of [null, {}, expected, { ...expected, remoteVerified: false },
    { ...expected, remoteVerified: true, operationId: "other-operation" },
    { ...expected, remoteVerified: true, persistence: "local-mysql" }]) {
    assert.throws(() => assertPersistenceReceipt(value, expected), /could not be confirmed/);
  }
});

test("uncertain remote acknowledgement retains the operation identifier for an identical retry", async () => {
  const state = createLocalWriteState(), ids: string[] = [];
  await assert.rejects(state.run({ title: "Synthetic" }, async value => {
    ids.push(value.operationId); return { operationId: value.operationId, persistence: "local-mysql" };
  }, "zoho"), /could not be confirmed/);
  const saved = await state.run({ title: "Synthetic" }, async value => {
    ids.push(value.operationId); return { operationId: value.operationId, persistence: "zoho", remoteVerified: true };
  }, "zoho");
  assert.equal(ids[0], ids[1]); assert.equal(saved?.remoteVerified, true);
});

test("quotation row identity requires a complete unique decimal ID for every saved line", () => {
  const item = { productId: "101", productName: "Synthetic item", description: "Synthetic", uom: "NOS", quantity: "1", unitPrice: "2", itemDiscount: "0" };
  const quotation = parseQuotationInput({ subject: "Synthetic", kindAttention: "Synthetic", discount: "0", adjustment: "0", items: [item, item] });
  assert.equal(hasRemoteQuotationRows({ quotation, remoteRowIds: ["501", "502"] }), true);
  for (const remoteRowIds of [undefined, [], ["501"], ["501", "501"], ["0", "502"], ["row-1", "502"]]) {
    assert.equal(hasRemoteQuotationRows({ quotation, remoteRowIds }), false);
  }
});
