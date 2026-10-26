import { z } from "zod";
import { ZohoClientError } from "./client.js";
import { ACCOUNT_PAYLOAD_PROFILES, DEAL_PAYLOAD_PROFILES, dealPipelineSchema, type AccountPayloadProfile, type DealPayloadProfile } from "../../crm/commercial/deals.js";
import { buildStageFields, STAGE_PAYLOAD_PROFILES, type StagePayloadProfile } from "../../crm/lead-mutations/stage-profile.js";
import { LEAD_TRANSITIONS } from "../../crm/lead-mutations/contracts.js";

/** Caller owns authentication, organization binding, response limits and I/O
 * deadlines. This checker never creates a client or requests business records. */
export interface ZohoReadinessPort {
  request(input: { apiVersion: "v8"; method: "GET"; path: string }): Promise<{ status: number; body: unknown }>;
}

export type ZohoReadinessModule = "Accounts" | "Contacts" | "Deals" | "Products" | "Quotes" | "Notes";
type FieldOperation = "read" | "create" | "update";
export interface ZohoFieldRequirement {
  readonly field: string;
  /** Source usage, NOT the tenant's system/layout mandatory setting. */
  readonly requirement: "required" | "optional";
  readonly operations: readonly FieldOperation[];
  readonly picklistValues?: readonly string[];
  readonly picklistValueSource?: "display_value";
  readonly requirePicklist?: true;
  readonly nested?: true;
  readonly dataTypes?: readonly string[];
}
interface ModuleRequirement {
  readonly module: ZohoReadinessModule;
  readonly metadataSupported: boolean;
  readonly fields: readonly ZohoFieldRequirement[];
}

const field = (name: string, operations: readonly FieldOperation[], requirement: "required" | "optional" = "required",
  extra: Pick<ZohoFieldRequirement, "picklistValues" | "picklistValueSource" | "requirePicklist" | "nested" | "dataTypes"> = {}): ZohoFieldRequirement =>
  Object.freeze({ field: name, requirement, operations: Object.freeze([...operations]), ...extra,
    ...(extra.dataTypes ? { dataTypes: Object.freeze([...extra.dataTypes]) } : {}),
    ...(extra.picklistValues ? { picklistValues: Object.freeze([...extra.picklistValues]) } : {}) });

/** Exact payload/readback keys from commercial/deals, products, quotations,
 * quote-contract and lead-mutations/service. Nullable quote terms are still
 * emitted keys and therefore require a mapping. Conditional deal address/tax
 * fields and tolerated absent readback fields are marked optional instead.
 * No record id or lookup's nested id/name is invented as a module field. */
