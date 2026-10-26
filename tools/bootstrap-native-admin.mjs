import { existsSync, lstatSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadHubEnvironment } from "./hub-environment.mjs";
import { loadNativeConfiguration, validateProfile } from "./run-hub.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const help = "Usage: node tools/bootstrap-native-admin.mjs check|apply\nReads root .env and protected server/.local-data/operators/native-admin-bootstrap.json. check is read-only. apply creates one initial native administrator only in an empty provisioned native database.";
let modulesPromise;
async function modules() {
  if (!modulesPromise) {
    const { register } = await import("node:module");
    register("tsx/esm", import.meta.url);
    modulesPromise = Promise.all([import("../server/src/runtime/bootstrap-admin.ts"), import("../server/src/runtime/private-profile.ts")]);
  }
  return modulesPromise;
}
function fail(code = "CONFIGURATION") {
  return { exitCode: 1, stdout: "", stderr: `Native administrator bootstrap refused (${code}). Verify the protected request, native target and empty schema. Existing attempt receipts require manual review; no fallback or automatic retry was attempted.` };
}
function receiptWriter(root, request, assertPrivate) {
  const directory = join(root, "server", ".local-data", "operators");
  const path = phase => join(directory, `native-admin-${request.requestId}-${phase}.json`);
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

/** No ambient credential override, bootstrap on startup, migration or default user. */
export async function runNativeAdminBootstrap(args = [], environment = process.env, dependencies = {}) {
  if (args.length === 1 && args[0] === "--help") return { exitCode: 0, stdout: help, stderr: "" };
  if (args.length !== 1 || !["check", "apply"].includes(args[0]) || Number(process.versions.node.split(".")[0]) !== 24
    || ["DEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_OPTIONS", "PWDEBUG"].some(key => environment[key]?.trim())
    || process.execArgv.some(value => /^--inspect(?:-brk|-wait)?(?:=|$)/.test(value)) || environment.CRM_MYSQL_NETWORK_DISABLED === "1") return fail();
  let receipts, attempted = false;
  try {
    const root = dependencies.root ?? projectRoot;
    const [bootstrap, files] = await (dependencies.modules ?? modules)();
    const values = (dependencies.loadEnvironment ?? loadHubEnvironment)(root, {});
    const profile = validateProfile("api", values);
    if (profile.databaseMode !== "mysql-native") return fail();
    const config = await (dependencies.loadConfiguration ?? loadNativeConfiguration)(root, profile, true);
    const request = bootstrap.validateNativeAdminRequest(config, files.readPrivateNativeAdminRequest(join(root, "server"), bootstrap.nativeAdminRequestPath));
    if (args[0] === "apply") {
      receipts = (dependencies.receiptWriter ?? receiptWriter)(root, request, files.assertPrivateAccess);
      if (receipts.attempted()) return fail("ATTEMPT_EXISTS");
      receipts.write("attempt", { status: "ATTEMPT_STARTED" }); attempted = true;
    }
    const result = await bootstrap.bootstrapNativeAdministrator(config, request, args[0]);
    if (receipts) receipts.write("complete", result);
    return { exitCode: 0, stdout: JSON.stringify(result), stderr: "" };
  } catch (error) {
    const code = ["CONFIGURATION", "NOT_EMPTY", "DATABASE"].includes(error?.code) ? error.code : "CONFIGURATION";
    if (attempted) { try { receipts.write("failed", { status: "FAILED_OR_UNKNOWN", code }); } catch { /* retain original attempt */ } }
    return fail(code);
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runNativeAdminBootstrap(process.argv.slice(2)).then(result => {
    if (result.stdout) process.stdout.write(result.stdout + "\n");
    if (result.stderr) process.stderr.write(result.stderr + "\n");
    process.exitCode = result.exitCode;
  }).catch(() => { process.stderr.write("Native administrator bootstrap refused.\n"); process.exitCode = 1; });
}
