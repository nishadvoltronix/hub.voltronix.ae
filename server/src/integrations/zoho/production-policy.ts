import { z } from "zod";
import type { VerifiedZohoRequestPort } from "./transports.js";

const identifier = z.string().regex(/^[1-9][0-9]{0,29}$/);
const secret = z.string().regex(/^[A-Za-z0-9._~-]{1,4096}$/);
const configuration = z.object({
  credentials: z.object({ clientId: secret, clientSecret: secret, refreshToken: secret }).strict(),
  organizationId: identifier, accountOwnerId: identifier,
  profile: z.literal("voltronix-native-outbound-v1"),
  dealPipeline: z.string().min(1).max(100).refine(value => value.trim() === value
    && Array.from(value).every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)),
  automationPolicy: z.literal("suppressed"),
}).strict();
export type ProductionZohoConfiguration = z.infer<typeof configuration>;
type FailureCode = "CONFIGURATION" | "ORGANIZATION" | "ACCOUNT_OWNER" | "FIELD_METADATA" | "TAX_POLICY" | "PIPELINE_LAYOUT" | "AUTHORITY";
export class ProductionZohoProfileError extends Error {
  constructor(readonly code: FailureCode = "CONFIGURATION", readonly module?: string, readonly field?: string) {
    super(`The selected production Zoho profile could not be verified (${code}); no write authority was granted.`);
  }
}
export function validateProductionZohoConfiguration(input: unknown): ProductionZohoConfiguration {
  try {
    const parsed = configuration.parse(input);
    return Object.freeze({ ...parsed, credentials: Object.freeze(parsed.credentials) });
  } catch { throw new ProductionZohoProfileError(); }
}
export interface ProductionZohoAuthority {
  readonly organizationId: string;
  readonly profile: "voltronix-native-outbound-v1";
  readonly automationPolicy: "suppressed";
}
const authorities = new WeakMap<object, string>();
export function assertProductionZohoAuthority(value: unknown, organizationId: string): asserts value is ProductionZohoAuthority {
  if (!value || typeof value !== "object" || !authorities.has(value)
    || (value as ProductionZohoAuthority).organizationId !== organizationId) throw new ProductionZohoProfileError("AUTHORITY");
}
export function revokeProductionZohoAuthority(value: ProductionZohoAuthority): void { authorities.delete(value); }
export function productionZohoLayoutId(value: ProductionZohoAuthority, organizationId: string): string {
  assertProductionZohoAuthority(value, organizationId);
  return authorities.get(value)!;
}

/** Internal picklist values differ from the values accepted by Records API.
 * The fixed profile pins all three labels, plus option identity across layout
 * and pipeline; a matching module-wide label alone is insufficient. */
export const productionZohoStageOptions = Object.freeze([
  { actual: "Qualification", wire: "Qualification" }, { actual: "Needs Analysis", wire: "Site Visit" },
  { actual: "Proposal/Price Quote", wire: "Proposal/Price Quote" }, { actual: "Closed Won", wire: "Closed Won" },
  { actual: "Closed Lost", wire: "Closed Lost" },
].map(value => Object.freeze(value)));
/** These are the selected layout's required inputs, each explicitly supplied by
 * the production Deal workflow. Write permission alone does not establish that
 * an optional application input will have a nonempty value. */
export const productionZohoRequiredDealFields = Object.freeze([
  "Deal_Name", "Account_Name", "Closing_Date", "Pipeline", "Stage", "Assign_Department1",
] as const);

/** A verified, bounded read-only port is required. No authority exists until
 * every fixed profile check has completed. */
type Module = "Accounts" | "Contacts" | "Deals" | "Products" | "Quotes" | "Quoted_Items";
interface FieldRequirement {
  types: readonly string[];
  operations?: readonly ("create" | "update")[];
  lookup?: string;
  subform?: string;
  length?: number;
  decimals?: number;
  values?: readonly string[];
  implicitParent?: boolean;
}
const create = ["create"] as const, write = ["create", "update"] as const;
const field = (types: readonly string[], operations?: FieldRequirement["operations"], extra: Omit<FieldRequirement, "types" | "operations"> = {}): FieldRequirement =>
  Object.freeze({ types: Object.freeze([...types]), ...(operations ? { operations } : {}), ...extra });
