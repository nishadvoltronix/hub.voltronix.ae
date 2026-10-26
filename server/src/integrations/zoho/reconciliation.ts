import { createHash } from "node:crypto";
import { z } from "zod";
import { ACCOUNT_PAYLOAD_PROFILES, DEAL_PAYLOAD_PROFILES, buildContactPayload, buildDealPayload,
  dealPipelineSchema, parseAccountPayloadProfile, parseDealInput, parseDealPayloadProfile } from "../../crm/commercial/deals.js";
import { buildProductPayload } from "../../crm/commercial/products.js";
import { compare, decimal } from "../../crm/commercial/decimal.js";
import { multiLine, singleLine } from "../../crm/commercial/validation.js";
import { LEAD_TRANSITIONS } from "../../crm/lead-mutations/contracts.js";
import { buildStageFields, parseStagePayloadProfile, STAGE_PAYLOAD_PROFILES } from "../../crm/lead-mutations/stage-profile.js";

const remoteId = z.string().regex(/^[1-9][0-9]{0,29}$/);
const localId = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => BigInt(value) <= 9_223_372_036_854_775_807n);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1);
const cleanText = (maximum: number) => z.string().trim().max(maximum).refine(value => !value.includes("\0"));
const amount = z.string().regex(/^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$/);
const operationId = z.uuid();
const kindSchema = z.enum(["lead.stage", "note.create", "note.edit", "deal.create", "product.create", "quote.create", "quote.edit"]);
const referencesSchema = z.object({ accountId: remoteId.optional(), contactId: remoteId.optional(), dealId: remoteId.optional(),
  noteId: remoteId.optional(), productId: remoteId.optional(), quoteId: remoteId.optional() }).strict();
const journalSchema = z.object({ operationId, kind: kindSchema, actorUserId: localId, taskId: localId.nullable(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(["inflight", "completed", "reconciliation"]),
  remoteEffectPossible: z.boolean(), remoteId: remoteId.nullable().optional(), remoteReferences: referencesSchema }).strict();
const requestBase = { operationId, expectedVersion: version };
const taskExpected = { actorUserId: localId, targetExternalId: remoteId };
const expectedSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("lead.stage"), ...taskExpected, stagePayloadProfile: z.enum(STAGE_PAYLOAD_PROFILES).optional(),
    request: z.object({ ...requestBase, stage: z.enum(LEAD_TRANSITIONS), serviceCharge: amount.optional() }).strict() }).strict(),
  z.object({ kind: z.literal("note.create"), ...taskExpected,
    request: z.object({ ...requestBase, title: cleanText(200).min(1), content: cleanText(10_000).min(1) }).strict() }).strict(),
  z.object({ kind: z.literal("note.edit"), ...taskExpected, noteId: localId, noteExternalId: remoteId.nullable(),
    request: z.object({ ...requestBase, title: cleanText(200).optional(), content: cleanText(10_000).min(1) }).strict() }).strict(),
  z.object({ kind: z.literal("deal.create"), actorUserId: localId, actorExternalId: remoteId,
    dealPayloadProfile: z.enum(DEAL_PAYLOAD_PROFILES).optional(), accountPayloadProfile: z.enum(ACCOUNT_PAYLOAD_PROFILES).optional(),
    dealPipeline: dealPipelineSchema.optional(),
    request: z.object({ operationId, input: z.unknown() }).strict() }).strict(),
  z.object({ kind: z.literal("product.create"), actorUserId: localId,
    request: z.object({ operationId, name: singleLine(200).min(1), description: multiLine(10_000) }).strict() }).strict(),
  z.object({ kind: z.literal("quote.create") }).strict(),
  z.object({ kind: z.literal("quote.edit") }).strict(),
]);
const localBindingSchema = z.object({ taskId: localId, version, externalId: remoteId,
  note: z.object({ id: localId, externalId: remoteId.nullable() }).strict().optional() }).strict();
