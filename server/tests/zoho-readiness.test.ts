import assert from "node:assert/strict";
import { test } from "node:test";
import { checkZohoReadiness, zohoFieldRequirements, type ZohoReadinessModule,
  type ZohoReadinessPort, type ZohoReadinessReport } from "../src/integrations/zoho/readiness.js";
import { ZohoClientError } from "../src/integrations/zoho/client.js";
import type { ZohoReadinessProfiles } from "../src/integrations/zoho/readiness.js";

interface FakeField {
  api_name: string;
  field_read_only?: boolean;
  read_only?: boolean;
  operation_type?: { api_create?: boolean; api_update?: boolean };
  system_mandatory?: boolean;
  custom_field?: boolean;
  data_type?: string;
  pick_list_values?: { actual_value: string; display_value?: string }[];
  [key: string]: unknown;
}
function metadata(module: ZohoReadinessModule): { fields: FakeField[] } {
  return { fields: zohoFieldRequirements.find(expected => expected.module === module)!.fields.filter(field => !field.nested).map(field => ({
    api_name: field.field, field_read_only: false, read_only: false,
    operation_type: { api_create: true, api_update: true }, system_mandatory: false, custom_field: false,
    data_type: field.picklistValues ? "picklist" : "text",
    pick_list_values: (field.picklistValues ?? []).map(actual_value => ({ actual_value })),
  })) };
}
function fixture(change?: (module: ZohoReadinessModule, body: { fields: FakeField[] }) => { status: number; body: unknown }) {
  const calls: Parameters<ZohoReadinessPort["request"]>[0][] = [];
  const port: ZohoReadinessPort = { async request(input) {
    calls.push(input);
    const module = input.path.split("=")[1] as ZohoReadinessModule;
    const body = metadata(module);
    return change ? change(module, body) : { status: 200, body };
  } };
  return { calls, port };
}
function moduleReport(report: ZohoReadinessReport, name: ZohoReadinessModule) {
  const result = report.modules.find(module => module.module === name); assert.ok(result); return result;
}
function fieldReport(report: ZohoReadinessReport, module: ZohoReadinessModule, name: string) {
  const field = moduleReport(report, module).fields.find(field => field.field === name); assert.ok(field); return field;
}

test("explicit payload profiles check the same deal fields and actual stage values the selected writes use", async () => {
  const profiles = { dealPayloadProfile: "legacy-conversion-fields-v1", stagePayloadProfile: "voltronix-stage-labels-v1" } as const;
  const fake = fixture((module, body) => {
    if (module === "Deals") {
      body.fields.find(field => field.api_name === "Department")!.api_name = "Assign_Department1";
      const poBox = body.fields.find(field => field.api_name === "P_Box")!; poBox.api_name = "P_BOX"; poBox.data_type = "text";
      body.fields.find(field => field.api_name === "Stage")!.pick_list_values = ["Qualification", "Needs Analysis", "Proposal/Price Quote", "Closed Won", "Closed Lost"].map(actual_value => ({ actual_value }));
      body.fields.find(field => field.api_name === "VZ_App_Status")!.pick_list_values = ["Pending", "Site Visit", "Proposal", "Close to Won", "Close to Lost"].map(actual_value => ({ actual_value }));
    }
    return { status: 200, body };
  });
  const report = await checkZohoReadiness(fake.port, profiles);
  assert.deepEqual(report.selectedProfiles, profiles);
  for (const name of ["Assign_Department1", "P_BOX", "Stage", "VZ_App_Status"]) assert.deepEqual(fieldReport(report, "Deals", name).checks, ["FIELD_PRESENT"]);
  assert.ok(!moduleReport(report, "Deals").fields.some(field => ["Department", "P_Box"].includes(field.field)));
  assert.ok(report.sourceCandidates.every(candidate => candidate.selectionApplied));
  assert.ok(!report.limitations.includes("SOURCE_CANDIDATES_NOT_SELECTED"));
  assert.equal(report.runtimeIntegrationVerified, false); assert.equal(report.quotationMappingVerified, false);
  assert.equal(fake.calls.length, 5);
  // The unselected legacy inspector must retain its original expectations.
  const original = await checkZohoReadiness(fake.port);
  assert.equal(original.selectedProfiles, undefined);
  assert.deepEqual(fieldReport(original, "Deals", "Department").checks, ["REQUIRED_FIELD_MISSING"]);
  assert.ok(fieldReport(original, "Deals", "Stage").checks.includes("EXPECTED_PICKLIST_VALUES_MISSING"));
  assert.ok(original.sourceCandidates.every(candidate => !candidate.selectionApplied));
});