export const zohoFieldRequirements: readonly ModuleRequirement[] = Object.freeze(([
  { module: "Accounts", metadataSupported: true, fields: [
    field("Account_Name", ["read", "create"]), field("Phone", ["create"]),
    field("Email", ["create"]), field("Owner", ["create"]),
  ] },
  { module: "Contacts", metadataSupported: true, fields: [
    field("First_Name", ["create"]), field("Last_Name", ["read", "create"]),
    field("Email", ["create"]), field("Mobile", ["create"]), field("Phone", ["create"]),
    field("Mailing_Street", ["create"]), field("Account_Name", ["create"]),
  ] },
  { module: "Deals", metadataSupported: true, fields: [
    field("Deal_Name", ["read", "create"]),
    field("Stage", ["read", "create", "update"], "required", { requirePicklist: true,
      picklistValues: ["Qualification", "Site Visit", "Proposal/Price Quote", "Closed Won", "Closed Lost"] }),
    field("VZ_App_Status", ["create", "update"], "required", {
      picklistValues: ["Pending", "Site Visit", "Proposal/Price Quote", "Closed Won", "Closed Lost"] }),
    field("Description", ["read", "create"]), field("Email", ["read", "create"]),
    field("Mobile", ["create"]), field("Phone", ["read", "create"]),
    field("Account_Name", ["read", "create"]), field("Contact_Name", ["read", "create"]),
    field("VZ_app_user", ["create"]), field("Department", ["create"], "required", {
      picklistValues: ["VOLTRONIX CONTRACTING LLC", "VOLTRONIX SWITCHGEAR LLC"] }),
    field("Address", ["read", "create"], "optional"), field("P_Box", ["create"], "optional"),
    field("TRN", ["create"], "optional"), field("Amount", ["update"], "optional"),
    field("DealNumber", ["read"]), field("SiteDealNumber", ["read"]),
    field("QuoteDealNumber", ["read", "update"]), field("JobDealNumber", ["read"]),
    field("QualDealNumber", ["read"], "optional"), field("EnquiryNumber", ["read"], "optional"),
    field("LostDealNumber", ["read"], "optional"), field("Owner", ["read"], "optional"),
    ...["Qual_Deal_Date", "Site_Deal_Date", "Quote_Deal_Date", "Job_Date", "Lost_Deal_Date"]
      .map(name => field(name, ["read"], "optional")),
  ] },
  { module: "Products", metadataSupported: true, fields: [
    field("Product_Name", ["read", "create"]), field("Description", ["read", "create"]),
    field("Unit_Price", ["read"], "optional"),
  ] },
  { module: "Quotes", metadataSupported: true, fields: [
    ...["Deal_Name", "Subject", "Project", "Terms_of_Payment", "Specification", "General_Exclusion",
      "Brand", "Warranty", "Delivery", "Valid_Till", "Contact_Name", "Amount", "Quoted_Items"]
      .map(name => field(name, ["create", "update"])),
    field("Quote_No", ["read"]), field("Modified_Time", ["read"]),
    // The parent-module response cannot certify subform child metadata. Do not
    // silently replace these custom keys with Zoho standard inventory aliases.
    ...["Product_Name", "Quantity", "List_Price", "ItemDiscount", "U_O_M", "Description"]
      .map(name => field(`Quoted_Items.${name}`, ["create", "update"], "required", { nested: true })),
  ] },
  // Notes is not listed as supported by the documented v8 Fields endpoint.
  // Keep its known payload contract, but make no unsupported API request.
  { module: "Notes", metadataSupported: false, fields: [
    field("Note_Title", ["create", "update"]), field("Note_Content", ["create", "update"]),
  ] },
] satisfies ModuleRequirement[]).map(module => Object.freeze({ ...module, fields: Object.freeze(module.fields) })));

/** Retained PHP conversion/webhook paths use these exact names, while the
 * newer create path uses Department/P_Box. Candidates are NOT aliases selected
 * automatically and never replace missing fields in the active-contract count.
 * Retained source: Deals controller:100,108; Zoho_model:237,288;
 * ZohoWebhook controller:81,221. */
export const zohoSourceFieldCandidates = Object.freeze([
  Object.freeze({ module: "Deals" as const, replaces: "Department", expected: field("Assign_Department1", ["create"], "required", {
    dataTypes: ["picklist"], requirePicklist: true, picklistValues: ["VOLTRONIX CONTRACTING LLC", "VOLTRONIX SWITCHGEAR LLC"],
  }) }),
  Object.freeze({ module: "Deals" as const, replaces: "P_Box", expected: field("P_BOX", ["create"], "optional", { dataTypes: ["text"] }) }),
]);

