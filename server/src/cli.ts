import { ConfigurationError, loadConfig } from "./config.js";
import { startServer } from "./server.js";
import { fileURLToPath } from "node:url";
import { loadRuntimeConfiguration, RuntimeConfigurationError } from "./runtime/configuration.js";
import { openCrmRuntime } from "./runtime/composition.js";
import { loadRuntimeZohoConfiguration, loadRuntimeZohoSyncConfiguration, RuntimeIntegrationError } from "./runtime/zoho-configuration.js";
import { readPrivateRuntimeProfile } from "./runtime/private-profile.js";
import { EnvironmentFileError, isMysqlRuntimeSelected, loadBackendEnvironment } from "./environment.js";

// This explicit entrypoint is the only module that starts a listener or installs signals.
try {
  loadBackendEnvironment();
  const enabled = isMysqlRuntimeSelected(process.env);
  if (enabled && process.execArgv.some(argument => /^--inspect(?:-brk|-wait)?(?:=|$)/.test(argument))) throw new Error();
  const configuration = enabled ? loadRuntimeConfiguration(fileURLToPath(new URL("..", import.meta.url)), process.env, readPrivateRuntimeProfile) : undefined;
  const api = configuration?.api ?? loadConfig(process.env);
  if (api.environment === "production" && !configuration) throw new RuntimeConfigurationError();
  const runtime = configuration ? await openCrmRuntime(configuration, loadRuntimeZohoConfiguration(process.env),
    { networkEnabled: process.env.ZOHO_NETWORK_DISABLED !== "1" }, loadRuntimeZohoSyncConfiguration(process.env)) : undefined;
  let instance: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    if (api.environment === "production" && !await runtime?.readiness()) throw new RuntimeConfigurationError();
    instance = await startServer(api,
      runtime ? { auth: runtime.auth, crmServices: runtime.crmServices, readiness: runtime.readiness } : {}, runtime?.close);
    runtime?.startBackground?.();
  } catch (error) { if (instance) await instance.stop(); else await runtime?.close(); throw error; }
  const owned = instance;
  const shutdown = () => {
    owned.stop().catch(() => { console.error("Local API shutdown failed."); process.exitCode = 1; });
  };
  owned.server.once("close", () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    if (owned.failed) { console.error("Local API listener failed and was stopped."); process.exitCode = 1; }
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.log(api.environment === "production" ? "CRM API listener started; database startup check passed. Workflow and host acceptance remain separate."
    : enabled ? "Local CRM API listener started; MySQL and workflow readiness require separate verification."
    : "Local API foundation started; authentication store, CRM and database readiness are unavailable.");
} catch (error) {
  // Only fixed diagnostic text is emitted. Never log the supplied value,
  // underlying exception, private profile or driver error.
  const hint = error instanceof EnvironmentFileError
    ? "Check server/.env syntax and supported keys against server/.env.example."
    : error instanceof ConfigurationError
      ? "Check CRM_API_ENVIRONMENT, CRM_API_HOST, CRM_API_PORT, APP_ORIGIN and explicit Zoho settings. Process settings override server/.env."
      : error instanceof RuntimeIntegrationError
        ? "Check the explicit Zoho production profile, organization, owner and pipeline; no fallback or automatic retry was attempted."
      : error instanceof RuntimeConfigurationError
        ? "Check explicit CRM_RUNTIME selection: approved private profile OR production CRM_RUNTIME_SOURCE=environment with all CRM_MYSQL_* fields; never mix sources."
        : "Check the local configuration and listener; no automatic migration or account changes were attempted.";
  console.error(`Local API startup failed. ${hint}`);
  process.exitCode = 1;
}
