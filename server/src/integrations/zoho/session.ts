import { z } from "zod";
import { createZohoClient, ZohoClientError, type ZohoClientDependencies } from "./client.js";
import { createZohoTransports } from "./transports.js";
import { checkZohoReadiness } from "./readiness.js";
import { readZohoRecords, type ZohoReadLimits, type ZohoRecordScope } from "./records.js";
import { ACCOUNT_PAYLOAD_PROFILES, DEAL_PAYLOAD_PROFILES, dealPipelineSchema } from "../../crm/commercial/deals.js";
import { STAGE_PAYLOAD_PROFILES } from "../../crm/lead-mutations/stage-profile.js";
import type { CrmIntegration } from "../../crm/router.js";
import { readVerifiedZohoAppUser } from "./app-users.js";

const secret = z.string().regex(/^[A-Za-z0-9._~-]{1,4096}$/);
const identifier = z.string().regex(/^[1-9][0-9]{0,29}$/);
const configuration = z.object({
  credentials: z.object({ clientId: secret, clientSecret: secret, refreshToken: secret }).strict(),
  environment: z.enum(["production", "sandbox"]), organizationId: identifier,
  mode: z.enum(["read-only", "sandbox-write"]),
  accountOwnerId: identifier.optional(),
  accountPayloadProfile: z.enum(ACCOUNT_PAYLOAD_PROFILES).optional(),
  dealPipeline: dealPipelineSchema.optional(),
  dealPayloadProfile: z.enum(DEAL_PAYLOAD_PROFILES), stagePayloadProfile: z.enum(STAGE_PAYLOAD_PROFILES),
}).strict().refine(value => value.mode !== "sandbox-write" || (value.environment === "sandbox" && value.accountOwnerId !== undefined));
export type ZohoSessionConfiguration = z.infer<typeof configuration>;

/** One explicit integration boundary: caller supplies an independently confirmed
 * org ID, credentials, mode and mapping choices. Nothing is discovered from env
 * or persisted. Opening verifies the pinned org BEFORE returning any consumer.
 * Production is read-only; no runtime/CLI/UI selector is introduced here. */
export async function openZohoSession(input: ZohoSessionConfiguration, dependencies: ZohoClientDependencies = {}) {
  let config: ZohoSessionConfiguration;
  try { config = configuration.parse(input); }
  catch { throw new ZohoClientError("CONFIG_INVALID"); }
  const client = createZohoClient({ ...config.credentials, environment: config.environment,
    organizationId: config.organizationId, allowWrites: config.mode === "sandbox-write" }, dependencies);
  try {
    const organization = Object.freeze(await client.verifyOrganization());
    const ports = createZohoTransports(client);
    const integration: CrmIntegration | undefined = config.mode === "sandbox-write" ? Object.freeze({
      leads: Object.freeze(ports.leads), commercial: Object.freeze(ports.commercial), accountOwnerId: config.accountOwnerId!,
      dealPayloadProfile: config.dealPayloadProfile, stagePayloadProfile: config.stagePayloadProfile,
      ...(config.accountPayloadProfile === undefined ? {} : { accountPayloadProfile: config.accountPayloadProfile }),
      ...(config.dealPipeline === undefined ? {} : { dealPipeline: config.dealPipeline }),
    }) : undefined;
    return Object.freeze({
      organization,
      mode: config.mode,
      // Read-only sessions never produce a transport that could accidentally
      // make the router advertise a write-capable remote integration.
      crmIntegration: integration,
      inspectMetadata: () => checkZohoReadiness(client, { dealPayloadProfile: config.dealPayloadProfile,
        stagePayloadProfile: config.stagePayloadProfile,
        ...(config.accountPayloadProfile === undefined ? {} : { accountPayloadProfile: config.accountPayloadProfile }),
        ...(config.dealPipeline === undefined ? {} : { dealPipeline: config.dealPipeline }) }),
      readRecords: (scope: ZohoRecordScope, limits: ZohoReadLimits) => readZohoRecords(client, scope, limits),
      readAppUser: (id: string) => readVerifiedZohoAppUser(client, id),
      close: () => client.close(),
    });
  } catch (error) {
    client.close();
    throw error instanceof ZohoClientError ? error : new ZohoClientError("UNAVAILABLE");
  }
}