test("explicit production reference profile checks Records display values without changing older metadata expectations", async () => {
  const fake = fixture((module, body) => {
    if (module === "Deals") {
      body.fields.find(field => field.api_name === "Stage")!.pick_list_values = ["Qualification", "Needs Analysis", "Proposal/Price Quote", "Closed Won", "Closed Lost"]
        .map(actual_value => ({ actual_value, display_value: actual_value === "Needs Analysis" ? "Site Visit" : actual_value }));
      body.fields.find(field => field.api_name === "VZ_App_Status")!.pick_list_values = ["Pending", "Site Visit", "Proposal", "Close to Won", "Close to Lost"]
        .map(actual_value => ({ actual_value, display_value: actual_value }));
    }
    return { status: 200, body };
  });
  const report = await checkZohoReadiness(fake.port, { dealPayloadProfile: "legacy-create-v1", stagePayloadProfile: "voltronix-stage-reference-values-v1" });
  assert.deepEqual(fieldReport(report, "Deals", "Stage").checks, ["FIELD_PRESENT"]);
  assert.deepEqual(fieldReport(report, "Deals", "VZ_App_Status").checks, ["FIELD_PRESENT"]);
  assert.equal(report.runtimeIntegrationVerified, false);
});

test("an explicit account profile removes only Accounts.Email while retaining Contact/Deal email and owner review", async () => {
  const profiles = { dealPayloadProfile: "legacy-create-v1", stagePayloadProfile: "legacy-stage-v1",
    accountPayloadProfile: "standard-account-contact-email-v1" } as const;
  const fake = fixture((module, body) => {
    if (module === "Accounts") {
      body.fields = body.fields.filter(field => field.api_name !== "Email");
      body.fields.find(field => field.api_name === "Owner")!.field_read_only = true;
    }
    return { status: 200, body };
  });
  const report = await checkZohoReadiness(fake.port, profiles);
  assert.deepEqual(report.selectedProfiles, profiles);
  assert.equal(moduleReport(report, "Accounts").fields.some(field => field.field === "Email"), false);
  for (const module of ["Contacts", "Deals"] as const) assert.equal(fieldReport(report, module, "Email").requirement, "required");
  assert.ok(fieldReport(report, "Accounts", "Owner").checks.includes("FIELD_READ_ONLY"));
  assert.equal(report.summary.requiredFields, 50); assert.equal(report.runtimeIntegrationVerified, false);
  const legacy = await checkZohoReadiness(fake.port, { ...profiles, accountPayloadProfile: "legacy-account-email-v1" });
  assert.deepEqual(fieldReport(legacy, "Accounts", "Email").checks, ["REQUIRED_FIELD_MISSING"]);
  assert.equal(legacy.summary.requiredFields, 51);
});

test("explicit pipeline readiness checks the exact configured value and never discovers a default selection", async () => {
  const profiles = { dealPayloadProfile: "legacy-create-v1", stagePayloadProfile: "legacy-stage-v1", dealPipeline: "Synthetic pipeline" } as const;
  const fake = fixture((module, body) => {
    if (module === "Deals") body.fields.push({ api_name: "Pipeline", data_type: "picklist", field_read_only: false, read_only: false,
      operation_type: { api_create: true }, system_mandatory: true, pick_list_values: [{ actual_value: "Synthetic pipeline" }] });
    return { status: 200, body };
  });
  assert.deepEqual(fieldReport(await checkZohoReadiness(fake.port, profiles), "Deals", "Pipeline").checks, ["FIELD_PRESENT"]);
  const mismatch = await checkZohoReadiness(fake.port, { ...profiles, dealPipeline: "Other pipeline" });
  assert.deepEqual(fieldReport(mismatch, "Deals", "Pipeline").missingExpectedPicklistValues, ["Other pipeline"]);
  const defaults = await checkZohoReadiness(fake.port);
  assert.equal(moduleReport(defaults, "Deals").fields.some(field => field.field === "Pipeline"), false);
  assert.equal(moduleReport(defaults, "Deals").unknownMandatoryFieldCount, 1);
});

