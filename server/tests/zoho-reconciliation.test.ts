import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assessZohoReconciliation, type ZohoReconciliationInput, type ZohoReconciliationReport } from "../src/integrations/zoho/reconciliation.js";
import { buildContactPayload, buildDealPayload, parseDealInput, type AccountPayloadProfile, type DealPayloadProfile } from "../src/crm/commercial/deals.js";
import { buildStageFields } from "../src/crm/lead-mutations/stage-profile.js";

const operationId = "03fde08f-35f7-4ef2-8140-163db71eca77";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const privateText = "PRIVATE_CUSTOMER_VALUE";
function stage(): ZohoReconciliationInput {
  const request = { operationId, expectedVersion: 4, stage: "Site Visit" as const, serviceCharge: "9007199254740993.01" };
  return { journal: { operationId, kind: "lead.stage", actorUserId: "1", taskId: "10", requestHash: hash(request),
    state: "reconciliation", remoteEffectPossible: true, remoteId: "201", remoteReferences: { dealId: "201" } },
  expected: { kind: "lead.stage", actorUserId: "1", targetExternalId: "201", request },
  localBinding: { taskId: "10", version: 4, externalId: "201" },
  observations: [{ module: "Deals", id: "201", response: { status: 200, body: { data: [{ id: "201", Stage: "Site Visit",
    VZ_App_Status: "Site Visit", DealNumber: privateText, SiteDealNumber: privateText, Amount: "9007199254740993.010", Description: privateText }] } } }] };
}
function note(edit = false, explicitTitle = true): ZohoReconciliationInput {
  const request = { operationId, expectedVersion: 4, ...(explicitTitle ? { title: privateText } : {}), content: privateText };
  const base = stage();
  base.journal.kind = edit ? "note.edit" : "note.create";
  base.journal.remoteReferences = { noteId: "301" }; base.journal.remoteId = "301";
  base.journal.requestHash = hash({ ...request, noteId: edit ? "21" : null });
  base.expected = edit ? { kind: "note.edit", actorUserId: "1", targetExternalId: "201", noteId: "21", noteExternalId: "301", request }
    : { kind: "note.create", actorUserId: "1", targetExternalId: "201", request: { ...request, title: privateText } };
  if (edit) base.localBinding!.note = { id: "21", externalId: "301" };
  base.observations = [{ module: "Notes", id: "301", response: { status: 200, body: {
    data: [{ id: "301", Parent_Id: { id: "201", name: privateText, module: { api_name: "Deals" } }, Note_Title: privateText, Note_Content: privateText }] } } }];
  return base;
}
function product(): ZohoReconciliationInput {
  const request = { operationId, name: privateText, description: privateText };
  return { journal: { operationId, kind: "product.create", actorUserId: "1", taskId: null, requestHash: hash(request), state: "reconciliation",
    remoteEffectPossible: true, remoteReferences: { productId: "401" } }, expected: { kind: "product.create", actorUserId: "1", request },
  localBinding: null, observations: [{ module: "Products", id: "401", response: { status: 200,
    body: { data: [{ id: "401", Product_Name: privateText, Description: privateText, Unit_Price: "1.01" }] } } }] };
}
function deal(profile: DealPayloadProfile = "legacy-create-v1", accountProfile: AccountPayloadProfile = "legacy-account-email-v1", dealPipeline?: string): ZohoReconciliationInput {
  const input = { firstName: privateText, lastName: "Contact", companyName: privateText, email: "private@example.invalid",
    mobile: "000", phone: "001", department: "VOLTRONIX CONTRACTING LLC", poBox: "0007", description: privateText };
  const normalized = parseDealInput(input);
  return { journal: { operationId, kind: "deal.create", actorUserId: "1", taskId: null,
    requestHash: hash({ operationId, ...normalized, ...(profile === "legacy-create-v1" ? {} : { dealPayloadProfile: profile }),
      ...(accountProfile === "legacy-account-email-v1" ? {} : { accountPayloadProfile: accountProfile }),
      ...(dealPipeline === undefined ? {} : { dealPipeline }) }),
    state: "reconciliation", remoteEffectPossible: true, remoteId: "201", remoteReferences: { accountId: "501", contactId: "601", dealId: "201" } },
  expected: { kind: "deal.create", actorUserId: "1", actorExternalId: "701", dealPayloadProfile: profile,
    accountPayloadProfile: accountProfile, ...(dealPipeline === undefined ? {} : { dealPipeline }), request: { operationId, input } }, localBinding: null,
  observations: [
    { module: "Accounts", id: "501", response: { status: 200, body: { data: [{ id: "501", Account_Name: privateText, Phone: "Existing account phone" }] } } },
    { module: "Contacts", id: "601", response: { status: 200, body: { data: [{ id: "601", ...buildContactPayload(normalized, "501").data[0] }] } } },
    { module: "Deals", id: "201", response: { status: 200, body: { data: [{ id: "201", ...buildDealPayload(normalized,
      { accountId: "501", contactId: "601", assignedExternalId: "701" }, profile, dealPipeline).data[0], DealNumber: privateText }] } } },
  ] };
}
function row(input: ZohoReconciliationInput, index = 0) {
  return (input.observations[index]!.response.body as { data: Record<string, unknown>[] }).data[0]!;
}

