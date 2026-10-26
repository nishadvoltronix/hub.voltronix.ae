import assert from "node:assert/strict";
import test from "node:test";
import { buildAccountPayload, buildContactPayload, buildDealPayload, DEAL_PAYLOAD_PROFILES,
  ACCOUNT_PAYLOAD_PROFILES, parseAccountPayloadProfile, parseDealPayloadProfile, parseDealPipeline, type AccountPayloadProfile, type DealPayloadProfile } from "../src/crm/commercial/deals.js";
import { CommercialError } from "../src/crm/commercial/validation.js";

// Pure synthetic source-contract tests: no tenant metadata, credentials, I/O or
// runtime acceptance. Profile selection is deliberately not an environment flag.
const input = Object.freeze({ firstName: "Synthetic", lastName: "Contact", companyName: "Synthetic company",
  email: "synthetic@example.invalid", mobile: "+971 0000001", phone: "+971 0000002",
  department: "VOLTRONIX CONTRACTING LLC", poBox: "PBOX-001", trn: "00000000", address: "Synthetic address\nSecond line",
  description: "Synthetic description" });
const links = Object.freeze({ accountId: "601", contactId: "701", assignedExternalId: "801" });
const invalid = (error: unknown) => error instanceof CommercialError && error.status === 400;

test("pipeline is an explicit exact bounded selection and never changes legacy defaults or local business fields", () => {
  assert.equal("Pipeline" in buildDealPayload(input, links).data[0]!, false);
  for (const profile of DEAL_PAYLOAD_PROFILES) {
    const result = buildDealPayload(input, links, profile, "Synthetic Pipeline (Standard)").data[0]!;
    assert.equal(result.Pipeline, "Synthetic Pipeline (Standard)"); assert.equal(result.Stage, "Qualification");
    assert.equal(result.VZ_App_Status, "Pending"); assert.equal(result.Email, input.email);
    assert.equal(parseDealPipeline("Synthetic Pipeline (Standard)"), result.Pipeline);
  }
  for (const value of [null, "", " leading", "trailing ", "A\nB", "A\u007fB", "x".repeat(101), {}, ["Synthetic"]]) {
    assert.throws(() => parseDealPipeline(value), invalid);
    assert.throws(() => buildDealPayload(input, links, "legacy-create-v1", value as string), invalid);
  }
  assert.throws(() => buildDealPayload({ ...input, Pipeline: "Injected" }, links), invalid);
});

test("account profiles are explicit and preserve email on Contact and Deal when Accounts has no custom Email", () => {
  assert.deepEqual(ACCOUNT_PAYLOAD_PROFILES, ["legacy-account-email-v1", "standard-account-contact-email-v1"]);
  assert.equal(Object.isFrozen(ACCOUNT_PAYLOAD_PROFILES), true);
  const expected = { data: [{ Account_Name: input.companyName, Phone: input.phone, Email: input.email, Owner: { id: "501" } }] };
  assert.deepEqual(buildAccountPayload(input, "501"), expected);
  assert.deepEqual(buildAccountPayload(input, "501", "legacy-account-email-v1"), expected);
  const selected = "standard-account-contact-email-v1";
  assert.equal(parseAccountPayloadProfile(selected), selected);
  assert.deepEqual(buildAccountPayload(input, "501", selected), {
    data: [{ Account_Name: input.companyName, Phone: input.phone, Owner: { id: "501" } }],
  });
  assert.equal(buildContactPayload(input, links.accountId).data[0]!.Email, input.email);
  for (const profile of DEAL_PAYLOAD_PROFILES) assert.equal(buildDealPayload(input, links, profile).data[0]!.Email, input.email);
  for (const email of [undefined, "", "invalid"]) assert.throws(() => buildAccountPayload({ ...input, email }, "501", selected), invalid);
  assert.throws(() => buildAccountPayload(input, "invalid-owner", selected), invalid);
  assert.throws(() => buildAccountPayload({ ...input, accountPayloadProfile: selected }, "501", selected), invalid);
  for (const value of [undefined, null, "", "automatic", "standard-account-contact-email-v1\n", {}, [selected]]) {
    assert.throws(() => parseAccountPayloadProfile(value), invalid);
    if (value !== undefined) assert.throws(() => buildAccountPayload(input, "501", value as AccountPayloadProfile), invalid);
  }
});

test("deal source profiles are a frozen exact enum and reject unrecognized or injected choices", () => {
  assert.deepEqual(DEAL_PAYLOAD_PROFILES, ["legacy-create-v1", "legacy-conversion-fields-v1"]);
  assert.equal(Object.isFrozen(DEAL_PAYLOAD_PROFILES), true);
  for (const profile of DEAL_PAYLOAD_PROFILES) assert.equal(parseDealPayloadProfile(profile), profile);
  for (const profile of [undefined, null, "", "legacy-create-v2", "LEGACY-CREATE-V1", " legacy-create-v1", "legacy-create-v1\n",
    "__proto__", "Department=Assign_Department1", { department: "Assign_Department1", poBox: "P_BOX" }, ["legacy-create-v1"], true, 1]) {
    assert.throws(() => parseDealPayloadProfile(profile), invalid);
    // The optional argument alone may be undefined; callers validating an
    // explicitly configured value use the strict parser before reservation.
    if (profile !== undefined) assert.throws(() => buildDealPayload(input, links, profile as DealPayloadProfile), invalid);
  }
});