test("invalid or throwing profile selections fail before metadata I/O without exposing values", async () => {
  const fake = fixture();
  for (const profiles of [{ dealPayloadProfile: "private-marker", stagePayloadProfile: "legacy-stage-v1" },
    { dealPayloadProfile: "legacy-create-v1", stagePayloadProfile: "legacy-stage-v1", dealPipeline: " invalid " },
    { dealPayloadProfile: "legacy-create-v1", stagePayloadProfile: "legacy-stage-v1", accountPayloadProfile: "private-marker" },
    { dealPayloadProfile: "legacy-create-v1", stagePayloadProfile: "legacy-stage-v1", accountPayloadProfile: null },
    { dealPayloadProfile: "legacy-create-v1" }, { dealPayloadProfile: "legacy-create-v1", stagePayloadProfile: "legacy-stage-v1", endpoint: "private-marker" },
    { get dealPayloadProfile() { throw new Error("private-marker"); }, stagePayloadProfile: "legacy-stage-v1" }]) {
    await assert.rejects(checkZohoReadiness(fake.port, profiles as ZohoReadinessProfiles), error => {
      assert.ok(error instanceof ZohoClientError); assert.equal(error.code, "CONFIG_INVALID");
      assert.doesNotMatch(String(error.stack), /private-marker/); return true;
    });
  }
  assert.equal(fake.calls.length, 0);
});

test("readiness performs only five fixed metadata GETs and reports six modules without certifying integration", async () => {
  const fake = fixture(), report = await checkZohoReadiness(fake.port);
  assert.deepEqual(fake.calls, ["Accounts", "Contacts", "Deals", "Products", "Quotes"].map(module => ({
    apiVersion: "v8", method: "GET", path: `/settings/fields?module=${module}`,
  })));
  assert.equal(report.modules.length, 6);
  assert.equal(report.summary.requestedModules, 5);
  assert.equal(report.summary.observedModules, 5);
  assert.equal(report.status, "METADATA_REVIEW_ONLY");
  for (const flag of [report.runtimeIntegrationVerified, report.dataCompatibilityVerified,
    report.schemaCompatibilityVerified, report.quotationMappingVerified]) assert.equal(flag, false);
  assert.equal(moduleReport(report, "Accounts").status, "OBSERVED");
  assert.equal(moduleReport(report, "Notes").status, "UNVERIFIED");
  assert.deepEqual(moduleReport(report, "Notes").checks, ["FIELD_METADATA_NOT_SUPPORTED"]);
  assert.equal(fieldReport(report, "Notes", "Note_Content").observed, null);
  assert.ok(report.limitations.includes("LAYOUT_MANDATORY_RULES_NOT_VERIFIED"));
  assert.ok(report.limitations.includes("FIELD_VISIBILITY_NOT_AUTHORIZATION"));
  assert.ok(report.limitations.includes("API_VERSION_PARITY_NOT_VERIFIED"));
});

test("required emitted fields and optional conditional or readback fields are distinguished", async () => {
  const fake = fixture((module, body) => {
    if (module === "Deals") body.fields = body.fields.filter(field => !["DealNumber", "P_Box", "LostDealNumber"].includes(field.api_name));
    return { status: 200, body };
  });
  const report = await checkZohoReadiness(fake.port);
  assert.deepEqual(fieldReport(report, "Deals", "DealNumber").checks, ["REQUIRED_FIELD_MISSING"]);
  for (const name of ["P_Box", "LostDealNumber"]) {
    assert.equal(fieldReport(report, "Deals", name).requirement, "optional");
    assert.deepEqual(fieldReport(report, "Deals", name).checks, ["OPTIONAL_FIELD_MISSING"]);
  }
  assert.equal(moduleReport(report, "Deals").status, "REVIEW_REQUIRED");
});