export type ZohoReadinessCode =
  | "FIELD_METADATA_OBSERVED" | "FIELD_METADATA_NOT_SUPPORTED" | "FIELD_METADATA_NOT_CHECKED"
  | "METADATA_REQUEST_FAILED" | "METADATA_ACCESS_DENIED" | "METADATA_RATE_LIMITED"
  | "METADATA_EMPTY" | "METADATA_MALFORMED" | "FIELD_PRESENT" | "REQUIRED_FIELD_MISSING"
  | "OPTIONAL_FIELD_MISSING" | "AMBIGUOUS_FIELD" | "FIELD_API_NAME_CASE_MISMATCH"
  | "FIELD_READ_ONLY" | "CREATE_NOT_SUPPORTED" | "UPDATE_NOT_SUPPORTED" | "WRITE_METADATA_UNAVAILABLE"
  | "PICKLIST_TYPE_REVIEW" | "PICKLIST_VALUES_UNAVAILABLE" | "EXPECTED_PICKLIST_VALUES_MISSING"
  | "NESTED_FIELD_METADATA_NOT_CHECKED" | "UNKNOWN_MANDATORY_FIELDS_REVIEW" | "UNKNOWN_CUSTOM_MANDATORY_FIELDS_REVIEW"
  | "FIELD_TYPE_REVIEW";
export interface ZohoFieldCheck {
  field: string;
  requirement: "required" | "optional";
  observed: boolean | null;
  checks: ZohoReadinessCode[];
  /** Only predeclared source options, never arbitrary observed tenant values. */
  missingExpectedPicklistValues?: string[];
}
export interface ZohoSourceCandidateCheck {
  module: ZohoReadinessModule;
  replaces: string;
  candidate: ZohoFieldCheck;
  selectionApplied: boolean;
}
export interface ZohoReadinessProfiles { accountPayloadProfile?: AccountPayloadProfile; dealPayloadProfile: DealPayloadProfile; dealPipeline?: string; stagePayloadProfile: StagePayloadProfile }
export interface ZohoModuleReadiness {
  module: ZohoReadinessModule;
  status: "OBSERVED" | "REVIEW_REQUIRED" | "UNAVAILABLE" | "UNVERIFIED";
  checks: ZohoReadinessCode[];
  fields: ZohoFieldCheck[];
  unknownMandatoryFieldCount: number | null;
  unknownCustomMandatoryFieldCount: number | null;
}
export interface ZohoReadinessReport {
  status: "METADATA_REVIEW_ONLY";
  runtimeIntegrationVerified: false;
  dataCompatibilityVerified: false;
  schemaCompatibilityVerified: false;
  quotationMappingVerified: false;
  /** The explicitly requested payload contract, never inferred from metadata. */
  selectedProfiles?: Readonly<ZohoReadinessProfiles>;
  summary: { requestedModules: number; observedModules: number; requiredFields: number; observedRequiredFields: number; reviewChecks: number };
  modules: ZohoModuleReadiness[];
  sourceCandidates: ZohoSourceCandidateCheck[];
  limitations: readonly string[];
}

/** Documented metadata semantics, not permission or workflow certification:
 * https://www.zoho.com/crm/developer/docs/api/v8/field-meta.html
 * Module metadata spans layouts and does not establish layout-specific
 * mandatory/picklist rules. Hidden fields may still occur in the response.
 * Only system_mandatory is interpreted; arbitrary mandatory/required keys are
 * not repurposed as a layout contract. Actual picklist values, not UI labels,
 * are compared, but layout availability/automation remains unverified. */
export const zohoReadinessLimitations = Object.freeze([
  "LAYOUT_MANDATORY_RULES_NOT_VERIFIED", "FIELD_VISIBILITY_NOT_AUTHORIZATION", "PICKLIST_LAYOUT_RULES_NOT_VERIFIED",
  "VALUE_TYPES_AND_PRECISION_NOT_VERIFIED", "QUOTATION_FINANCIAL_MAPPING_NOT_VERIFIED",
  "QUOTATION_SUBFORM_MAPPING_NOT_VERIFIED", "API_VERSION_PARITY_NOT_VERIFIED", "LIVE_WRITES_NOT_TESTED",
  "LEGACY_SCHEMA_COMPATIBILITY_NOT_VERIFIED", "SYNC_AND_WEBHOOKS_NOT_VERIFIED", "NOTES_METADATA_NOT_SUPPORTED",
  "SOURCE_CANDIDATES_NOT_SELECTED",
]);

