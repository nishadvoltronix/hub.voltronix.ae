import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadHubEnvironment } from "./hub-environment.mjs";
import { loadNativeConfiguration, validateProfile } from "./run-hub.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const help = "Usage: node tools/sync-zoho.mjs check|run\nUses the private root .env, pinned production Zoho organization and explicit existing native administrator. check performs only dependency/status reads. run performs one bounded initial or incremental import into Hub, using the persisted checkpoint and lease. Neither command writes Zoho records. Background polling is controlled separately by ZOHO_SYNC_ENABLED.";
const codes = new Set(["INPUT_INVALID", "ACCESS_DENIED", "SOURCE_MISMATCH", "LEASE_LOST", "DATABASE", "ABORTED", "REQUEST_FAILED",
  "RATE_LIMITED", "RESPONSE_INVALID", "PAGINATION_INVALID", "LIMIT_EXCEEDED", "ORGANIZATION_MISMATCH", "CURSOR_TOO_OLD", "INCOMPLETE_QUOTE"]);
const failure = code => ({ exitCode: 1, stdout: "", stderr: `Zoho inbound synchronization refused (${codes.has(code) ? code : "CONFIGURATION"}). Check the native target, explicit administrator, pinned provider and retained local sync status. No Zoho record was written.` });
let modulesPromise;
async function modules() {
  if (!modulesPromise) {
    const { register } = await import("node:module"); register("tsx/esm", import.meta.url);
    modulesPromise = Promise.all([import("../server/src/runtime/composition.ts"), import("../server/src/runtime/zoho-configuration.ts"),
      import("../server/src/integrations/zoho/inbound-sync-source.ts"), import("../server/src/integrations/zoho/inbound-store.ts"),
      import("../server/src/integrations/zoho/inbound-sync.ts")]);
  }
  return modulesPromise;
}
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
function counts(value) {
  if (!value || typeof value !== "object") return null;
  const result = Object.fromEntries(["read", "applied", "skipped", "conflicts", "deleted"].map(key => [key, count(value[key])]));
  return Object.values(result).some(value => value === undefined) ? null : result;
}
const timestamp = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;

export async function runZohoInbound(args = [], environment = process.env, dependencies = {}) {
  if (args.length === 1 && args[0] === "--help") return { exitCode: 0, stdout: help, stderr: "" };
  if (args.length !== 1 || !["check", "run"].includes(args[0]) || Number(process.versions.node.split(".")[0]) !== 24
    || ["DEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_OPTIONS", "PWDEBUG"].some(key => environment[key]?.trim())
    || process.execArgv.some(value => /^--inspect(?:-brk|-wait)?(?:=|$)/.test(value))
    || environment.CRM_MYSQL_NETWORK_DISABLED === "1" || environment.ZOHO_NETWORK_DISABLED === "1") return failure();
  const signal = dependencies.signal ?? new AbortController().signal;
  if (signal.aborted) return failure("ABORTED");
  let runtime, source, result;
  const interrupt = () => { try { source?.close(); } catch { /* no provider diagnostics */ } };
  signal.addEventListener("abort", interrupt, { once: true });
  try {
    const root = dependencies.root ?? projectRoot;
    const [composition, configuration, provider, store, coordinator] = await (dependencies.modules ?? modules)();
    const values = (dependencies.loadEnvironment ?? loadHubEnvironment)(root, {});
    if (values.ZOHO_NETWORK_DISABLED === "1" || signal.aborted) throw Error();
    const profile = validateProfile("api", values);
    if (profile.databaseMode !== "mysql-native") throw Error();
    const config = await (dependencies.loadConfiguration ?? loadNativeConfiguration)(root, profile, true);
    const selected = configuration.zohoSyncConfigurationFromEnvironment(values);
    runtime = composition.createCrmRuntime(config);
    if (!await runtime.readiness()) throw Error();
    const status = await store.readZohoInboundStatus(runtime.database, selected.organizationId, selected.principalId);
    if (signal.aborted) throw Object.assign(Error(), { code: "ABORTED" });
    source = await provider.openZohoInboundSource({ credentials: selected.credentials, organizationId: selected.organizationId }, { networkEnabled: true });
    await source.readiness();
    if (signal.aborted) throw Object.assign(Error(), { code: "ABORTED" });
    if (args[0] === "check") {
      const state = ["idle", "running", "partial", "ready", "failed"].includes(status.state) ? status.state : "failed";
      result = { exitCode: 0, stdout: JSON.stringify({ status: "CHECKED_READ_ONLY", state, generation: count(status.generation),
        checkpointAvailable: status.checkpointAvailable === true, lastAttemptAt: timestamp(status.lastAttemptAt),
        lastSuccessAt: timestamp(status.lastSuccessAt), counts: counts(status.counts), errorCode: codes.has(status.errorCode) ? status.errorCode : null,
        leaseActive: status.leaseActive === true }), stderr: "" };
    } else {
      const outcome = await coordinator.runZohoInboundSync({ database: runtime.database, source,
        organizationId: selected.organizationId, principalId: selected.principalId, signal });
      if (!["completed", "partial", "busy"].includes(outcome.status)) throw Error();
      result = { exitCode: outcome.status === "completed" ? 0 : 2, stdout: JSON.stringify({ status: outcome.status,
        generation: count(outcome.generation), counts: counts(outcome.counts) }), stderr: "" };
    }
  } catch (error) { result = failure(error?.code); }
  signal.removeEventListener("abort", interrupt);
  const closedSource = await Promise.allSettled([Promise.resolve().then(() => source?.close())]);
  const closedDatabase = await Promise.allSettled([Promise.resolve().then(() => runtime?.close())]);
  if ([...closedSource, ...closedDatabase].some(value => value.status === "rejected")) return failure("DATABASE");
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const abort = new AbortController(), stop = () => abort.abort();
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  void runZohoInbound(process.argv.slice(2), process.env, { signal: abort.signal }).then(result => {
    if (result.stdout) process.stdout.write(result.stdout + "\n");
    if (result.stderr) process.stderr.write(result.stderr + "\n");
    process.exitCode = result.exitCode;
  }).catch(() => { process.stderr.write("Zoho inbound synchronization refused.\n"); process.exitCode = 1; })
    .finally(() => { process.off("SIGINT", stop); process.off("SIGTERM", stop); });
}