test("duplicate and case-mismatched API names cannot establish a known-field match", async () => {
  const fake = fixture((module, body) => {
    if (module === "Accounts") body.fields.push({ ...body.fields[0]! });
    if (module === "Products") body.fields.find(field => field.api_name === "Product_Name")!.api_name = "product_name";
    return { status: 200, body };
  });
  const report = await checkZohoReadiness(fake.port);
  assert.deepEqual(fieldReport(report, "Accounts", "Account_Name").checks, ["AMBIGUOUS_FIELD"]);
  assert.equal(fieldReport(report, "Accounts", "Account_Name").observed, false);
  assert.deepEqual(fieldReport(report, "Products", "Product_Name").checks, ["FIELD_API_NAME_CASE_MISMATCH"]);
});

test("documented read-only and API operation flags are checked only for source-requested writes", async () => {
  const fake = fixture((module, body) => {
    if (module === "Accounts") body.fields.find(field => field.api_name === "Phone")!.read_only = true;
    if (module === "Contacts") body.fields.find(field => field.api_name === "First_Name")!.operation_type!.api_create = false;
    if (module === "Deals") {
      body.fields.find(field => field.api_name === "Stage")!.operation_type!.api_update = false;
      body.fields.find(field => field.api_name === "DealNumber")!.field_read_only = true;
      body.fields.find(field => field.api_name === "DealNumber")!.operation_type = { api_create: false, api_update: false };
    }
    return { status: 200, body };
  });
  const report = await checkZohoReadiness(fake.port);
  assert.ok(fieldReport(report, "Accounts", "Phone").checks.includes("FIELD_READ_ONLY"));
  assert.ok(fieldReport(report, "Contacts", "First_Name").checks.includes("CREATE_NOT_SUPPORTED"));
  assert.ok(fieldReport(report, "Deals", "Stage").checks.includes("UPDATE_NOT_SUPPORTED"));
  assert.deepEqual(fieldReport(report, "Deals", "DealNumber").checks, ["FIELD_PRESENT"]);
});

test("missing write metadata is unknown rather than writable and optional flags are not invented", async () => {
  const fake = fixture((module, body) => {
    if (module === "Products") {
      const field = body.fields.find(field => field.api_name === "Product_Name")!;
      delete field.operation_type; delete field.read_only;
    }
    return { status: 200, body };
  });
  const report = await checkZohoReadiness(fake.port);
  assert.deepEqual(fieldReport(report, "Products", "Product_Name").checks, ["FIELD_PRESENT", "WRITE_METADATA_UNAVAILABLE"]);
});

test("unknown system-mandatory custom fields produce aggregate review without names or raw metadata", async () => {
  const privateMarker = "TenantPrivateMarker";
  const fake = fixture((module, body) => {
    if (module === "Deals") body.fields.push({ api_name: privateMarker, system_mandatory: true, custom_field: true,
      field_label: "Private business label", default_value: "SyntheticSecretValue", id: "111111111111111111" });
    return { status: 200, body };
  });
  const report = await checkZohoReadiness(fake.port), deals = moduleReport(report, "Deals");
  assert.equal(deals.unknownMandatoryFieldCount, 1);
  assert.equal(deals.unknownCustomMandatoryFieldCount, 1);
  assert.ok(deals.checks.includes("UNKNOWN_CUSTOM_MANDATORY_FIELDS_REVIEW"));
  const text = JSON.stringify(report);
  for (const secret of [privateMarker, "Private business label", "SyntheticSecretValue", "111111111111111111"]) assert.ok(!text.includes(secret));
});

