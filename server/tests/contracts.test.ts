import assert from "node:assert/strict";
import { test } from "node:test";
import { API_V1_PREFIX, LIVENESS_PATH, isLivenessResponse } from "@voltronix/crm-contracts";

test("public wire liveness guard rejects extra data and malformed readiness claims", () => {
  assert.equal(API_V1_PREFIX, "/api/v1");
  assert.equal(LIVENESS_PATH, "/api/v1/health/live");
  assert.equal(isLivenessResponse(JSON.parse('{"status":"running"}')), true);
  for (const value of [null, [], "running", {}, { status: "ready" }, { status: "running", database: "ready" }, Object.create({ status: "running" })]) {
    assert.equal(isLivenessResponse(value), false);
  }
});
