import { productionZohoFieldRequirements, productionZohoStageOptions, productionZohoRequiredDealFields, type ProductionZohoConfiguration } from "../../src/integrations/zoho/production-policy.js";

export type SyntheticMetadataBody = Record<string, unknown>;
/** Synthetic metadata only: no network, credentials file, records or authority.
 * Consumers must run the real profile validator/opener against this fake provider. */
export function syntheticProductionZohoConfiguration(organizationId = "123", accountOwnerId = "456"): ProductionZohoConfiguration {
  return { credentials: { clientId: "synthetic-client", clientSecret: "synthetic-secret", refreshToken: "synthetic-refresh" },
    organizationId, accountOwnerId, profile: "voltronix-native-outbound-v1", dealPipeline: "Synthetic pipeline", automationPolicy: "suppressed" };
}
export function syntheticProductionZohoMetadata(config = syntheticProductionZohoConfiguration()): Map<string, SyntheticMetadataBody> {
  const bodies = new Map<string, SyntheticMetadataBody>([["/org", { org: [{ id: config.organizationId, type: "production" }] }],
    ["/users?type=CurrentUser", { users: [{ id: config.accountOwnerId, status: "active" }] }],
    ["/org/taxes", { org_taxes: { taxes: [{ name: "Sales Tax", value: "0" }, { name: "Vat", value: "5" }],
      preference: { auto_populate_tax: true, modify_tax_rates: false } } }]]);
  for (const [module, requirements] of Object.entries(productionZohoFieldRequirements)) bodies.set(`/settings/fields?module=${module}`, {
    fields: Object.entries(requirements).map(([name, expected]) => ({ api_name: name, data_type: expected.types[0], system_mandatory: name === "Parent_Id",
      read_only: name === "Parent_Id", field_read_only: name === "Owner",
      operation_type: { api_create: name === "Parent_Id" || !!expected.operations?.includes("create"), api_update: !!expected.operations?.includes("update") },
      ...(expected.length === undefined ? {} : { length: String(expected.length) }),
      ...(expected.decimals === undefined ? {} : { decimal_place: String(expected.decimals) }),
      ...(expected.lookup ? { lookup: { module: { api_name: expected.lookup } } } : {}),
      ...(expected.subform ? { associated_module: { module: expected.subform } } : {}),
      ...((name === "Pipeline" || expected.values) ? { pick_list_values: (name === "Pipeline" ? [config.dealPipeline] : expected.values!)
        .map((value, index) => { const wire = name === "Stage" ? productionZohoStageOptions.find(option => option.actual === value)!.wire : value;
          return { id: String(7001 + index), actual_value: value, reference_value: wire, display_value: wire, type: "used" }; }) } : {}),
    })),
  });
  const fields = bodies.get("/settings/fields?module=Deals")!.fields as SyntheticMetadataBody[];
  const required = new Set<string>(productionZohoRequiredDealFields);
  const layoutFields = structuredClone(fields).map(field => ({ ...field, required: required.has(String(field.api_name)) }));
  bodies.set("/settings/layouts?module=Deals", { layouts: [{ id: "6001", api_name: "Standard__s", name: "Standard", display_label: "Standard",
    status: "active", visible: true, sections: [{ fields: layoutFields }] }] });
  const stages = fields.find(field => field.api_name === "Stage")!.pick_list_values as SyntheticMetadataBody[];
  bodies.set("/settings/pipeline?layout_id=6001", { pipeline: [{ id: "8001", actual_value: config.dealPipeline, display_value: config.dealPipeline,
    default: true, maps: stages.map(option => ({ id: option.id, actual_value: option.actual_value, display_value: option.display_value })) }] });
  return bodies;
}