test("undocumented mandatory flags do not become a false layout mandatory contract", async () => {
  const fake = fixture((module, body) => {
    if (module === "Contacts") body.fields.push({ api_name: "PrivateLayoutField", custom_field: true, mandatory: true, required: true });
    return { status: 200, body };
  });
  const report = await checkZohoReadiness(fake.port);
  assert.equal(moduleReport(report, "Contacts").unknownMandatoryFieldCount, 0);
  assert.ok(report.limitations.includes("LAYOUT_MANDATORY_RULES_NOT_VERIFIED"));
  assert.ok(!JSON.stringify(report).includes("PrivateLayoutField"));
});

test("stage checks compare actual values, never translated display labels, without exposing tenant options", async () => {
  const fake = fixture((module, body) => {
    if (module === "Deals") body.fields.find(field => field.api_name === "Stage")!.pick_list_values = [
      { actual_value: "PrivateStageMarker", display_value: "Qualification" },
    ];
    return { status: 200, body };
  });
  const report = await checkZohoReadiness(fake.port);
  assert.ok(fieldReport(report, "Deals", "Stage").checks.includes("EXPECTED_PICKLIST_VALUES_MISSING"));
  assert.ok(!JSON.stringify(report).includes("PrivateStageMarker"));
  for (const variant of ["absent", "wrong-type"] as const) {
    const modified = fixture((module, body) => {
      if (module === "Deals") {
        const stage = body.fields.find(field => field.api_name === "Stage")!;
        if (variant === "absent") delete stage.pick_list_values; else stage.data_type = "text";
      }
      return { status: 200, body };
    });
    const result = await checkZohoReadiness(modified.port);
    assert.ok(fieldReport(result, "Deals", "Stage").checks.includes(variant === "absent" ? "PICKLIST_VALUES_UNAVAILABLE" : "PICKLIST_TYPE_REVIEW"));
  }
});

test("quote top-level matches never certify nested line keys, percentages or financial totals", async () => {
  const report = await checkZohoReadiness(fixture().port), quotes = moduleReport(report, "Quotes");
  const nested = quotes.fields.filter(field => field.field.startsWith("Quoted_Items."));
  assert.deepEqual(nested.map(field => field.field), ["Quoted_Items.Product_Name", "Quoted_Items.Quantity", "Quoted_Items.List_Price",
    "Quoted_Items.ItemDiscount", "Quoted_Items.U_O_M", "Quoted_Items.Description"]);
  for (const field of nested) {
    assert.equal(field.observed, null);
    assert.deepEqual(field.checks, ["NESTED_FIELD_METADATA_NOT_CHECKED"]);
  }
  assert.equal(fieldReport(report, "Quotes", "Amount").observed, true);
  assert.equal(report.quotationMappingVerified, false);
  assert.equal(quotes.status, "REVIEW_REQUIRED");
  assert.ok(report.limitations.includes("QUOTATION_FINANCIAL_MAPPING_NOT_VERIFIED"));
});

test("204 and HTTP failures cannot be treated as empty successful metadata or leak response bodies", async () => {
  for (const [status, code] of [[204, "METADATA_EMPTY"], [401, "METADATA_ACCESS_DENIED"], [403, "METADATA_ACCESS_DENIED"],
    [429, "METADATA_RATE_LIMITED"], [500, "METADATA_REQUEST_FAILED"]] as const) {
    const fake = fixture(() => ({ status, body: { fields: metadata("Accounts").fields, message: "SyntheticSecretMarker" } }));
    const report = await checkZohoReadiness(fake.port);
    assert.deepEqual(moduleReport(report, "Accounts").checks, [code]);
    assert.equal(moduleReport(report, "Accounts").status, "UNAVAILABLE");
    assert.equal(report.summary.observedModules, 0);
    assert.equal(fake.calls.length, 5);
    assert.ok(!JSON.stringify(report).includes("SyntheticSecretMarker"));
  }
});