const text = (operations?: FieldRequirement["operations"], length?: number) => field(["text"], operations, length === undefined ? {} : { length });
const lookup = (module: string, operations: FieldRequirement["operations"]) => field(["lookup"], operations, { lookup: module });
const currency = (operations?: FieldRequirement["operations"]) => field(["currency"], operations, { length: 16, decimals: 9 });

/** Source-backed fixed contract, not tenant-selected aliases. API write flags
 * are operation-specific: Zoho's documented Owner example has field_read_only
 * true with api_create/api_update true. Current-user read_only still denies.
 * https://www.zoho.com/crm/developer/docs/api/v8/field-meta.html */
export const productionZohoFieldRequirements: Readonly<Record<Module, Readonly<Record<string, FieldRequirement>>>> = Object.freeze({
  Accounts: Object.freeze({ Account_Name: text(create, 200), Phone: field(["phone"], create, { length: 30 }), Owner: field(["ownerlookup"], create) }),
  Contacts: Object.freeze({ First_Name: text(create, 40), Last_Name: text(create, 80), Email: field(["email"], create, { length: 100 }),
    Mobile: field(["phone"], create, { length: 30 }), Phone: field(["phone"], create, { length: 50 }), Mailing_Street: field(["textarea", "text"], create, { length: 250 }),
    Account_Name: lookup("Accounts", create) }),
  Deals: Object.freeze({ Deal_Name: text(create, 120), Stage: field(["picklist"], write, {
    values: ["Qualification", "Needs Analysis", "Proposal/Price Quote", "Closed Won", "Closed Lost"] }),
  VZ_App_Status: field(["picklist"], write, { values: ["Pending", "Site Visit", "Proposal", "Close to Won", "Close to Lost"] }),
  Pipeline: field(["picklist"], create), Closing_Date: field(["date"], create), Description: field(["textarea"], create), Email: field(["email"], create, { length: 100 }),
  Mobile: field(["phone"], create, { length: 30 }), Phone: field(["phone"], create, { length: 30 }), Account_Name: lookup("Accounts", create),
  Contact_Name: lookup("Contacts", create), VZ_app_user: lookup("VZ_app_users", create),
  Assign_Department1: field(["picklist"], create, { values: ["VOLTRONIX CONTRACTING LLC", "VOLTRONIX SWITCHGEAR LLC"] }),
  Address: field(["textarea", "text"], create, { length: 2000 }), P_BOX: text(create), TRN: text(create), Amount: field(["currency"], ["update"]),
  DealNumber: field(["autonumber", "text"]), QualDealNumber: text(["update"], 100), QuoteDealNumber: text(["update"], 100),
  // Hub stage references are local-only: remote legacy counters scan these fields.
  SiteDealNumber: text(undefined, 100), JobDealNumber: text(undefined, 100), LostDealNumber: text(undefined, 100) }),
  Products: Object.freeze({ Product_Name: text(create, 255), Description: field(["textarea"], create, { length: 32000 }) }),
  Quotes: Object.freeze({ Subject: text(write, 120), Deal_Name: lookup("Deals", write), Contact_Name: lookup("Contacts", write),
    ...Object.fromEntries(["Project", "Terms_of_Payment", "Brand", "Warranty", "Delivery"]
      .map(name => [name, text(write, 255)])),
    Specification: field(["textarea"], write, { length: 2000 }), General_Exclusion: field(["textarea"], write, { length: 10000 }),
    Valid_Till: field(["date"], write), Discount: currency(write), Tax: currency(), Adjustment: currency(write),
    Sub_Total: field(["currency", "formula"], undefined, { length: 16, decimals: 9 }),
    Grand_Total: field(["currency", "formula"], undefined, { length: 16, decimals: 9 }),
    Quoted_Items: field(["subform"], write, { subform: "Quoted_Items" }), Quote_No: field(["autonumber"]), Modified_Time: field(["datetime"]) }),
  Quoted_Items: Object.freeze({ Product_Name: lookup("Products", write), Quantity: field(["double"], write, { length: 16, decimals: 9 }),
    List_Price: currency(write), ItemDiscount: field(["percent"], write, { length: 5, decimals: 2 }),
    U_O_M: field(["picklist"], write, { values: ["NOS", "PCS", "LS", "EA", "SET", "SQM"] }),
    Description: field(["textarea"], write, { length: 2000 }), Net_Total: field(["formula"], undefined, { length: 16, decimals: 9 }),
    // Zoho supplies this mandatory relationship from the enclosing Quotes payload.
    Parent_Id: field(["lookup"], undefined, { lookup: "Quotes", implicitParent: true }) }),
});
const integer = z.union([z.number().int().nonnegative(), z.string().regex(/^(?:0|[1-9][0-9]{0,8})$/)]).transform(Number);
const metadataField = z.object({ api_name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), data_type: z.string(),
  system_mandatory: z.boolean(), required: z.boolean().optional(), read_only: z.boolean().optional(), field_read_only: z.boolean().optional(),
  operation_type: z.object({ api_create: z.boolean().optional(), api_update: z.boolean().optional() }).optional(),
  length: integer.nullable().optional(), decimal_place: integer.nullable().optional(),
  lookup: z.object({ module: z.object({ api_name: z.string() }).optional() }).nullable().optional(),
  associated_module: z.object({ module: z.string() }).nullable().optional(),
  pick_list_values: z.array(z.object({ actual_value: z.string(), type: z.string().optional(), id: z.unknown().optional(),
    display_value: z.string().optional(), reference_value: z.string().optional() })).max(2048).optional(),
});
const fieldResponse = z.object({ fields: z.array(metadataField).min(1).max(2048), error: z.never().optional(), code: z.never().optional() });
type MetadataField = z.infer<typeof metadataField>;
function inspectField(module: Module, name: string, expected: FieldRequirement, observed: MetadataField, pipeline: string): void {
  const values = module === "Deals" && name === "Pipeline" ? [pipeline] : expected.values;
  if (!expected.types.includes(observed.data_type)
    || expected.operations?.some(operation => observed.read_only === true || observed.operation_type?.[`api_${operation}`] !== true)
    || (expected.lookup !== undefined && observed.lookup?.module?.api_name !== expected.lookup)
    || (expected.subform !== undefined && observed.associated_module?.module !== expected.subform)
    || (expected.length !== undefined && (observed.length === undefined || observed.length === null || observed.length < expected.length))
    || (expected.decimals !== undefined && (observed.decimal_place === undefined || observed.decimal_place === null || observed.decimal_place < expected.decimals))
    || values?.some(value => observed.pick_list_values?.filter(option => option.actual_value === value && option.type === "used").length !== 1)) {
    throw new ProductionZohoProfileError("FIELD_METADATA", module, name);
  }
  if (module === "Deals" && ["VZ_App_Status", "Pipeline", "Assign_Department1"].includes(name)) {
    for (const value of values ?? []) {
      const option = observed.pick_list_values!.find(option => option.actual_value === value && option.type === "used")!;
      if (option.reference_value !== value || option.display_value !== value) throw new ProductionZohoProfileError("FIELD_METADATA", module, name);
    }
  }
}
function inspectModule(module: Module, body: unknown, pipeline: string): Map<string, MetadataField> {
  const parsed = fieldResponse.safeParse(body);
  if (!parsed.success) throw new ProductionZohoProfileError("FIELD_METADATA", module);
  const observed = new Map<string, MetadataField>(), casing = new Set<string>();
  for (const candidate of parsed.data.fields) {
    const key = candidate.api_name.toLowerCase();
    if (casing.has(key)) throw new ProductionZohoProfileError("FIELD_METADATA", module);
    casing.add(key); observed.set(candidate.api_name, candidate);
  }
  const requirements = productionZohoFieldRequirements[module];
  for (const [name, expected] of Object.entries(requirements)) {
    const candidate = observed.get(name);
    if (!candidate) throw new ProductionZohoProfileError("FIELD_METADATA", module, name);
    inspectField(module, name, expected, candidate, pipeline);
  }
  for (const candidate of observed.values()) {
    if ((candidate.system_mandatory || candidate.required) && candidate.operation_type?.api_create === true
      && !requirements[candidate.api_name]?.operations?.includes("create")
      && !requirements[candidate.api_name]?.implicitParent
      && !["autonumber", "formula"].includes(candidate.data_type)) throw new ProductionZohoProfileError("FIELD_METADATA", module);
  }
  return observed;
}
const stageOption = z.object({ id: identifier, actual_value: z.string(), reference_value: z.string(), display_value: z.string(), type: z.literal("used") });
function selectedStages(field: MetadataField): z.infer<typeof stageOption>[] {
  const selected = productionZohoStageOptions.map(expected => {
    const candidates = field.pick_list_values?.filter(option => option.actual_value === expected.actual) ?? [];
    if (candidates.length !== 1) throw new ProductionZohoProfileError("PIPELINE_LAYOUT");
    const parsed = stageOption.safeParse(candidates[0]);
    if (!parsed.success || parsed.data.reference_value !== expected.wire || parsed.data.display_value !== expected.wire) {
      throw new ProductionZohoProfileError("PIPELINE_LAYOUT");
    }
    return parsed.data;
  });
  if (new Set(selected.map(option => option.id)).size !== selected.length) throw new ProductionZohoProfileError("PIPELINE_LAYOUT");
  return selected;
}
const layoutResponse = z.object({ layouts: z.array(z.object({ id: identifier, api_name: z.string(), name: z.string(), display_label: z.string(),
  status: z.string(), visible: z.boolean(), sections: z.array(z.object({ fields: z.array(metadataField.extend({ required: z.boolean() })).max(2048) })).max(64) })).min(1).max(128),
error: z.never().optional(), code: z.never().optional() });
const pipelineResponse = z.object({ pipeline: z.array(z.object({ id: identifier, actual_value: z.string(), display_value: z.string(), default: z.boolean(),
  maps: z.array(z.object({ id: identifier, actual_value: z.string(), display_value: z.string() })).min(1).max(2048) })).min(1).max(128),
error: z.never().optional(), code: z.never().optional() });
async function verifyPipelineLayout(get: (path: string) => Promise<unknown>, moduleFields: Map<string, MetadataField>, pipeline: string): Promise<string> {
  const layouts = layoutResponse.safeParse(await get("/settings/layouts?module=Deals"));
  if (!layouts.success) throw new ProductionZohoProfileError("PIPELINE_LAYOUT");
  const selected = layouts.data.layouts.filter(layout => layout.status === "active" && layout.visible);
  if (selected.length !== 1 || selected[0]!.api_name !== "Standard__s" || selected[0]!.name !== "Standard"
    || selected[0]!.display_label !== "Standard") throw new ProductionZohoProfileError("PIPELINE_LAYOUT");
  const layout = selected[0]!, fields = inspectModule("Deals", { fields: layout.sections.flatMap(section => section.fields) }, pipeline);
  const supportedRequired = new Set<string>(productionZohoRequiredDealFields);
  for (const candidate of fields.values()) {
    if (candidate.required !== supportedRequired.has(candidate.api_name)
      || (candidate.system_mandatory && !supportedRequired.has(candidate.api_name))) throw new ProductionZohoProfileError("PIPELINE_LAYOUT");
  }
  const globalStages = selectedStages(moduleFields.get("Stage")!), layoutStages = selectedStages(fields.get("Stage")!);
  if (globalStages.some((option, index) => option.id !== layoutStages[index]!.id)) throw new ProductionZohoProfileError("PIPELINE_LAYOUT");
  const pipelines = pipelineResponse.safeParse(await get(`/settings/pipeline?layout_id=${layout.id}`));
  if (!pipelines.success) throw new ProductionZohoProfileError("PIPELINE_LAYOUT");
  const matching = pipelines.data.pipeline.filter(value => value.actual_value === pipeline || value.display_value === pipeline);
  if (matching.length !== 1 || matching[0]!.actual_value !== pipeline || matching[0]!.display_value !== pipeline
    || !matching[0]!.default || pipelines.data.pipeline.filter(value => value.default).length !== 1) throw new ProductionZohoProfileError("PIPELINE_LAYOUT");
  const maps = matching[0]!.maps;
  if (new Set(maps.map(option => option.id)).size !== maps.length || new Set(maps.map(option => option.actual_value)).size !== maps.length
    || new Set(maps.map(option => option.display_value)).size !== maps.length) throw new ProductionZohoProfileError("PIPELINE_LAYOUT");
  for (const option of layoutStages) {
    const mapped = maps.find(value => value.id === option.id);
    if (!mapped || mapped.actual_value !== option.actual_value || mapped.display_value !== option.display_value) throw new ProductionZohoProfileError("PIPELINE_LAYOUT");
  }
  return layout.id;
}
export function assertProductionOrganization(body: unknown, organizationId: string): void {
  const parsed = z.object({ org: z.tuple([z.object({ id: identifier, type: z.literal("production") })]),
    error: z.never().optional(), code: z.never().optional() }).safeParse(body);
  if (!parsed.success || parsed.data.org[0].id !== organizationId) throw new ProductionZohoProfileError("ORGANIZATION");
}
function inspectOwner(body: unknown, ownerId: string): void {
  const parsed = z.object({ users: z.tuple([z.object({ id: identifier, status: z.literal("active") })]),
    error: z.never().optional(), code: z.never().optional() }).safeParse(body);
  if (!parsed.success || parsed.data.users[0].id !== ownerId) throw new ProductionZohoProfileError("ACCOUNT_OWNER");
}
function inspectTax(body: unknown): void {
  const parsed = z.object({ org_taxes: z.object({ taxes: z.array(z.object({ name: z.string(), value: z.union([z.string(), z.number()]) })).min(1).max(128),
    preference: z.object({ auto_populate_tax: z.literal(true), modify_tax_rates: z.literal(false) }) }),
  error: z.never().optional(), code: z.never().optional() }).safeParse(body);
  if (!parsed.success) throw new ProductionZohoProfileError("TAX_POLICY");
  const taxes = parsed.data.org_taxes.taxes.filter(tax => tax.name.toLowerCase() === "vat");
  if (taxes.length !== 1 || taxes[0]!.name !== "Vat" || !/^5(?:\.0+)?$/.test(String(taxes[0]!.value))) throw new ProductionZohoProfileError("TAX_POLICY");
}