test("pipeline reconciliation requires both matching operation identity and exact remote pipeline evidence", () => {
  const input = deal("legacy-conversion-fields-v1", "standard-account-contact-email-v1", "Synthetic pipeline");
  assert.equal(assessZohoReconciliation(input).decision, "confirmed-match");
  row(input, 2).Pipeline = "Other pipeline";
  assert.equal(assessZohoReconciliation(input).decision, "mismatch");
  delete row(input, 2).Pipeline;
  assert.equal(assessZohoReconciliation(input).decision, "unknown");
  if (input.expected.kind !== "deal.create") assert.fail("deal fixture");
  input.expected.dealPipeline = "Other pipeline";
  assert.deepEqual(assessZohoReconciliation(input).reasons, ["REQUEST_HASH_MISMATCH"]);
  input.expected.dealPipeline = " invalid ";
  assert.deepEqual(assessZohoReconciliation(input).reasons, ["INVALID_INPUT"]);
});
function safe(result: ZohoReconciliationReport) {
  assert.equal(result.journalResolved, false); assert.equal(result.retryAllowed, false); assert.equal(result.journalMutationAllowed, false);
  assert.equal(result.status, "RECONCILIATION_REVIEW_ONLY");
  assert.equal(JSON.stringify(result).includes(privateText), false);
  assert.equal(JSON.stringify(result).includes("private@example.invalid"), false);
  assert.equal(JSON.stringify(result).includes(operationId), false);
  assert.ok(result.limitations.includes("READBACK_IS_NOT_CAUSAL_PROOF"));
  return result;
}

test("account profile is bound into reconciliation without weakening required Contact and Deal email evidence", () => {
  for (const profile of ["legacy-create-v1", "legacy-conversion-fields-v1"] as const) {
    const input = deal(profile, "standard-account-contact-email-v1");
    assert.equal(safe(assessZohoReconciliation(input)).decision, "confirmed-match");
    assert.equal("Email" in row(input, 0), false);
    for (const index of [1, 2]) {
      const missing = structuredClone(input); delete row(missing, index).Email;
      assert.equal(safe(assessZohoReconciliation(missing)).decision, "unknown");
    }
    if (input.expected.kind !== "deal.create") assert.fail("deal fixture");
    input.expected.accountPayloadProfile = "legacy-account-email-v1";
    assert.deepEqual(safe(assessZohoReconciliation(input)).reasons, ["REQUEST_HASH_MISMATCH"]);
    Object.assign(input.expected, { accountPayloadProfile: "automatic" });
    assert.deepEqual(safe(assessZohoReconciliation(input)).reasons, ["INVALID_INPUT"]);
  }
});

test("reconciliation verifies journal request/version/target binding before comparing requested stage values", () => {
  const input = stage(), before = JSON.stringify(input), result = safe(assessZohoReconciliation(input));
  assert.equal(result.decision, "confirmed-match"); assert.equal(result.bindingVerified, true);
  assert.deepEqual(result.resources[0]!.fields.map(field => [field.field, field.mode]), [
    ["Stage", "exact"], ["VZ_App_Status", "exact"], ["DealNumber", "presence"], ["SiteDealNumber", "presence"], ["Amount", "exact"],
  ]);
  assert.equal(JSON.stringify(input), before);
});

