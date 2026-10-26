import nextEnvironment from "@next/env";
import { fileURLToPath } from "node:url";
import { frontendBackend } from "../src/server/config/frontend-backend";
import { parseWebConfig } from "../src/server/config/web";
import { readDevelopmentRuntimeMysqlConfig } from "../src/server/config/mysql-runtime";

const { loadEnvConfig } = nextEnvironment;

/** Match Next's dotenv loading, rooted at this package rather than the caller's cwd.
 * The injectable directory is for isolated tests, never a CLI/profile selection. */
export function runFrontendConfigurationCheck(args: readonly string[], root = fileURLToPath(new URL("..", import.meta.url))): void {
  try {
    if (args.length !== 0) throw new Error();
    let failed = false;
    // Next may catch dotenv read/expansion errors and pass their contents to its
    // logger. Suppress those values and refuse instead of accepting partial input.
    loadEnvConfig(root, process.env.NODE_ENV !== "production", {
      info() {}, error() { failed = true; },
    }, true);
    if (failed) throw new Error();
    const target = frontendBackend(process.env);
    parseWebConfig(process.env);
    // No connections or writes. Express mode never reads a database profile.
    if (target.mode === "nextjs") readDevelopmentRuntimeMysqlConfig(root, process.env);
    console.log(JSON.stringify({ status: "PASS_CONFIGURATION_ONLY", mode: target.mode, databaseConnections: 0, databaseWrites: 0,
      limitation: "Upstream health, authorization, target schema and production acceptance are separate checks." }));
  } catch {
    console.error(JSON.stringify({ status: "REFUSED", code: "FRONTEND_CONFIGURATION", databaseConnections: 0, databaseWrites: 0,
      hint: "Use CRM_FRONTEND_BACKEND=express and CRM_EXPRESS_ORIGIN=http://127.0.0.1:<port 1024-65535> or http://[::1]:<port 1024-65535>. APP_ORIGIN must be a distinct HTTP 127.0.0.1 origin with an explicit port or a canonical HTTPS DNS origin on port 443. HTTPS also requires CRM_API_INSTANCE_ID matching the API configuration. Production never falls back to direct Next database access. Check readable frontend-owned dotenv files." }));
    process.exitCode = 1;
  }
}
