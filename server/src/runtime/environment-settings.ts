/** Backend-only settings. Never import this module into browser contracts. */
export const mysqlEnvironmentKeys = ["CRM_MYSQL_HOST", "CRM_MYSQL_PORT", "CRM_MYSQL_DATABASE",
  "CRM_MYSQL_USER", "CRM_MYSQL_PASSWORD", "CRM_MYSQL_SERVER_UUID", "CRM_MYSQL_APPROVED",
  "CRM_MYSQL_APPROVAL_REFERENCE", "CRM_MYSQL_PROVISIONING_REFERENCE", "CRM_MYSQL_ISSUER_COMPANY",
  "CRM_MYSQL_ISSUER_SALESPERSON"] as const;
export const zohoCredentialKeys = ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN"] as const;
export const zohoRuntimeKeys = ["ZOHO_ORGANIZATION_ID", "ZOHO_ACCOUNT_OWNER_ID", "ZOHO_PROFILE",
  "ZOHO_DEAL_PIPELINE", "ZOHO_AUTOMATION_POLICY"] as const;
export const zohoSyncKeys = ["ZOHO_SYNC_ENABLED", "ZOHO_SYNC_INTERVAL_SECONDS", "ZOHO_SYNC_PRINCIPAL_ID"] as const;
export const zohoEnvironmentKeys = ["ZOHO_ENABLED", "ZOHO_NETWORK_DISABLED", ...zohoCredentialKeys, ...zohoRuntimeKeys, ...zohoSyncKeys] as const;
type Environment = Readonly<Record<string, string | undefined>>;

/** Pure boundary validation; explicit production selection is validated again
 * by the named integration profile before any network access. */
export function validateZohoEnvironment(environment: Environment): void {
  const keys = new Set<string>(zohoEnvironmentKeys);
  if (Object.keys(environment).some(key => key.startsWith("ZOHO_") && !keys.has(key))
    || (environment.ZOHO_ENABLED !== undefined && !["false", "true"].includes(environment.ZOHO_ENABLED))
    || (environment.ZOHO_SYNC_ENABLED !== undefined && !["false", "true"].includes(environment.ZOHO_SYNC_ENABLED))
    || (environment.ZOHO_NETWORK_DISABLED !== undefined && !["0", "1"].includes(environment.ZOHO_NETWORK_DISABLED))) {
    throw new Error("Invalid backend integration selection.");
  }
  for (const key of [...zohoCredentialKeys, ...zohoRuntimeKeys, ...zohoSyncKeys]) {
    const value = environment[key];
    if (value !== undefined && (Buffer.byteLength(value, "utf8") > 4096 || /[\r\n\0]/.test(value))) {
      throw new Error("Invalid backend integration configuration.");
    }
  }
  if (environment.ZOHO_SYNC_ENABLED === "true" && (environment.CRM_API_ENVIRONMENT !== "production"
    || environment.CRM_RUNTIME_ENABLE !== "approved-production-mysql-crm-runtime"
    || !/^[1-9][0-9]{0,29}$/.test(environment.ZOHO_ORGANIZATION_ID ?? "")
    || !/^[1-9][0-9]{0,29}$/.test(environment.ZOHO_SYNC_PRINCIPAL_ID ?? "")
    || !/^[1-9][0-9]{1,4}$/.test(environment.ZOHO_SYNC_INTERVAL_SECONDS ?? "")
    || Number(environment.ZOHO_SYNC_INTERVAL_SECONDS) < 60 || Number(environment.ZOHO_SYNC_INTERVAL_SECONDS) > 86_400
    || zohoCredentialKeys.some(key => !/^[A-Za-z0-9._~-]{1,4096}$/.test(environment[key] ?? "")))) {
    throw new Error("Explicit production Zoho inbound configuration is incomplete or invalid.");
  }
  if (environment.ZOHO_ENABLED === "true" && (environment.CRM_API_ENVIRONMENT !== "production"
    || environment.CRM_RUNTIME_ENABLE !== "approved-production-mysql-crm-runtime"
    || [...zohoCredentialKeys, ...zohoRuntimeKeys].some(key => !environment[key]?.trim())
    || environment.ZOHO_PROFILE !== "voltronix-native-outbound-v1"
    || environment.ZOHO_AUTOMATION_POLICY !== "suppressed"
    || !/^[1-9][0-9]{0,29}$/.test(environment.ZOHO_ORGANIZATION_ID!)
    || !/^[1-9][0-9]{0,29}$/.test(environment.ZOHO_ACCOUNT_OWNER_ID!)
    || environment.ZOHO_DEAL_PIPELINE!.length > 100 || environment.ZOHO_DEAL_PIPELINE!.trim() !== environment.ZOHO_DEAL_PIPELINE
    || zohoCredentialKeys.some(key => !/^[A-Za-z0-9._~-]{1,4096}$/.test(environment[key]!)))) {
    throw new Error("Explicit production Zoho configuration is incomplete or invalid.");
  }
}

/** Convert explicit environment settings to the SAME v2 validator input.
 * No credential defaults, profile reads, network requests or alternate adapter. */
export function productionProfileFromEnvironment(environment: Environment): unknown {
  for (const key of mysqlEnvironmentKeys) {
    const value = environment[key];
    if (!value?.trim() || /[\r\n\0]/.test(value)) throw new Error("Incomplete production environment configuration.");
  }
  if (environment.CRM_MYSQL_APPROVED !== "true" || !/^(3306|3308)$/.test(environment.CRM_MYSQL_PORT!)) {
    throw new Error("Invalid production environment approval or port.");
  }
  return { version: 2,
    mysql: { provider: "mysql", environment: "production", host: environment.CRM_MYSQL_HOST,
      port: Number(environment.CRM_MYSQL_PORT), database: environment.CRM_MYSQL_DATABASE,
      user: environment.CRM_MYSQL_USER, password: environment.CRM_MYSQL_PASSWORD },
    approval: { approved: true, reference: environment.CRM_MYSQL_APPROVAL_REFERENCE,
      provisioningReference: environment.CRM_MYSQL_PROVISIONING_REFERENCE, serverUuid: environment.CRM_MYSQL_SERVER_UUID },
    issuer: { company: environment.CRM_MYSQL_ISSUER_COMPANY, salesperson: environment.CRM_MYSQL_ISSUER_SALESPERSON } };
}