test("reconciliation stage readback compares exact decimal values without numeric rounding or guessed wire coercion", () => {
  const input = stage(); row(input).Amount = "9007199254740993.02";
  assert.equal(safe(assessZohoReconciliation(input)).decision, "mismatch");
  row(input).Amount = Number("9007199254740993");
  assert.equal(safe(assessZohoReconciliation(input)).decision, "unknown");
  row(input).Amount = null;
  assert.equal(safe(assessZohoReconciliation(input)).resources[0]!.fields.at(-1)!.reason, "FIELD_MISSING");
});

test("stage comparisons enforce app status and stage-specific number evidence without fabricating numbers", () => {
  const input = stage(); row(input).VZ_App_Status = "PRIVATE_OTHER_STAGE";
  assert.equal(safe(assessZohoReconciliation(input)).decision, "mismatch");
  row(input).VZ_App_Status = "Site Visit"; delete row(input).SiteDealNumber;
  assert.equal(safe(assessZohoReconciliation(input)).decision, "unknown");
});

test("reconciliation binds the explicit stage profile into its hash and compares mapped remote values without changing local stages", () => {
  for (const localStage of ["Site Visit", "Proposal/Price Quote", "Closed Won", "Closed Lost"] as const) {
    const input = stage(); assert.equal(input.expected.kind, "lead.stage");
    if (input.expected.kind !== "lead.stage") assert.fail("fixture must be a stage operation");
    input.expected.stagePayloadProfile = "voltronix-stage-labels-v1"; input.expected.request.stage = localStage;
    input.journal.requestHash = hash({ ...input.expected.request, stagePayloadProfile: input.expected.stagePayloadProfile });
    Object.assign(row(input), buildStageFields(localStage, input.expected.stagePayloadProfile), { QuoteDealNumber: privateText, JobDealNumber: privateText });
    assert.equal(safe(assessZohoReconciliation(input)).decision, "confirmed-match");
    row(input).VZ_App_Status = "PRIVATE_DIFFERENT_STATUS";
    assert.equal(safe(assessZohoReconciliation(input)).decision, "mismatch");
    input.expected.stagePayloadProfile = "legacy-stage-v1";
    assert.deepEqual(safe(assessZohoReconciliation(input)).reasons, ["REQUEST_HASH_MISMATCH"]);
  }
});

test("note create and edit compare receipt identity, parent relationship and only requested text", () => {
  for (const input of [note(), note(true), note(true, false)]) {
    assert.equal(safe(assessZohoReconciliation(input)).decision, "confirmed-match");
    row(input).Parent_Id = { id: "202" };
    assert.equal(safe(assessZohoReconciliation(input)).decision, "mismatch");
  }
  const omittedTitle = note(true, false); row(omittedTitle).Note_Title = "A later unrelated title";
  const result = safe(assessZohoReconciliation(omittedTitle));
  assert.equal(result.decision, "confirmed-match");
  assert.equal(result.resources[0]!.fields.some(field => field.field === "Note_Title"), false);
});

test("a known existing note/deal target can be inspected after lost acknowledgement but new unrecorded IDs cannot be guessed", () => {
  const edited = note(true); edited.journal.remoteReferences = {}; edited.journal.remoteId = null;
  assert.equal(safe(assessZohoReconciliation(edited)).decision, "confirmed-match");
  const staged = stage(); staged.journal.remoteReferences = {}; staged.journal.remoteId = null;
  assert.equal(safe(assessZohoReconciliation(staged)).decision, "confirmed-match");
  for (const input of [note(), product()]) {
    input.journal.remoteReferences = {}; input.journal.remoteId = null; input.observations = [];
    const result = safe(assessZohoReconciliation(input));
    assert.equal(result.decision, "unknown"); assert.deepEqual(result.resources[0]!.reasons, ["REFERENCE_MISSING"]);
  }
});

