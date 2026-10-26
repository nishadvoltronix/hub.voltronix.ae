import assert from "node:assert/strict";
import test from "node:test";
import { assertNativeZohoContext, nativeZohoReference } from "../src/integrations/zoho/native-numbering.js";

test("native references derive only from verified identities and preserve established references", () => {
  assert.equal(nativeZohoReference("qualification", "201", null, "VTNX-123"), "DEAL-123");
  assert.equal(nativeZohoReference("quote", "201", "", "VTNX-456"), "QUOTE-456");
  for (const [kind, prefix] of [["site", "SITE"], ["job", "JOB"], ["lost", "LOST"]] as const) {
    assert.equal(nativeZohoReference(kind, "201", null), `HUB-${prefix}-201`);
    assert.equal(nativeZohoReference(kind, "201", "Legacy-7001"), "Legacy-7001");
    assert.notEqual(nativeZohoReference(kind, "201", null), nativeZohoReference(kind, "202", null));
  }
});

test("numbering rejects malformed profiles, identities, unsupported autonumbers and unsafe established references", () => {
  assert.doesNotThrow(() => assertNativeZohoContext({ organizationId: "3001", dealLayoutId: "6001", quotationProfile: "voltronix-custom-quoted-items-v8", numberingProfile: "voltronix-hub-local-references-v1" }));
  for (const organizationId of ["0", "../1", "1".repeat(31)]) assert.throws(() => assertNativeZohoContext({ organizationId, dealLayoutId: "6001",
    quotationProfile: "voltronix-custom-quoted-items-v8", numberingProfile: "voltronix-hub-local-references-v1" }));
  for (const invalid of [undefined, "TEST-1", "VTNX-", "VTNX-1\n"]) assert.throws(() => nativeZohoReference("quote", "201", null, invalid));
  for (const invalid of [" ", "Leading ", "broken\nreference", 123, "x".repeat(101)]) assert.throws(() => nativeZohoReference("site", "201", invalid));
  assert.throws(() => nativeZohoReference("site", "0", null));
});