const profilesSchema = z.object({ dealPayloadProfile: z.enum(DEAL_PAYLOAD_PROFILES),
  stagePayloadProfile: z.enum(STAGE_PAYLOAD_PROFILES), accountPayloadProfile: z.enum(ACCOUNT_PAYLOAD_PROFILES).optional(), dealPipeline: dealPipelineSchema.optional() }).strict();
function profileRequirements(input?: ZohoReadinessProfiles) {
  if (input === undefined) return { requirements: zohoFieldRequirements };
  let selectedProfiles: Readonly<ZohoReadinessProfiles>;
  try {
    const parsed = profilesSchema.parse(input);
    selectedProfiles = Object.freeze({ dealPayloadProfile: parsed.dealPayloadProfile, stagePayloadProfile: parsed.stagePayloadProfile,
      ...(parsed.accountPayloadProfile === undefined ? {} : { accountPayloadProfile: parsed.accountPayloadProfile }),
      ...(parsed.dealPipeline === undefined ? {} : { dealPipeline: parsed.dealPipeline }) });
  }
  catch { throw new ZohoClientError("CONFIG_INVALID"); }
  const transitions = LEAD_TRANSITIONS.map(stage => buildStageFields(stage, selectedProfiles.stagePayloadProfile));
  const requirements = zohoFieldRequirements.map(module => {
    if (module.module === "Accounts" && selectedProfiles.accountPayloadProfile === "standard-account-contact-email-v1") {
      return { ...module, fields: module.fields.filter(expected => expected.field !== "Email") };
    }
    return module.module !== "Deals" ? module : {
    ...module, fields: [...module.fields.map(expected => {
      if (selectedProfiles.dealPayloadProfile === "legacy-conversion-fields-v1") {
        const candidate = zohoSourceFieldCandidates.find(candidate => candidate.replaces === expected.field);
        if (candidate) return candidate.expected;
      }
      if (expected.field === "Stage" || expected.field === "VZ_App_Status") {
        const key = expected.field;
        return { ...expected, picklistValues: [...new Set([key === "Stage" ? "Qualification" : "Pending", ...transitions.map(value => value[key])])],
          ...(selectedProfiles.stagePayloadProfile === "voltronix-stage-reference-values-v1" ? { picklistValueSource: "display_value" as const } : {}) };
      }
      return expected;
    }), ...(selectedProfiles.dealPipeline === undefined ? [] : [field("Pipeline", ["create"], "required", {
      dataTypes: ["picklist"], requirePicklist: true, picklistValues: [selectedProfiles.dealPipeline],
    })])],
    };
  });
  return { requirements, selectedProfiles };
}

const fieldMetadata = z.object({
  api_name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
  system_mandatory: z.boolean().optional(), custom_field: z.boolean().optional(),
  field_read_only: z.boolean().optional(), read_only: z.boolean().optional(),
  operation_type: z.object({ api_create: z.boolean().optional(), api_update: z.boolean().optional() }).optional(),
  data_type: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/).optional(),
  pick_list_values: z.array(z.object({ actual_value: z.string().max(512), display_value: z.string().max(512).optional() })).max(2048).optional(),
});
const responseMetadata = z.object({ fields: z.array(fieldMetadata).max(2048), error: z.never().optional(), code: z.never().optional() });
type FieldMetadata = z.infer<typeof fieldMetadata>;

function unchecked(module: ModuleRequirement, code: ZohoReadinessCode, unsupported = false): ZohoModuleReadiness {
  return { module: module.module, status: unsupported ? "UNVERIFIED" : "UNAVAILABLE", checks: [code],
    fields: module.fields.map(expected => ({ field: expected.field, requirement: expected.requirement, observed: null,
      checks: [expected.nested ? "NESTED_FIELD_METADATA_NOT_CHECKED" : "FIELD_METADATA_NOT_CHECKED"] })),
    unknownMandatoryFieldCount: null, unknownCustomMandatoryFieldCount: null };
}

