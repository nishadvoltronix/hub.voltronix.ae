import { mysqlEnvironmentKeys, zohoEnvironmentKeys } from "../../src/runtime/environment-settings.js";

/** Explicit synthetic process values prevent the executable's normal .env loader
 * from supplying operator credentials or selecting the operator's runtime. The
 * real loader still checks file syntax/privacy; no guard or file is bypassed. */
export function syntheticChildEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "TMPDIR",
    "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemDrive"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  for (const key of ["CRM_API_ENVIRONMENT", "CRM_API_HOST", "CRM_API_PORT", "APP_ORIGIN",
    "CRM_RUNTIME_ENABLE", "CRM_RUNTIME_PROFILE", "CRM_RUNTIME_SOURCE", ...mysqlEnvironmentKeys, ...zohoEnvironmentKeys]) {
    environment[key] = "";
  }
  return { ...environment, ZOHO_ENABLED: "false", ZOHO_SYNC_ENABLED: "false", ...overrides, CRM_MYSQL_NETWORK_DISABLED: "1", ZOHO_NETWORK_DISABLED: "1" };
}
