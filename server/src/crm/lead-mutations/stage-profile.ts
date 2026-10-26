import { z } from "zod";
import { CommercialError } from "../commercial/validation.js";
import { LEAD_TRANSITIONS } from "./contracts.js";

export const NATIVE_PRODUCTION_STAGE_PROFILE = "voltronix-stage-reference-values-v1" as const;
export const STAGE_PAYLOAD_PROFILES = Object.freeze(["legacy-stage-v1", "voltronix-stage-labels-v1", NATIVE_PRODUCTION_STAGE_PROFILE] as const);
export type StagePayloadProfile = typeof STAGE_PAYLOAD_PROFILES[number];
type Stage = typeof LEAD_TRANSITIONS[number];
const profileSchema = z.enum(STAGE_PAYLOAD_PROFILES);
const stageSchema = z.enum(LEAD_TRANSITIONS);

/** Explicit profile, never an environment selector or a tenant approval.
 * Metadata observed 2026-10-15: Stage actual Needs Analysis displays Site Visit.
 * App-status alternatives are separately observed and retained source reports
 * group Proposal/Proposal-Price-Quote and Close/Closed Won/Lost together.
 * Pipeline/layout membership still requires acceptance before runtime selection. */
const observed = Object.freeze({
  "Site Visit": Object.freeze({ Stage: "Needs Analysis", VZ_App_Status: "Site Visit" }),
  "Proposal/Price Quote": Object.freeze({ Stage: "Proposal/Price Quote", VZ_App_Status: "Proposal" }),
  "Closed Won": Object.freeze({ Stage: "Closed Won", VZ_App_Status: "Close to Won" }),
  "Closed Lost": Object.freeze({ Stage: "Closed Lost", VZ_App_Status: "Close to Lost" }),
} satisfies Record<Stage, { Stage: string; VZ_App_Status: string }>);

export function parseStagePayloadProfile(value: unknown): StagePayloadProfile {
  const parsed = profileSchema.safeParse(value);
  if (!parsed.success) throw new CommercialError(400);
  return parsed.data;
}

export function buildStageFields(stage: Stage, profile: StagePayloadProfile = "legacy-stage-v1") {
  const selected = parseStagePayloadProfile(profile), parsed = stageSchema.safeParse(stage);
  if (!parsed.success) throw new CommercialError(400);
  if (selected === "legacy-stage-v1") return { Stage: parsed.data, VZ_App_Status: parsed.data };
  // Record APIs use display values; actual_value is an internal picklist key.
  // The production preflight pins actual/reference/display and pipeline option
  // identity. Preserve the older candidate profile for historical evidence.
  // https://help.zoho.com/portal/fr/community/topic/kaizen-205-answering-your-questions-managing-picklists-and-enabling-history-tracking-via-zoho-crm-apis
  return { ...observed[parsed.data], ...(selected === NATIVE_PRODUCTION_STAGE_PROFILE && parsed.data === "Site Visit" ? { Stage: "Site Visit" } : {}) };
}

/** Legacy characterization only checked Stage. The explicit new profile must
 * confirm BOTH remote fields before a local transition can be committed. */
export function stageReadbackMatches(remote: Record<string, unknown>, stage: Stage, profile: StagePayloadProfile = "legacy-stage-v1"): boolean {
  const expected = buildStageFields(stage, profile);
  return remote.Stage === expected.Stage && (profile === "legacy-stage-v1" || remote.VZ_App_Status === expected.VZ_App_Status);
}