test("malformed or over-limit metadata is unavailable, bounded and redacted", async () => {
  for (const body of [undefined, null, "SyntheticSecretMarker", {}, { fields: null }, { fields: [{ field_label: "SyntheticSecretMarker" }] },
    { fields: [{ api_name: "Account_Name", read_only: "false" }] },
    { fields: [{ api_name: "Account_Name", pick_list_values: [{ display_value: "SyntheticSecretMarker" }] }] },
    { fields: Array.from({ length: 2049 }, () => ({ api_name: "PrivateField" })) }]) {
    const report = await checkZohoReadiness(fixture(() => ({ status: 200, body })).port);
    assert.deepEqual(moduleReport(report, "Accounts").checks, ["METADATA_MALFORMED"]);
    assert.equal(fieldReport(report, "Accounts", "Account_Name").observed, null);
    assert.ok(!JSON.stringify(report).includes("SyntheticSecretMarker"));
  }
  const empty = await checkZohoReadiness(fixture(() => ({ status: 200, body: { fields: [] } })).port);
  assert.deepEqual(moduleReport(empty, "Accounts").checks, ["METADATA_EMPTY"]);
});

test("transport exceptions and invalid statuses are not logged, retried or reflected", async context => {
  const logs: unknown[][] = [];
  context.mock.method(console, "log", (...args: unknown[]) => { logs.push(args); });
  context.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  let calls = 0;
  const report = await checkZohoReadiness({ async request() { calls++; throw new Error("SyntheticSecretMarker"); } });
  assert.equal(calls, 5);
  assert.equal(report.summary.observedModules, 0);
  assert.ok(!JSON.stringify(report).includes("SyntheticSecretMarker"));
  assert.deepEqual(logs, []);
  const malformed = await checkZohoReadiness(fixture(() => ({ status: Number.NaN, body: metadata("Accounts") })).port);
  assert.deepEqual(moduleReport(malformed, "Accounts").checks, ["METADATA_MALFORMED"]);
});

test("readiness preserves safe access and quota classifications from the real throwing client", async () => {
  for (const [status, code] of [[401, "METADATA_ACCESS_DENIED"], [403, "METADATA_ACCESS_DENIED"],
    [429, "METADATA_RATE_LIMITED"], [500, "METADATA_REQUEST_FAILED"]] as const) {
    let calls = 0;
    const report = await checkZohoReadiness({ async request() { calls++; throw new ZohoClientError("HTTP_FAILED", status); } });
    assert.equal(calls, 5);
    assert.deepEqual(moduleReport(report, "Accounts").checks, [code]);
    assert.equal(report.summary.observedModules, 0);
  }
  const arbitrary = { get httpStatus() { throw new Error("SyntheticSecretMarker"); }, message: "SyntheticSecretMarker" };
  const report = await checkZohoReadiness({ async request() { throw arbitrary; } });
  assert.deepEqual(moduleReport(report, "Accounts").checks, ["METADATA_REQUEST_FAILED"]);
  assert.ok(!JSON.stringify(report).includes("SyntheticSecretMarker"));
});

test("metadata error envelopes cannot masquerade as successful field observations", async () => {
  for (const extra of [{ error: "SyntheticSecretMarker" }, { code: "OAUTH_SCOPE_MISMATCH" }, { error: null }, { code: null }]) {
    const report = await checkZohoReadiness(fixture((_module, body) => ({ status: 200, body: { ...body, ...extra } })).port);
    assert.equal(report.summary.observedModules, 0);
    assert.deepEqual(moduleReport(report, "Accounts").checks, ["METADATA_MALFORMED"]);
    assert.ok(!JSON.stringify(report).includes("SyntheticSecretMarker"));
  }
});

test("source candidates are inspected from the same Deals response without replacing the active contract", async () => {
  const fake = fixture((module, body) => {
    if (module === "Deals") {
      const department = body.fields.find(value => value.api_name === "Department")!;
      department.api_name = "Assign_Department1";
      body.fields.find(value => value.api_name === "P_Box")!.api_name = "P_BOX";
    }
    return { status: 200, body };
  });
  const report = await checkZohoReadiness(fake.port);
  assert.equal(fake.calls.length, 5);
  assert.equal(report.sourceCandidates.length, 2);
  for (const candidate of report.sourceCandidates) {
    assert.equal(candidate.module, "Deals");
    assert.equal(candidate.selectionApplied, false);
    assert.equal(candidate.candidate.observed, true);
    assert.deepEqual(candidate.candidate.checks, ["FIELD_PRESENT"]);
  }
  assert.deepEqual(fieldReport(report, "Deals", "Department").checks, ["REQUIRED_FIELD_MISSING"]);
  assert.deepEqual(fieldReport(report, "Deals", "P_Box").checks, ["FIELD_API_NAME_CASE_MISMATCH"]);
  assert.equal(report.summary.requiredFields, 51);
  assert.equal(report.runtimeIntegrationVerified, false);
  assert.ok(report.limitations.includes("SOURCE_CANDIDATES_NOT_SELECTED"));
});

