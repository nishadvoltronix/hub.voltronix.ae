import { loadBackendEnvironment } from "../../src/environment.js";
import { validateZohoEnvironment } from "../../src/runtime/environment-settings.js";
import { inspectZohoMetadata, parseInspectionProfiles, ZohoInspectionError, type ZohoInspectionDependencies } from "./inspection.js";

export interface ZohoInspectionCommandDependencies {
  loadEnvironment?: (target: Record<string, string | undefined>) => void;
  fetch?: typeof fetch;
  timeoutMs?: number;
  profiles?: ZohoInspectionDependencies["profiles"];
}
export interface ZohoInspectionCommandOutput { exitCode: 0 | 1 | 2; stdout: string; stderr: string }

/** Import-safe operator boundary. Invocation guards run BEFORE reading any
 * private file or refreshing a token. Credentials are loaded into a detached
 * map, never merged into process.env or selected from command-line arguments. */
export async function runZohoInspectionCommand(args: readonly string[], environment: Readonly<Record<string, string | undefined>>,
  execArgs: readonly string[], dependencies: ZohoInspectionCommandDependencies = {}): Promise<ZohoInspectionCommandOutput> {
  const failure = (message: string): ZohoInspectionCommandOutput => ({ exitCode: 1, stdout: "", stderr: message });
  if (args.length === 1 && args[0] === "--help") return { exitCode: 0, stderr: "", stdout:
    "npm run zoho:inspect\nRead-only US metadata inspection using the existing private server/.env grant. No sandbox or new consent required.\nNo business records, file changes, runtime enablement or acceptance claim. Exit 2 means an inspection report was produced, not full integration acceptance." };
  if (args.length) return failure("Use zoho:inspect without credential or endpoint arguments.");
  if (["DEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_OPTIONS", "PWDEBUG"].some(key => environment[key]?.trim())
    || execArgs.some(value => value.startsWith("--inspect")) || environment.ZOHO_NETWORK_DISABLED === "1") {
    return failure("Read-only inspection refused while debugging or ZOHO_NETWORK_DISABLED is active. No private file was loaded or request sent.");
  }
  try {
    const profiles = parseInspectionProfiles(dependencies.profiles);
    const values: Record<string, string | undefined> = {};
    (dependencies.loadEnvironment ?? loadBackendEnvironment)(values);
    validateZohoEnvironment(values);
    const options: ZohoInspectionDependencies = { networkEnabled: true,
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      ...(dependencies.timeoutMs === undefined ? {} : { timeoutMs: dependencies.timeoutMs }),
      ...(profiles === undefined ? {} : { profiles }) };
    const report = await inspectZohoMetadata({ clientId: values.ZOHO_CLIENT_ID ?? "", clientSecret: values.ZOHO_CLIENT_SECRET ?? "",
      refreshToken: values.ZOHO_REFRESH_TOKEN ?? "" }, options);
    return { exitCode: 2, stderr: "", stdout: `${JSON.stringify(report, null, 2)}\nMetadata inspection completed. This is not full CRM workflow/production acceptance; existing .env and runtime settings are unchanged.` };
  } catch (error) {
    return failure(error instanceof ZohoInspectionError ? error.message
      : "Read-only inspection failed. Check server/.env syntax, private file access and disabled runtime settings. No secret or provider response was logged.");
  }
}
