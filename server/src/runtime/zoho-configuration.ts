import { validateProductionZohoConfiguration, type ProductionZohoConfiguration } from "../integrations/zoho/production.js";
import { validateZohoEnvironment } from "./environment-settings.js";
import { z } from "zod";

type Environment = Readonly<Record<string, string | undefined>>;
export class RuntimeIntegrationError extends Error {
  constructor() { super("Explicit CRM integration configuration or dependency verification failed; no fallback was attempted."); }
}

/** Pure setup projection. Operators can verify bindings while normal runtime
 * activation is still false. No environment file is read or modified here. */
export function productionZohoConfigurationFromEnvironment(environment: Environment): ProductionZohoConfiguration {
  try {
    return validateProductionZohoConfiguration({ credentials: { clientId: environment.ZOHO_CLIENT_ID,
      clientSecret: environment.ZOHO_CLIENT_SECRET, refreshToken: environment.ZOHO_REFRESH_TOKEN },
    organizationId: environment.ZOHO_ORGANIZATION_ID, accountOwnerId: environment.ZOHO_ACCOUNT_OWNER_ID,
    profile: environment.ZOHO_PROFILE, dealPipeline: environment.ZOHO_DEAL_PIPELINE,
    automationPolicy: environment.ZOHO_AUTOMATION_POLICY });
  } catch { throw new RuntimeIntegrationError(); }
}

/** Runtime selection never infers activation from stored credentials. */
export function loadRuntimeZohoConfiguration(environment: Environment): ProductionZohoConfiguration | undefined {
  try {
    validateZohoEnvironment(environment);
    if (environment.ZOHO_ENABLED !== "true") return undefined;
    return productionZohoConfigurationFromEnvironment(environment);
  } catch { throw new RuntimeIntegrationError(); }
}

const syncConfiguration = z.object({
  credentials: z.object({ clientId: z.string().regex(/^[A-Za-z0-9._~-]{1,4096}$/),
    clientSecret: z.string().regex(/^[A-Za-z0-9._~-]{1,4096}$/), refreshToken: z.string().regex(/^[A-Za-z0-9._~-]{1,4096}$/) }).strict(),
  organizationId: z.string().regex(/^[1-9][0-9]{0,29}$/), principalId: z.string().regex(/^[1-9][0-9]{0,29}$/),
  intervalMs: z.number().int().min(60_000).max(86_400_000),
}).strict();
export type RuntimeZohoSyncConfiguration = z.infer<typeof syncConfiguration>;
export function validateRuntimeZohoSyncConfiguration(input: unknown): RuntimeZohoSyncConfiguration {
  try {
    const parsed = syncConfiguration.parse(input);
    return Object.freeze({ ...parsed, credentials: Object.freeze(parsed.credentials) });
  } catch { throw new RuntimeIntegrationError(); }
}

/** Explicit one-shot operators may use stored configuration while polling is
 * disabled. This selects no write authority and opens no network connection. */
export function zohoSyncConfigurationFromEnvironment(environment: Environment): RuntimeZohoSyncConfiguration {
  try {
    validateZohoEnvironment(environment);
    if (environment.CRM_API_ENVIRONMENT !== "production" || environment.CRM_RUNTIME_ENABLE !== "approved-production-mysql-crm-runtime"
      || !/^[1-9][0-9]{1,4}$/.test(environment.ZOHO_SYNC_INTERVAL_SECONDS ?? "")) throw new Error();
    return validateRuntimeZohoSyncConfiguration({ credentials: { clientId: environment.ZOHO_CLIENT_ID,
      clientSecret: environment.ZOHO_CLIENT_SECRET, refreshToken: environment.ZOHO_REFRESH_TOKEN },
    organizationId: environment.ZOHO_ORGANIZATION_ID, principalId: environment.ZOHO_SYNC_PRINCIPAL_ID,
    intervalMs: Number(environment.ZOHO_SYNC_INTERVAL_SECONDS) * 1000 });
  } catch { throw new RuntimeIntegrationError(); }
}

export function loadRuntimeZohoSyncConfiguration(environment: Environment): RuntimeZohoSyncConfiguration | undefined {
  try {
    validateZohoEnvironment(environment);
    return environment.ZOHO_SYNC_ENABLED === "true" ? zohoSyncConfigurationFromEnvironment(environment) : undefined;
  } catch { throw new RuntimeIntegrationError(); }
}
