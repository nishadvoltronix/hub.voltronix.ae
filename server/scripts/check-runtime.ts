import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadRuntimeConfiguration, RuntimeConfigurationError } from "../src/runtime/configuration.js";
import { readPrivateRuntimeProfile } from "../src/runtime/private-profile.js";
import { ConfigurationError, loadConfig } from "../src/config.js";
import { EnvironmentFileError, isMysqlRuntimeSelected, loadBackendEnvironment } from "../src/environment.js";
import { loadRuntimeZohoConfiguration, loadRuntimeZohoSyncConfiguration } from "../src/runtime/zoho-configuration.js";

// Explicit no-write command. Foundation settings require no private profile;
// MySQL selection still requires its guarded profile. No driver/composition is
// imported, so neither mode opens a listener or connects to a database.
try {
  if (process.argv.length !== 2 || process.execArgv.some(arg => arg.startsWith("--inspect"))) throw new Error();
  loadBackendEnvironment();
  const integration = loadRuntimeZohoConfiguration(process.env);
  const inbound = loadRuntimeZohoSyncConfiguration(process.env);
  if (isMysqlRuntimeSelected(process.env)) {
    const config = loadRuntimeConfiguration(resolve(fileURLToPath(new URL("..", import.meta.url))), process.env, readPrivateRuntimeProfile);
    console.log(JSON.stringify({ status: "PASS_CONFIGURATION_ONLY", host: config.mysql.host, port: config.mysql.port,
      environment: config.mysql.environment, profileValidated: process.env.CRM_RUNTIME_SOURCE !== "environment",
      configurationSource: process.env.CRM_RUNTIME_SOURCE === "environment" ? "backend-environment" : "private-profile",
      databaseConnections: 0, databaseWrites: 0, zohoConnections: 0, zohoProfileSelected: integration !== undefined, zohoInboundSelected: inbound !== undefined,
      limitation: "Approval provenance, server/schema/grants and workflows require separate live verification." }));
  } else {
    const config = loadConfig(process.env);
    if (config.environment === "production") throw new RuntimeConfigurationError();
    console.log(JSON.stringify({ status: "PASS_LOCAL_API_CONFIGURATION", mode: "foundation-only", ...config,
      profileValidated: false, databaseConnections: 0, databaseWrites: 0,
      limitation: "This validates API settings only, not CRM availability. Start the SQLite CRM with start-sqlite-demo.ps1; its guarded launcher supplies the demo environment." }));
  }
} catch (error) {
  const code = error instanceof EnvironmentFileError ? "ENVIRONMENT_FILE"
    : error instanceof ConfigurationError ? "LOCAL_API_CONFIGURATION" : "RUNTIME_CONFIGURATION";
  const hint = code === "ENVIRONMENT_FILE"
    ? "Check server/.env against server/.env.example: supported keys only, one assignment per line, no duplicates or multiline values."
    : code === "LOCAL_API_CONFIGURATION"
      ? "Check CRM_API_ENVIRONMENT (development, test or production), CRM_API_HOST (127.0.0.1), CRM_API_PORT (1024-65535), APP_ORIGIN and explicit Zoho settings. Explicit process settings override server/.env."
      : "MySQL requires an approved private profile OR production CRM_RUNTIME_SOURCE=environment with all documented CRM_MYSQL_* fields. Do not mix sources. Selected Zoho requires the complete pinned production profile. No credentials/profile are created by this check.";
  console.error(JSON.stringify({ status: "REFUSED", code, hint, databaseConnections: 0, databaseWrites: 0 }));
  process.exitCode = 1;
}