const observationSchema = z.object({ module: z.enum(["Accounts", "Contacts", "Deals", "Notes", "Products"]), id: remoteId,
  response: z.object({ status: z.number().int().min(100).max(599), body: z.unknown() }).strict() }).strict();
const inputSchema = z.object({ journal: journalSchema, expected: expectedSchema, localBinding: localBindingSchema.nullable(),
  observations: z.array(observationSchema).max(5) }).strict();

export type ZohoReconciliationInput = z.infer<typeof inputSchema>;
export type ZohoReconciliationDecision = "confirmed-match" | "mismatch" | "missing" | "unknown";
export type ZohoReconciliationReason = "INVALID_INPUT" | "UNSUPPORTED_QUOTATION" | "JOURNAL_NOT_RECONCILIATION"
  | "REMOTE_EFFECT_NOT_RECORDED" | "OPERATION_BINDING_MISMATCH" | "REQUEST_HASH_MISMATCH" | "LOCAL_BINDING_MISMATCH"
  | "REFERENCE_BINDING_MISMATCH" | "REFERENCE_MISSING" | "OBSERVATION_MISSING" | "OBSERVATION_NOT_BOUND"
  | "OBSERVATION_AMBIGUOUS" | "ACCESS_UNVERIFIED" | "RATE_LIMITED" | "HTTP_STATUS_UNVERIFIED"
  | "RECORD_NOT_RETURNED" | "RESPONSE_INVALID" | "REMOTE_ID_MISMATCH" | "FIELD_MISSING"
  | "FIELD_INVALID" | "FIELD_DIFFERENT";
type FieldCheck = { field: string; mode: "exact" | "presence"; decision: ZohoReconciliationDecision; reason?: ZohoReconciliationReason };
type Resource = "account" | "contact" | "deal" | "note" | "product";
export interface ZohoReconciliationReport {
  status: "RECONCILIATION_REVIEW_ONLY";
  kind: z.infer<typeof kindSchema> | null;
  decision: ZohoReconciliationDecision;
  bindingVerified: boolean;
  resources: { resource: Resource; decision: ZohoReconciliationDecision; fields: FieldCheck[]; reasons: ZohoReconciliationReason[] }[];
  reasons: ZohoReconciliationReason[];
  journalResolved: false;
  retryAllowed: false;
  journalMutationAllowed: false;
  limitations: readonly ["READBACK_IS_NOT_CAUSAL_PROOF", "AUTHORIZATION_NOT_VERIFIED", "LOCAL_COMMIT_NOT_VERIFIED", "NO_AUTOMATIC_REPAIR"];
}
type Check = { field: string; expected: string; type: "text" | "lookup" | "amount" }
  | { field: "Parent_Id.module.api_name"; expected: "Deals"; type: "module" } | { field: string; type: "presence" };