function metadataFailure(status: number | undefined): ZohoReadinessCode {
  return status === 204 ? "METADATA_EMPTY" : status === 401 || status === 403 ? "METADATA_ACCESS_DENIED"
    : status === 429 ? "METADATA_RATE_LIMITED" : "METADATA_REQUEST_FAILED";
}

function checkField(expected: ZohoFieldRequirement, metadata: FieldMetadata[]): ZohoFieldCheck {
  const result: ZohoFieldCheck = { field: expected.field, requirement: expected.requirement, observed: null, checks: [] };
  if (expected.nested) { result.checks.push("NESTED_FIELD_METADATA_NOT_CHECKED"); return result; }
  const matches = metadata.filter(value => value.api_name === expected.field);
  if (matches.length !== 1) {
    result.observed = false;
    result.checks.push(matches.length > 1 ? "AMBIGUOUS_FIELD"
      : metadata.some(value => value.api_name.toLowerCase() === expected.field.toLowerCase()) ? "FIELD_API_NAME_CASE_MISMATCH"
        : expected.requirement === "required" ? "REQUIRED_FIELD_MISSING" : "OPTIONAL_FIELD_MISSING");
    return result;
  }
  result.observed = true;
  result.checks.push("FIELD_PRESENT");
  const observed = matches[0]!;
  if (expected.dataTypes && !expected.dataTypes.includes(observed.data_type ?? "")) result.checks.push("FIELD_TYPE_REVIEW");
  if (expected.operations.includes("create") || expected.operations.includes("update")) {
    if (observed.field_read_only === true || observed.read_only === true) result.checks.push("FIELD_READ_ONLY");
    if (observed.field_read_only === undefined || observed.read_only === undefined) result.checks.push("WRITE_METADATA_UNAVAILABLE");
    for (const operation of ["create", "update"] as const) {
      if (!expected.operations.includes(operation)) continue;
      const supported = observed.operation_type?.[operation === "create" ? "api_create" : "api_update"];
      if (supported === false) result.checks.push(operation === "create" ? "CREATE_NOT_SUPPORTED" : "UPDATE_NOT_SUPPORTED");
      else if (supported === undefined && !result.checks.includes("WRITE_METADATA_UNAVAILABLE")) result.checks.push("WRITE_METADATA_UNAVAILABLE");
    }
  }
  if (expected.picklistValues) {
    if (observed.data_type !== "picklist") {
      if (expected.requirePicklist || observed.data_type === undefined) result.checks.push("PICKLIST_TYPE_REVIEW");
    } else if (!observed.pick_list_values?.length) result.checks.push("PICKLIST_VALUES_UNAVAILABLE");
    else if (expected.picklistValues.some(value => !observed.pick_list_values!.some(pick => pick[expected.picklistValueSource ?? "actual_value"] === value))) {
      result.checks.push("EXPECTED_PICKLIST_VALUES_MISSING");
      result.missingExpectedPicklistValues = expected.picklistValues.filter(value => !observed.pick_list_values!.some(pick => pick[expected.picklistValueSource ?? "actual_value"] === value));
    }
  }
  return result;
}

function observedModule(module: ModuleRequirement, metadata: FieldMetadata[]): ZohoModuleReadiness {
  const fields = module.fields.map(expected => checkField(expected, metadata));
  const unknownMandatory = metadata.filter(value => value.system_mandatory === true
    && !module.fields.some(expected => !expected.nested && expected.field === value.api_name));
  const unknownCustomMandatoryFieldCount = unknownMandatory.filter(value => value.custom_field === true).length;
  const checks: ZohoReadinessCode[] = ["FIELD_METADATA_OBSERVED"];
  if (unknownMandatory.length) checks.push("UNKNOWN_MANDATORY_FIELDS_REVIEW");
  if (unknownCustomMandatoryFieldCount) checks.push("UNKNOWN_CUSTOM_MANDATORY_FIELDS_REVIEW");
  return { module: module.module,
    status: checks.length > 1 || fields.some(value => value.checks.some(code => code !== "FIELD_PRESENT")) ? "REVIEW_REQUIRED" : "OBSERVED",
    checks, fields, unknownMandatoryFieldCount: unknownMandatory.length, unknownCustomMandatoryFieldCount };
}

