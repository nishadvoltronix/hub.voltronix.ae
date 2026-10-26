import assert from "node:assert/strict";
import test from "node:test";
import { buildStageFields, parseStagePayloadProfile, stageReadbackMatches, STAGE_PAYLOAD_PROFILES } from "../src/crm/lead-mutations/stage-profile.js";
import { LEAD_TRANSITIONS } from "../src/crm/lead-mutations/contracts.js";
import { CommercialError } from "../src/crm/commercial/validation.js";

test("stage profiles are explicit fixed contracts; default retains prior wire names", () => {
  assert.equal(Object.isFrozen(STAGE_PAYLOAD_PROFILES), true);
  for (const stage of LEAD_TRANSITIONS) {
    assert.deepEqual(buildStageFields(stage), { Stage: stage, VZ_App_Status: stage });
    assert.deepEqual(buildStageFields(stage, "legacy-stage-v1"), buildStageFields(stage));
  }
  for (const value of [null, "", "automatic", "needs-analysis", {}, { Stage: "Anything" }]) {
    assert.throws(() => parseStagePayloadProfile(value), (error: unknown) => error instanceof CommercialError && error.status === 400);
  }
});

test("explicit tenant-label profile distinguishes API stage and app status without changing local stages", () => {
  const expected = [
    { Stage: "Needs Analysis", VZ_App_Status: "Site Visit" },
    { Stage: "Proposal/Price Quote", VZ_App_Status: "Proposal" },
    { Stage: "Closed Won", VZ_App_Status: "Close to Won" },
    { Stage: "Closed Lost", VZ_App_Status: "Close to Lost" },
  ];
  for (const [index, stage] of LEAD_TRANSITIONS.entries()) {
    const actual = buildStageFields(stage, "voltronix-stage-labels-v1");
    assert.deepEqual(actual, expected[index]);
    (actual as Record<string, string>).Stage = "mutated caller result";
    assert.deepEqual(buildStageFields(stage, "voltronix-stage-labels-v1"), expected[index]);
  }
});

test("new stage profile requires exact readback of BOTH fields, never a similar display label", () => {
  const profile = "voltronix-stage-labels-v1";
  for (const stage of LEAD_TRANSITIONS) {
    const fields = buildStageFields(stage, profile);
    assert.equal(stageReadbackMatches(fields, stage, profile), true);
    for (const value of [{ Stage: fields.Stage }, { ...fields, VZ_App_Status: "Other" }, { ...fields, Stage: "Other" }]) {
      assert.equal(stageReadbackMatches(value, stage, profile), false);
    }
  }
  assert.equal(stageReadbackMatches({ Stage: "Site Visit", VZ_App_Status: "Site Visit" }, "Site Visit", profile), false);
  assert.equal(stageReadbackMatches({ Stage: "Site Visit" }, "Site Visit"), true);
});

test("production reference-values profile uses the documented Records wire value while preserving old candidate semantics", () => {
  const profile = "voltronix-stage-reference-values-v1";
  assert.deepEqual(buildStageFields("Site Visit", profile), { Stage: "Site Visit", VZ_App_Status: "Site Visit" });
  assert.equal(stageReadbackMatches({ Stage: "Site Visit", VZ_App_Status: "Site Visit" }, "Site Visit", profile), true);
  assert.equal(stageReadbackMatches({ Stage: "Needs Analysis", VZ_App_Status: "Site Visit" }, "Site Visit", profile), false);
  assert.equal(buildStageFields("Site Visit", "voltronix-stage-labels-v1").Stage, "Needs Analysis");
  for (const stage of LEAD_TRANSITIONS.filter(stage => stage !== "Site Visit")) {
    assert.deepEqual(buildStageFields(stage, profile), buildStageFields(stage, "voltronix-stage-labels-v1"));
  }
});
