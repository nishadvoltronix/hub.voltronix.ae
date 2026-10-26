import { createZohoClient, ZohoClientError, type ZohoClientDependencies } from "./client.js";
import { createZohoTransports } from "./transports.js";
import { assertProductionOrganization, ProductionZohoProfileError, productionZohoLayoutId, revokeProductionZohoAuthority,
  validateProductionZohoConfiguration, verifyProductionZohoProfile, type ProductionZohoAuthority,
  type ProductionZohoConfiguration } from "./production-policy.js";
import type { CrmIntegration } from "../../crm/router.js";

export { validateProductionZohoConfiguration, type ProductionZohoConfiguration } from "./production-policy.js";

/** Opens the single named outbound profile. Metadata is verified through a
 * read-only client before a separate write client receives a branded authority.
 * Nothing imports records, infers configuration, or selects a local fallback. */
export async function openProductionZohoIntegration(input: ProductionZohoConfiguration, dependencies: ZohoClientDependencies = {}) {
  const config = validateProductionZohoConfiguration(input);
  const clientConfiguration = { ...config.credentials, environment: "production" as const, organizationId: config.organizationId };
  // A caller-supplied authority cannot bypass this opener's fresh preflight.
  const { productionAuthority: _ignoredAuthority, ...readDependencies } = dependencies;
  void _ignoredAuthority;
  const reader = createZohoClient({ ...clientConfiguration, allowWrites: false }, readDependencies);
  let authority: ProductionZohoAuthority | undefined;
  let writer: ReturnType<typeof createZohoClient> | undefined;
  try {
    await reader.verifyOrganization();
    authority = await verifyProductionZohoProfile(reader, config);
    reader.close();
    writer = createZohoClient({ ...clientConfiguration, allowWrites: true }, { ...readDependencies, productionAuthority: authority });
    const organization = Object.freeze(await writer.verifyOrganization());
    const ports = createZohoTransports(writer);
    const crmIntegration: CrmIntegration = Object.freeze({ leads: Object.freeze(ports.leads), commercial: Object.freeze(ports.commercial),
      accountOwnerId: config.accountOwnerId, accountPayloadProfile: "standard-account-contact-email-v1",
      dealPayloadProfile: "legacy-conversion-fields-v1", stagePayloadProfile: "voltronix-stage-reference-values-v1", dealPipeline: config.dealPipeline,
      production: Object.freeze({ organizationId: config.organizationId, quotationProfile: "voltronix-custom-quoted-items-v8",
        numberingProfile: "voltronix-hub-local-references-v1", dealLayoutId: productionZohoLayoutId(authority, config.organizationId) }) });
    const ownedWriter = writer, ownedAuthority = authority;
    let closed = false;
    return Object.freeze({ organization, crmIntegration,
      async readiness(): Promise<void> {
        if (closed) throw new ProductionZohoProfileError("AUTHORITY");
        const response = await ownedWriter.request({ apiVersion: "v8", method: "GET", path: "/org" });
        if (response.status !== 200) throw new ProductionZohoProfileError("ORGANIZATION");
        assertProductionOrganization(response.body, config.organizationId);
      },
      close(): void {
        if (closed) return;
        closed = true; revokeProductionZohoAuthority(ownedAuthority); ownedWriter.close();
      },
    });
  } catch (error) {
    reader.close(); writer?.close();
    if (authority) revokeProductionZohoAuthority(authority);
    if (error instanceof ProductionZohoProfileError || error instanceof ZohoClientError) throw error;
    throw new ProductionZohoProfileError();
  }
}