test("note readback requires the exact Deals parent module as well as its identifier", () => {
  for (const parent of [{ id: "201" }, { id: "201", module: null }, { id: "201", module: {} },
    { id: "201", module: { api_name: null } }, { id: "201", module: { api_name: 1 } }]) {
    const input = note(); row(input).Parent_Id = parent;
    assert.equal(safe(assessZohoReconciliation(input)).decision, "unknown");
  }
  for (const module of ["Contacts", "deals", privateText]) {
    const input = note(); row(input).Parent_Id = { id: "201", module: { api_name: module } };
    const result = safe(assessZohoReconciliation(input));
    assert.equal(result.decision, "mismatch");
    assert.ok(result.resources[0]!.fields.some(field => field.field === "Parent_Id.module.api_name" && field.reason === "FIELD_DIFFERENT"));
  }
});

test("product readback compares name and description rather than mere record existence", () => {
  const input = product(); assert.equal(safe(assessZohoReconciliation(input)).decision, "confirmed-match");
  row(input).Description = "PRIVATE_OTHER_DESCRIPTION";
  assert.equal(safe(assessZohoReconciliation(input)).decision, "mismatch");
  delete row(input).Description;
  assert.equal(safe(assessZohoReconciliation(input)).decision, "unknown");
});

test("deal review checks account/contact/deal relationships and source-requested fields under each explicit profile", () => {
  for (const profile of ["legacy-create-v1", "legacy-conversion-fields-v1"] as const) {
    const input = deal(profile), result = safe(assessZohoReconciliation(input));
    assert.equal(result.decision, "confirmed-match"); assert.deepEqual(result.resources.map(resource => resource.resource), ["account", "contact", "deal"]);
    row(input, 2).Contact_Name = { id: "602" };
    assert.equal(safe(assessZohoReconciliation(input)).decision, "mismatch");
  }
});

test("partial deal receipts remain partial evidence and cannot release or replay creation", () => {
  const input = deal(); input.journal.remoteReferences = { accountId: "501" }; input.journal.remoteId = "501";
  input.observations = input.observations.slice(0, 1);
  const result = safe(assessZohoReconciliation(input));
  assert.equal(result.decision, "unknown"); assert.deepEqual(result.resources.map(resource => resource.decision), ["confirmed-match", "unknown", "unknown"]);
});

test("forged operation, actor, request hash, local version, parent identity and note bindings fail before value review", () => {
  const changes: ((input: ZohoReconciliationInput) => void)[] = [
    input => { input.journal.requestHash = "0".repeat(64); }, input => { input.journal.actorUserId = "2"; },
    input => { input.journal.operationId = "03fde08f-35f7-4ef2-8140-163db71eca78"; },
    input => { input.localBinding!.version = 5; }, input => { input.localBinding!.taskId = "11"; },
    input => { input.localBinding!.externalId = "202"; }, input => { input.journal.remoteReferences = { dealId: "202" }; },
  ];
  for (const change of changes) {
    const input = stage(); change(input); const result = safe(assessZohoReconciliation(input));
    assert.equal(result.decision, "unknown"); assert.equal(result.bindingVerified, false); assert.deepEqual(result.resources, []);
  }
  const edited = note(true); edited.localBinding!.note!.externalId = "302";
  assert.deepEqual(safe(assessZohoReconciliation(edited)).reasons, ["LOCAL_BINDING_MISMATCH"]);
});

test("default normalization and explicit alternate profile participate in the original service request hashes", () => {
  const normalized = product();
  if (normalized.expected.kind === "product.create") normalized.expected.request.name = ` ${privateText} `;
  assert.equal(safe(assessZohoReconciliation(normalized)).decision, "confirmed-match");
  const input = deal(); if (input.expected.kind === "deal.create") input.expected.dealPayloadProfile = "legacy-conversion-fields-v1";
  assert.deepEqual(safe(assessZohoReconciliation(input)).reasons, ["REQUEST_HASH_MISMATCH"]);
  const edited = note(true, false); if (edited.expected.kind === "note.edit") edited.expected.request.title = "";
  assert.deepEqual(safe(assessZohoReconciliation(edited)).reasons, ["REQUEST_HASH_MISMATCH"]);
});