test("omitted or explicit default profile preserves the complete original deal contract", () => {
  const expected = { data: [{ Deal_Name: "Synthetic Contact", Stage: "Qualification", VZ_App_Status: "Pending",
    Description: input.description, Email: input.email, Mobile: input.mobile, Phone: input.phone,
    Account_Name: { id: links.accountId }, Contact_Name: { id: links.contactId }, VZ_app_user: { id: links.assignedExternalId },
    Address: input.address, P_Box: input.poBox, TRN: input.trn, Department: input.department }] };
  assert.deepEqual(buildDealPayload(input, links), expected);
  assert.deepEqual(buildDealPayload(input, links, "legacy-create-v1"), expected);
  assert.deepEqual(buildDealPayload(input, links, undefined), expected);
});

test("alternate profile changes only the two source-backed API names without losing or duplicating data", () => {
  const current = buildDealPayload(input, links).data[0]!;
  const alternate = buildDealPayload(input, links, "legacy-conversion-fields-v1").data[0]!;
  const expected: Record<string, unknown> = { ...current };
  delete expected.Department; delete expected.P_Box;
  expected.Assign_Department1 = input.department; expected.P_BOX = input.poBox;
  assert.deepEqual(alternate, expected);
  assert.equal("Department" in alternate, false); assert.equal("P_Box" in alternate, false);
  assert.equal("Assign_Department1" in current, false); assert.equal("P_BOX" in current, false);
  assert.equal(alternate.Email, input.email); assert.equal(alternate.Stage, "Qualification"); assert.equal(alternate.VZ_App_Status, "Pending");
  assert.equal("Owner" in alternate, false); assert.equal("EnquiryNumber" in alternate, false);
  assert.equal(Object.keys(alternate).length, Object.keys(current).length);
});

test("both profiles preserve company selection and omit only blank conditional address/tax/PO-box fields", () => {
  for (const profile of DEAL_PAYLOAD_PROFILES) for (const department of ["VOLTRONIX CONTRACTING LLC", "VOLTRONIX SWITCHGEAR LLC"]) {
    const result = buildDealPayload({ ...input, department, address: " \n ", poBox: "  ", trn: " " }, links, profile).data[0]!;
    assert.equal("Address" in result, false); assert.equal("TRN" in result, false);
    assert.equal("P_BOX" in result, false); assert.equal("P_Box" in result, false);
    assert.equal("Department" in result ? result.Department : result.Assign_Department1, department);
    assert.equal(result.Email, input.email); assert.equal(result.Description, input.description);
  }
});

test("profile selection cannot inject raw API keys, override stages or introduce unsupported company values", () => {
  for (const profile of DEAL_PAYLOAD_PROFILES) for (const patch of [
    { Department: "Injected" }, { Assign_Department1: "Injected" }, { P_BOX: "Injected" }, { P_Box: "Injected" },
    { Stage: "Closed Won" }, { VZ_App_Status: "Closed Won" }, { payloadProfile: profile },
    { department: "Injected company" }, { department: "VOLTRONIX CONTRACTING LLC\n" },
  ]) assert.throws(() => buildDealPayload({ ...input, ...patch }, links, profile), invalid);
});

test("both profiles enforce existing relationship identifier validation without changing valid exact IDs", () => {
  const valid = { accountId: "9007199254740993", contactId: "9007199254740995", assignedExternalId: "9007199254740997" };
  for (const profile of DEAL_PAYLOAD_PROFILES) {
    const result = buildDealPayload(input, valid, profile).data[0]!;
    assert.deepEqual(result.Account_Name, { id: valid.accountId }); assert.deepEqual(result.Contact_Name, { id: valid.contactId });
    assert.deepEqual(result.VZ_app_user, { id: valid.assignedExternalId });
    for (const field of ["accountId", "contactId", "assignedExternalId"] as const) for (const id of ["", "0", "01", "-1", "1/Notes", "1 OR 1=1", "1\n", "1".repeat(41)]) {
      assert.throws(() => buildDealPayload(input, { ...links, [field]: id }, profile), invalid);
    }
  }
});

test("source-profile building leaves inputs and account/contact email contracts unchanged", () => {
  const original = structuredClone(input), originalLinks = structuredClone(links);
  const account = buildAccountPayload(input, "501"), contact = buildContactPayload(input, links.accountId);
  for (const profile of DEAL_PAYLOAD_PROFILES) buildDealPayload(input, links, profile);
  assert.deepEqual(input, original); assert.deepEqual(links, originalLinks);
  assert.deepEqual(buildAccountPayload(input, "501"), account); assert.deepEqual(buildContactPayload(input, links.accountId), contact);
  assert.equal(account.data[0]!.Email, input.email); assert.equal(contact.data[0]!.Email, input.email);
});