type Plan = { resource: Resource; module: z.infer<typeof observationSchema>["module"]; id?: string; checks: Check[] };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function report(kind: ZohoReconciliationReport["kind"], reason?: ZohoReconciliationReason): ZohoReconciliationReport {
  return { status: "RECONCILIATION_REVIEW_ONLY", kind, decision: "unknown", bindingVerified: false,
    resources: [], reasons: reason ? [reason] : [], journalResolved: false, retryAllowed: false, journalMutationAllowed: false,
    limitations: ["READBACK_IS_NOT_CAUSAL_PROOF", "AUTHORIZATION_NOT_VERIFIED", "LOCAL_COMMIT_NOT_VERIFIED", "NO_AUTOMATIC_REPAIR"] };
}
function aggregate(decisions: ZohoReconciliationDecision[]): ZohoReconciliationDecision {
  if (decisions.includes("mismatch")) return "mismatch";
  if (decisions.includes("missing")) return "missing";
  if (!decisions.length || decisions.includes("unknown")) return "unknown";
  return "confirmed-match";
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fields(payload: Record<string, unknown>): Check[] {
  return Object.entries(payload).map(([field, value]) => {
    if (typeof value === "string") return { field, expected: value, type: "text" };
    if (object(value) && typeof value.id === "string") return { field, expected: value.id, type: "lookup" };
    throw new Error("Unsupported fixed payload shape.");
  });
}
function compareField(row: Record<string, unknown>, check: Check): FieldCheck {
  const base = { field: check.field, mode: check.type === "presence" ? "presence" as const : "exact" as const };
  const parent = row.Parent_Id;
  const actual = check.type === "module" ? object(parent) && object(parent.module) ? parent.module.api_name : undefined : row[check.field];
  if (actual === undefined || actual === null) return { ...base, decision: "unknown", reason: "FIELD_MISSING" };
  if (check.type === "presence") {
    return cleanText(100).min(1).safeParse(actual).success ? { ...base, decision: "confirmed-match" }
      : { ...base, decision: "unknown", reason: "FIELD_INVALID" };
  }
  let equal: boolean;
  if (check.type === "lookup") {
    if (!object(actual) || !remoteId.safeParse(actual.id).success) return { ...base, decision: "unknown", reason: "FIELD_INVALID" };
    equal = actual.id === check.expected;
  } else if (check.type === "amount") {
    if (!amount.safeParse(actual).success) return { ...base, decision: "unknown", reason: "FIELD_INVALID" };
    equal = compare(decimal(actual as string), decimal(check.expected)) === 0;
  } else {
    if (typeof actual !== "string" || actual.length > 10_000 || actual.includes("\0")) return { ...base, decision: "unknown", reason: "FIELD_INVALID" };
    equal = actual === check.expected;
  }
  return equal ? { ...base, decision: "confirmed-match" } : { ...base, decision: "mismatch", reason: "FIELD_DIFFERENT" };
}
function observe(plan: Plan, observation: z.infer<typeof observationSchema> | undefined): ZohoReconciliationReport["resources"][number] {
  const result: ZohoReconciliationReport["resources"][number] = { resource: plan.resource, decision: "unknown", fields: [], reasons: [] };
  const unknown = (reason: ZohoReconciliationReason) => { result.reasons.push(reason); return result; };
  if (!plan.id) return unknown("REFERENCE_MISSING");
  if (!plan.checks.length) return unknown("REFERENCE_MISSING");
  if (!observation) return unknown("OBSERVATION_MISSING");
  const { status, body } = observation.response;
  if (status === 401 || status === 403 || status === 404) return unknown("ACCESS_UNVERIFIED");
  if (status === 429) return unknown("RATE_LIMITED");
  if (status === 204) {
    if (body !== null && body !== undefined) return unknown("RESPONSE_INVALID");
    result.decision = "missing"; result.reasons.push("RECORD_NOT_RETURNED"); return result;
  }
  if (status !== 200) return unknown("HTTP_STATUS_UNVERIFIED");
  const parsed = z.object({ data: z.array(z.record(z.string(), z.unknown())).max(1),
    info: z.object({ more_records: z.literal(false) }).optional() }).strict().safeParse(body);
  if (!parsed.success) return unknown("RESPONSE_INVALID");
  const row = parsed.data.data[0];
  if (!row) { result.decision = "missing"; result.reasons.push("RECORD_NOT_RETURNED"); return result; }
  if (["code", "error", "errors", "status", "message"].some(key => Object.hasOwn(row, key))) return unknown("RESPONSE_INVALID");
  if (row.id !== plan.id) return unknown("REMOTE_ID_MISMATCH");
  result.fields = plan.checks.map(check => compareField(row, check));
  result.decision = aggregate(result.fields.map(field => field.decision));
  return result;
}

/** Pure review of caller-supplied, authorized snapshots. This module performs no
 * database or network I/O and never releases, retries or repairs an operation.
 * A confirmed match covers only checked requested values/relationships at the
 * supplied readback time; it is not proof that this operation caused them. */
export function assessZohoReconciliation(input: unknown): ZohoReconciliationReport {
  let knownKind: ZohoReconciliationReport["kind"] = null;
  try {
    // Detach and bound untrusted readbacks. Exception details and customer values
    // never reach the report, including for malformed or cyclic input.
    const validated = inputSchema.safeParse(input);
    if (!validated.success) return report(null, "INVALID_INPUT");
    const serialized = JSON.stringify(validated.data);
    if (!serialized || Buffer.byteLength(serialized, "utf8") > 512 * 1024) return report(null, "INVALID_INPUT");
    const value = inputSchema.safeParse(JSON.parse(serialized));
    if (!value.success) return report(null, "INVALID_INPUT");
    const { journal, expected, localBinding, observations } = value.data;
    knownKind = journal.kind;
    if (journal.kind !== expected.kind) return report(knownKind, "OPERATION_BINDING_MISMATCH");
    if (expected.kind === "quote.create" || expected.kind === "quote.edit") return report(knownKind, "UNSUPPORTED_QUOTATION");
    if (journal.state !== "reconciliation") return report(knownKind, "JOURNAL_NOT_RECONCILIATION");
    if (!journal.remoteEffectPossible) return report(knownKind, "REMOTE_EFFECT_NOT_RECORDED");
    if (journal.actorUserId !== expected.actorUserId || journal.operationId !== expected.request.operationId) return report(knownKind, "OPERATION_BINDING_MISMATCH");
    const refs = journal.remoteReferences, plans: Plan[] = [];
    const permitted = expected.kind === "deal.create" ? ["accountId", "contactId", "dealId"] : expected.kind === "product.create" ? ["productId"]
      : expected.kind === "lead.stage" ? ["dealId"] : ["noteId"];
    if (Object.keys(refs).some(key => !permitted.includes(key))) return report(knownKind, "REFERENCE_BINDING_MISMATCH");
    let requestHash: string;
    if (expected.kind === "deal.create") {
      const deal = parseDealInput(expected.request.input), profile = parseDealPayloadProfile(expected.dealPayloadProfile ?? "legacy-create-v1");
      const accountProfile = parseAccountPayloadProfile(expected.accountPayloadProfile ?? "legacy-account-email-v1");
      requestHash = hash({ operationId: expected.request.operationId, ...deal, ...(profile === "legacy-create-v1" ? {} : { dealPayloadProfile: profile }),
        ...(accountProfile === "legacy-account-email-v1" ? {} : { accountPayloadProfile: accountProfile }),
        ...(expected.dealPipeline === undefined ? {} : { dealPipeline: expected.dealPipeline }) });
      if (journal.taskId !== null || localBinding !== null) return report(knownKind, "LOCAL_BINDING_MISMATCH");
      plans.push({ resource: "account", module: "Accounts", ...(refs.accountId ? { id: refs.accountId } : {}),
        checks: [{ field: "Account_Name", type: "text", expected: deal.companyName }] });
      plans.push({ resource: "contact", module: "Contacts", ...(refs.contactId ? { id: refs.contactId } : {}),
        checks: refs.accountId ? fields(buildContactPayload(deal, refs.accountId).data[0]!) : [] });
      plans.push({ resource: "deal", module: "Deals", ...(refs.dealId ? { id: refs.dealId } : {}),
        checks: refs.accountId && refs.contactId ? [...fields(buildDealPayload(deal, { accountId: refs.accountId,
          contactId: refs.contactId, assignedExternalId: expected.actorExternalId }, profile, expected.dealPipeline).data[0]!), { field: "DealNumber", type: "presence" }] : [] });
      if (journal.remoteId && journal.remoteId !== (refs.dealId ?? refs.contactId ?? refs.accountId)) return report(knownKind, "REFERENCE_BINDING_MISMATCH");
    } else if (expected.kind === "product.create") {
      requestHash = hash(expected.request);
      if (journal.taskId !== null || localBinding !== null) return report(knownKind, "LOCAL_BINDING_MISMATCH");
      if (journal.remoteId) return report(knownKind, "REFERENCE_BINDING_MISMATCH");
      plans.push({ resource: "product", module: "Products", ...(refs.productId ? { id: refs.productId } : {}),
        checks: fields(buildProductPayload({ name: expected.request.name, description: expected.request.description }).data[0]!) });
    } else {
      if (!localBinding || journal.taskId !== localBinding.taskId || localBinding.version !== expected.request.expectedVersion
        || localBinding.externalId !== expected.targetExternalId) return report(knownKind, "LOCAL_BINDING_MISMATCH");
      if (expected.kind === "lead.stage") {
        const profile = parseStagePayloadProfile(expected.stagePayloadProfile ?? "legacy-stage-v1");
        requestHash = hash({ ...expected.request, ...(profile === "legacy-stage-v1" ? {} : { stagePayloadProfile: profile }) });
        if (refs.dealId && refs.dealId !== expected.targetExternalId || journal.remoteId && journal.remoteId !== expected.targetExternalId) return report(knownKind, "REFERENCE_BINDING_MISMATCH");
        const checks: Check[] = [...fields(buildStageFields(expected.request.stage, profile)), { field: "DealNumber", type: "presence" }];
        const number = { "Site Visit": "SiteDealNumber", "Proposal/Price Quote": "QuoteDealNumber", "Closed Won": "JobDealNumber", "Closed Lost": null }[expected.request.stage];
        if (number) checks.push({ field: number, type: "presence" });
        if (expected.request.serviceCharge !== undefined) checks.push({ field: "Amount", type: "amount", expected: expected.request.serviceCharge });
        plans.push({ resource: "deal", module: "Deals", id: expected.targetExternalId, checks });
      } else {
        requestHash = hash({ ...expected.request, noteId: expected.kind === "note.edit" ? expected.noteId : null });
        if (expected.kind === "note.edit" && (!localBinding.note || localBinding.note.id !== expected.noteId
          || localBinding.note.externalId !== expected.noteExternalId)) return report(knownKind, "LOCAL_BINDING_MISMATCH");
        const id = refs.noteId ?? (expected.kind === "note.edit" ? expected.noteExternalId : null);
        if (expected.kind === "note.edit" && expected.noteExternalId && refs.noteId && refs.noteId !== expected.noteExternalId
          || journal.remoteId && journal.remoteId !== id) return report(knownKind, "REFERENCE_BINDING_MISMATCH");
        const checks: Check[] = [{ field: "Parent_Id", type: "lookup", expected: expected.targetExternalId },
          { field: "Parent_Id.module.api_name", type: "module", expected: "Deals" },
          { field: "Note_Content", type: "text", expected: expected.request.content }];
        if (expected.request.title) checks.push({ field: "Note_Title", type: "text", expected: expected.request.title });
        plans.push({ resource: "note", module: "Notes", ...(id ? { id } : {}), checks });
      }
    }
    if (requestHash !== journal.requestHash) return report(knownKind, "REQUEST_HASH_MISMATCH");
    const seen = new Set<string>();
    for (const observation of observations) {
      const key = `${observation.module}/${observation.id}`;
      if (seen.has(key)) return report(knownKind, "OBSERVATION_AMBIGUOUS");
      seen.add(key);
      if (!plans.some(plan => plan.module === observation.module && plan.id === observation.id)) return report(knownKind, "OBSERVATION_NOT_BOUND");
    }
    const result = report(knownKind); result.bindingVerified = true;
    result.resources = plans.map(plan => observe(plan, observations.find(observation => observation.module === plan.module && observation.id === plan.id)));
    result.decision = aggregate(result.resources.map(resource => resource.decision));
    return result;
  } catch { return report(knownKind, "INVALID_INPUT"); }
}