export async function verifyProductionZohoProfile(port: VerifiedZohoRequestPort,
  input: ProductionZohoConfiguration): Promise<ProductionZohoAuthority> {
  const config = validateProductionZohoConfiguration(input);
  const get = async (path: string) => {
    const response = await port.request({ apiVersion: "v8", method: "GET", path });
    if (response.status !== 200) throw new ProductionZohoProfileError();
    return response.body;
  };
  try {
    assertProductionOrganization(await get("/org"), config.organizationId);
    inspectOwner(await get("/users?type=CurrentUser"), config.accountOwnerId);
    inspectTax(await get("/org/taxes"));
    let dealFields: Map<string, MetadataField> | undefined;
    for (const module of Object.keys(productionZohoFieldRequirements) as Module[]) {
      const fields = inspectModule(module, await get(`/settings/fields?module=${module}`), config.dealPipeline);
      if (module === "Deals") dealFields = fields;
    }
    const layoutId = await verifyPipelineLayout(get, dealFields!, config.dealPipeline);
    const authority = Object.freeze({ organizationId: config.organizationId, profile: config.profile, automationPolicy: config.automationPolicy });
    authorities.set(authority, layoutId);
    return authority;
  } catch (error) {
    if (error instanceof ProductionZohoProfileError) throw error;
    throw new ProductionZohoProfileError();
  }
}