/** Five fixed GETs, one per documented module; no retries, record reads/writes,
 * environment access or fallback endpoint. Raw errors/tenant metadata never
 * enter the report. The injected client must enforce network deadlines. */
export async function checkZohoReadiness(port: ZohoReadinessPort, profiles?: ZohoReadinessProfiles): Promise<ZohoReadinessReport> {
  const { requirements, selectedProfiles } = profileRequirements(profiles);
  const modules: ZohoModuleReadiness[] = [];
  const sourceCandidates: ZohoSourceCandidateCheck[] = zohoSourceFieldCandidates.map(value => ({ module: value.module,
    replaces: value.replaces, selectionApplied: selectedProfiles?.dealPayloadProfile === "legacy-conversion-fields-v1",
    candidate: { field: value.expected.field, requirement: value.expected.requirement,
      observed: null, checks: ["FIELD_METADATA_NOT_CHECKED"] } }));
  for (const module of requirements) {
    if (!module.metadataSupported) { modules.push(unchecked(module, "FIELD_METADATA_NOT_SUPPORTED", true)); continue; }
    try {
      const response = await port.request({ apiVersion: "v8", method: "GET", path: `/settings/fields?module=${module.module}` });
      if (!Number.isInteger(response.status)) { modules.push(unchecked(module, "METADATA_MALFORMED")); continue; }
      if (response.status !== 200) {
        modules.push(unchecked(module, metadataFailure(response.status))); continue;
      }
      const parsed = responseMetadata.safeParse(response.body);
      if (!parsed.success) { modules.push(unchecked(module, "METADATA_MALFORMED")); continue; }
      if (!parsed.data.fields.length) { modules.push(unchecked(module, "METADATA_EMPTY")); continue; }
      modules.push(observedModule(module, parsed.data.fields));
      for (const [index, candidate] of zohoSourceFieldCandidates.entries()) {
        if (candidate.module === module.module) sourceCandidates[index]!.candidate = checkField(candidate.expected, parsed.data.fields);
      }
    } catch (error) {
      // The real client throws on non-2xx responses. Preserve only its safe
      // status classification; never inspect arbitrary exception/provider data.
      modules.push(unchecked(module, metadataFailure(error instanceof ZohoClientError ? error.httpStatus : undefined)));
    }
  }
  const fields = modules.flatMap(module => module.fields);
  return { status: "METADATA_REVIEW_ONLY", runtimeIntegrationVerified: false, dataCompatibilityVerified: false,
    schemaCompatibilityVerified: false, quotationMappingVerified: false,
    ...(selectedProfiles === undefined ? {} : { selectedProfiles }),
    summary: { requestedModules: requirements.filter(module => module.metadataSupported).length,
      observedModules: modules.filter(module => module.checks.includes("FIELD_METADATA_OBSERVED")).length,
      requiredFields: fields.filter(field => field.requirement === "required").length,
      observedRequiredFields: fields.filter(field => field.requirement === "required" && field.observed === true).length,
      reviewChecks: modules.reduce((count, module) => count + module.checks.filter(code => code !== "FIELD_METADATA_OBSERVED").length
        + module.fields.reduce((total, field) => total + field.checks.filter(code => code !== "FIELD_PRESENT").length, 0), 0) },
    modules, sourceCandidates, limitations: selectedProfiles?.dealPayloadProfile === "legacy-conversion-fields-v1"
      ? zohoReadinessLimitations.filter(value => value !== "SOURCE_CANDIDATES_NOT_SELECTED") : zohoReadinessLimitations };
}
