import { existsSync, lstatSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadHubEnvironment } from "./hub-environment.mjs";
import { loadNativeConfiguration, validateProfile } from "./run-hub.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const help = "Usage: node tools/bind-zoho-user.mjs check|apply\nReads root .env and protected server/.local-data/operators/zoho-user-binding.json. Verifies one active VZ_app_users record in the pinned production organization. check performs no database writes; apply stores one immutable local binding and revokes that user's sessions. Neither command writes to Zoho.";
let modulesPromise;
async function modules() {
  if (!modulesPromise) {
    const { register } = await import("node:module"); register("tsx/esm", import.meta.url);
    modulesPromise = Promise.all([import("../server/src/operations/zoho-user-binding.ts"),
      import("../server/src/runtime/private-profile.ts"), import("../server/src/runtime/zoho-configuration.ts"),
      import("../server/src/integrations/zoho/session.ts")]);
  }
  return modulesPromise;
}
function fail(code = "CONFIGURATION") {
  return { exitCode: 1, stdout: "", stderr: `Zoho application-user binding refused (${code}). Verify the protected request, native target, operator permissions and exact active custom-user email. Existing attempt receipts require manual review; no identity fallback or automatic retry was attempted.` };
}
function receiptWriter(root, request, assertPrivate) {
  const directory = join(root, "server", ".local-data", "operators");
  const path = phase => join(directory, `zoho-user-binding-${request.requestId}-${phase}.json`);
  const ordinary = () => {
    for (const current of [root, join(root, "server"), join(root, "server", ".local-data"), directory]) {
      if (lstatSync(current).isSymbolicLink() || resolve(realpathSync(current)).toLowerCase() !== resolve(current).toLowerCase()) throw Error();
    }
    assertPrivate(directory);
  };
  return {
    attempted() { ordinary(); return existsSync(path("attempt")); },
    write(phase, result) {
      ordinary();
      writeFileSync(path(phase), JSON.stringify({ version: 1, requestId: request.requestId, reference: request.reference,
        target: request.target, at: new Date().toISOString(), ...result }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      assertPrivate(path(phase));
    },
  };
}

/** Setup can verify a binding before runtime activation. Credentials are loaded
 * solely from the root file; the provider session always remains read-only. */
export async function runZohoUserBinding(args = [], environment = process.env, dependencies = {}) {
  if (args.length === 1 && args[0] === "--help") return { exitCode: 0, stdout: help, stderr: "" };
  if (args.length !== 1 || !["check", "apply"].includes(args[0]) || Number(process.versions.node.split(".")[0]) !== 24
    || ["DEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_OPTIONS", "PWDEBUG"].some(key => environment[key]?.trim())
    || process.execArgv.some(value => /^--inspect(?:-brk|-wait)?(?:=|$)/.test(value))
    || environment.CRM_MYSQL_NETWORK_DISABLED === "1" || environment.ZOHO_NETWORK_DISABLED === "1") return fail();
  let receipts, attempted = false, session;
  try {
    const root = dependencies.root ?? projectRoot;
    const [binding, files, configuration, sessions] = await (dependencies.modules ?? modules)();
    const values = (dependencies.loadEnvironment ?? loadHubEnvironment)(root, {});
    if (values.ZOHO_NETWORK_DISABLED === "1") return fail();
    const profile = validateProfile("api", values);
    if (profile.databaseMode !== "mysql-native") return fail();
    const config = await (dependencies.loadConfiguration ?? loadNativeConfiguration)(root, profile, true);
    const zoho = configuration.productionZohoConfigurationFromEnvironment(values);
    const request = binding.validateZohoBindingRequest(config, zoho.organizationId,
      files.readPrivateZohoBindingRequest(join(root, "server"), binding.zohoUserBindingRequestPath));
    if (args[0] === "apply") {
      receipts = (dependencies.receiptWriter ?? receiptWriter)(root, request, files.assertPrivateAccess);
      if (receipts.attempted()) return fail("ATTEMPT_EXISTS");
      receipts.write("attempt", { status: "ATTEMPT_STARTED" }); attempted = true;
    }
    session = await sessions.openZohoSession({ credentials: zoho.credentials, organizationId: zoho.organizationId,
      environment: "production", mode: "read-only", accountOwnerId: zoho.accountOwnerId,
      accountPayloadProfile: "standard-account-contact-email-v1", dealPayloadProfile: "legacy-conversion-fields-v1",
      stagePayloadProfile: "voltronix-stage-labels-v1", dealPipeline: zoho.dealPipeline }, { networkEnabled: true });
    const result = await binding.bindZohoApplicationUser(config, request, session, args[0]);
    session.close(); session = undefined;
    if (receipts) receipts.write("complete", result);
    return { exitCode: 0, stdout: JSON.stringify(result), stderr: "" };
  } catch (error) {
    const code = ["CONFIGURATION", "LOCAL_USER", "CONFLICT", "REMOTE_USER", "DATABASE"].includes(error?.code) ? error.code : "CONFIGURATION";
    if (attempted) { try { receipts.write("failed", { status: "FAILED_OR_UNKNOWN", code }); } catch { /* retain original attempt */ } }
    return fail(code);
  } finally { try { session?.close(); } catch { /* no secret diagnostics */ } }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runZohoUserBinding(process.argv.slice(2)).then(result => {
    if (result.stdout) process.stdout.write(result.stdout + "\n");
    if (result.stderr) process.stderr.write(result.stderr + "\n");
    process.exitCode = result.exitCode;
  }).catch(() => { process.stderr.write("Zoho application-user binding refused.\n"); process.exitCode = 1; });
}