test("observed empty or204 readback is missing evidence, never permission to repeat or release a write", () => {
  for (const response of [{ status: 204, body: null }, { status: 200, body: { data: [] } }]) {
    const input = product(); input.observations[0]!.response = response;
    const result = safe(assessZohoReconciliation(input)); assert.equal(result.decision, "missing");
    assert.deepEqual(result.resources[0]!.reasons, ["RECORD_NOT_RETURNED"]);
  }
});

test("authorization/not-found/quota/transport statuses remain unknown and do not echo provider text", () => {
  for (const status of [201, 202, 206, 301, 401, 403, 404, 429, 500]) {
    const input = product(); input.observations[0]!.response = { status, body: { message: privateText } };
    assert.equal(safe(assessZohoReconciliation(input)).decision, "unknown");
  }
});

test("malformed, ambiguous, partial, error-bearing and wrong-record response envelopes cannot confirm an operation", () => {
  for (const body of [null, {}, { data: [] , error: privateText }, { data: [row(product())], info: { more_records: true } },
    { data: [row(product()), row(product())] }, { data: [{ ...row(product()), id: "402" }] }]) {
    const input = product(); input.observations[0]!.response.body = body;
    assert.equal(safe(assessZohoReconciliation(input)).decision, "unknown");
  }
  const noContent = product(); noContent.observations[0]!.response = { status: 204, body: { data: [] } };
  assert.equal(safe(assessZohoReconciliation(noContent)).decision, "unknown");
});

test("matching field values with row-level error or status markers never confirm reconciliation", () => {
  for (const key of ["code", "error", "errors", "status", "message"]) {
    for (const build of [stage, note, product, deal]) {
      const input = build(); row(input)[key] = privateText;
      const result = safe(assessZohoReconciliation(input));
      assert.equal(result.decision, "unknown");
      assert.deepEqual(result.resources[0]!.reasons, ["RESPONSE_INVALID"]);
    }
  }
});

test("missing, duplicate and unrelated observations are reported without IDs or customer values", () => {
  const missing = product(); missing.observations = [];
  assert.deepEqual(safe(assessZohoReconciliation(missing)).resources[0]!.reasons, ["OBSERVATION_MISSING"]);
  const duplicate = product(); duplicate.observations.push(duplicate.observations[0]!);
  assert.deepEqual(safe(assessZohoReconciliation(duplicate)).reasons, ["OBSERVATION_AMBIGUOUS"]);
  const unrelated = product(); unrelated.observations[0]!.id = "999";
  assert.deepEqual(safe(assessZohoReconciliation(unrelated)).reasons, ["OBSERVATION_NOT_BOUND"]);
});

test("inflight, completed and no-remote-effect journals cannot receive an actionable reconciliation verdict", () => {
  for (const state of ["inflight", "completed"] as const) {
    const input = product(); input.journal.state = state;
    assert.deepEqual(safe(assessZohoReconciliation(input)).reasons, ["JOURNAL_NOT_RECONCILIATION"]);
  }
  const input = product(); input.journal.remoteEffectPossible = false;
  assert.deepEqual(safe(assessZohoReconciliation(input)).reasons, ["REMOTE_EFFECT_NOT_RECORDED"]);
});

test("quotation reconciliation is explicitly unsupported until financial mappings and persistence policy are established", () => {
  for (const kind of ["quote.create", "quote.edit"] as const) {
    const input = product(); input.journal.kind = kind; input.expected = { kind };
    assert.deepEqual(safe(assessZohoReconciliation(input)).reasons, ["UNSUPPORTED_QUOTATION"]);
  }
});

test("strict bounded input rejects unknown contracts, synthetic IDs, oversized readbacks and cyclic or throwing objects safely", () => {
  const synthetic = product(); synthetic.journal.remoteReferences.productId = "9".repeat(40);
  const oversized = product(); row(oversized).Description = privateText.repeat(100_000);
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const input of [null, { ...product(), apply: true }, { ...product(), apply: undefined }, synthetic, oversized, cycle,
    { toJSON() { throw new Error(privateText); } }, { ...product(), expected: { ...product().expected, unknown: privateText } }]) {
    assert.deepEqual(safe(assessZohoReconciliation(input)).reasons, ["INVALID_INPUT"]);
  }
});