test("source candidates retain exact type, create permission and picklist evidence rather than guessing aliases", async () => {
  const fake = fixture((module, body) => {
    if (module === "Deals") {
      body.fields.push({ api_name: "Assign_Department1", data_type: "picklist", read_only: false, field_read_only: false,
        operation_type: { api_create: false }, pick_list_values: [
          { actual_value: "VOLTRONIX CONTRACTING LLC" },
          { actual_value: "PrivateTenantValue", display_value: "VOLTRONIX SWITCHGEAR LLC" },
        ] });
      body.fields.push({ api_name: "P_BOX", data_type: "integer", read_only: false, field_read_only: false,
        operation_type: { api_create: true } });
    }
    return { status: 200, body };
  });
  const report = await checkZohoReadiness(fake.port);
  const department = report.sourceCandidates[0]!.candidate, poBox = report.sourceCandidates[1]!.candidate;
  assert.ok(department.checks.includes("CREATE_NOT_SUPPORTED"));
  assert.ok(department.checks.includes("EXPECTED_PICKLIST_VALUES_MISSING"));
  assert.deepEqual(department.missingExpectedPicklistValues, ["VOLTRONIX SWITCHGEAR LLC"]);
  assert.ok(poBox.checks.includes("FIELD_TYPE_REVIEW"));
  assert.ok(!JSON.stringify(report).includes("PrivateTenantValue"));
});

test("missing, duplicate, wrong-case or unavailable candidates never become selected or observed matches", async () => {
  for (const variant of ["missing", "duplicate", "case", "unavailable"] as const) {
    const fake = fixture((module, body) => {
      if (module === "Deals") {
        if (variant === "unavailable") return { status: 403, body: { error: "PrivateTenantError" } };
        if (variant === "duplicate") body.fields.push({ api_name: "P_BOX" }, { api_name: "P_BOX" });
        if (variant === "case") body.fields.push({ api_name: "assign_department1" });
      }
      return { status: 200, body };
    });
    const report = await checkZohoReadiness(fake.port);
    for (const candidate of report.sourceCandidates) {
      assert.equal(candidate.selectionApplied, false);
      assert.equal(candidate.candidate.observed, variant === "unavailable" ? null : false);
    }
    if (variant === "duplicate") assert.deepEqual(report.sourceCandidates[1]!.candidate.checks, ["AMBIGUOUS_FIELD"]);
    if (variant === "case") assert.deepEqual(report.sourceCandidates[0]!.candidate.checks, ["FIELD_API_NAME_CASE_MISMATCH"]);
    assert.ok(!JSON.stringify(report).includes("PrivateTenantError"));
  }
});

test("missing picklist report contains only expected source options and separates Stage from app status", async () => {
  const fake = fixture((module, body) => {
    if (module === "Deals") {
      body.fields.find(value => value.api_name === "Stage")!.pick_list_values = [{ actual_value: "Qualification" }];
      body.fields.find(value => value.api_name === "VZ_App_Status")!.pick_list_values = [{ actual_value: "Pending" }];
    }
    return { status: 200, body };
  });
  const report = await checkZohoReadiness(fake.port);
  for (const field of ["Stage", "VZ_App_Status"]) {
    assert.deepEqual(fieldReport(report, "Deals", field).missingExpectedPicklistValues,
      ["Site Visit", "Proposal/Price Quote", "Closed Won", "Closed Lost"]);
  }
});
