import { spawn } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertSingleEnvironmentFileLayout, loadHubEnvironment, mysqlEnvironmentKeys, nativeEnvironmentKeys, zohoCredentialKeys, zohoRuntimeKeys, zohoSyncKeys } from "./hub-environment.mjs";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commonKeys = ["NODE_ENV", "APP_ORIGIN", "CRM_API_INSTANCE_ID", "CRM_DATABASE_MODE",
  "CRM_MYSQL_NETWORK_DISABLED", "ZOHO_ENABLED", "ZOHO_NETWORK_DISABLED", "NEXT_TELEMETRY_DISABLED"];
const webKeys = ["CRM_WEB_HOST", "CRM_WEB_PORT", "CRM_FRONTEND_BACKEND", "CRM_EXPRESS_ORIGIN"];
const apiKeys = ["CRM_API_ENVIRONMENT", "CRM_API_HOST", "CRM_API_PORT"];
const allowedKeys = new Set([...commonKeys, ...webKeys, ...apiKeys, ...nativeEnvironmentKeys, ...zohoCredentialKeys, ...zohoRuntimeKeys, ...zohoSyncKeys]);
const operatingSystemKeys = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
  "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LANG", "LC_ALL", "TZ"]);
function fail(message) { throw new Error(message); }
function port(value, key) {
  if (!/^[1-9][0-9]{3,4}$/.test(value ?? "") || Number(value) < 1024 || Number(value) > 65535) {
    fail(`${key} must be an explicit port from 1024 to 65535.`);
  }
  return Number(value);
}
function host(value, key) {
  if (value !== "127.0.0.1" && value !== "::1") fail(`${key} must be 127.0.0.1 or ::1.`);
  return value;
}
function productionOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.port
      && url.hostname.includes(".") && url.hostname.length <= 253
      && !/^[0-9.]+$/.test(url.hostname) && !url.hostname.endsWith(".localhost")
      && url.hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  } catch { return false; }
}

/** Explicit selectors only; native credentials undergo the existing v2 validator before use. */
export function validateProfile(kind, environment) {
  if (kind !== "web" && kind !== "api") fail("Select the web or api profile.");
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined || value === "") continue;
    if ((!allowedKeys.has(key) && /^(?:CRM_|ZOHO_|DATABASE_|MYSQL_|DB_|NEXT_PUBLIC_)/i.test(key))
      || /^(?:NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|DEBUG|NODE_DEBUG|NODE_DEBUG_NATIVE|PWDEBUG|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NODE_USE_ENV_PROXY)$/i.test(key)) {
      fail(`Unsupported environment setting: ${key}. Remove it from the Hub process environment.`);
    }
  }
  for (const [key, expected] of Object.entries({ NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" })) {
    if (environment[key] !== expected) fail(`${key} must explicitly equal ${expected}.`);
  }
  if (!["false", "true"].includes(environment.ZOHO_ENABLED)
    || (environment.ZOHO_SYNC_ENABLED !== undefined && !["false", "true"].includes(environment.ZOHO_SYNC_ENABLED))
    || (environment.ZOHO_NETWORK_DISABLED !== undefined && !["0", "1"].includes(environment.ZOHO_NETWORK_DISABLED))) {
    fail("ZOHO_ENABLED must explicitly equal false or true; the optional network veto must be 0 or 1.");
  }
  if ([...zohoCredentialKeys, ...zohoRuntimeKeys, ...zohoSyncKeys].some(key => environment[key] !== undefined
    && (typeof environment[key] !== "string" || Buffer.byteLength(environment[key], "utf8") > 4096 || /[\r\n\0]/.test(environment[key])))) {
    fail("Zoho configuration must contain bounded single-line values.");
  }
  const databaseMode = environment.CRM_DATABASE_MODE;
  const zohoEnabled = environment.ZOHO_ENABLED === "true";
  const zohoSyncEnabled = environment.ZOHO_SYNC_ENABLED === "true";
  if (zohoSyncEnabled && (databaseMode !== "mysql-native"
    || !/^[1-9][0-9]{0,29}$/.test(environment.ZOHO_ORGANIZATION_ID ?? "")
    || !/^[1-9][0-9]{0,29}$/.test(environment.ZOHO_SYNC_PRINCIPAL_ID ?? "")
    || !/^[1-9][0-9]{1,4}$/.test(environment.ZOHO_SYNC_INTERVAL_SECONDS ?? "")
    || Number(environment.ZOHO_SYNC_INTERVAL_SECONDS) < 60 || Number(environment.ZOHO_SYNC_INTERVAL_SECONDS) > 86_400
    || zohoCredentialKeys.some(key => !/^[A-Za-z0-9._~-]{1,4096}$/.test(environment[key] ?? "")))) {
    fail("Zoho inbound polling requires native MySQL, pinned organization, an explicit existing administrator and a bounded polling interval.");
  }
  if (zohoEnabled && (databaseMode !== "mysql-native"
    || [...zohoCredentialKeys, ...zohoRuntimeKeys].some(key => !environment[key]?.trim())
    || environment.ZOHO_PROFILE !== "voltronix-native-outbound-v1" || environment.ZOHO_AUTOMATION_POLICY !== "suppressed"
    || !/^[1-9][0-9]{0,29}$/.test(environment.ZOHO_ORGANIZATION_ID)
    || !/^[1-9][0-9]{0,29}$/.test(environment.ZOHO_ACCOUNT_OWNER_ID)
    || environment.ZOHO_DEAL_PIPELINE.length > 100 || environment.ZOHO_DEAL_PIPELINE.trim() !== environment.ZOHO_DEAL_PIPELINE
    || zohoCredentialKeys.some(key => !/^[A-Za-z0-9._~-]{1,4096}$/.test(environment[key])))) {
    fail("Zoho activation requires native MySQL, explicit organization/owner/profile/pipeline and suppressed automation; no fallback is available.");
  }
  if (databaseMode !== "disabled" && databaseMode !== "mysql-native") fail("CRM_DATABASE_MODE must explicitly equal disabled or mysql-native; legacy schema activation is unavailable.");
  if (environment.CRM_MYSQL_NETWORK_DISABLED !== (databaseMode === "disabled" ? "1" : "0")) {
    fail("CRM_MYSQL_NETWORK_DISABLED must equal 1 for disabled mode or 0 for mysql-native mode.");
  }
  if (databaseMode === "disabled") {
    if (nativeEnvironmentKeys.some(key => environment[key]?.trim())) fail("Native database settings require explicit CRM_DATABASE_MODE=mysql-native; disabled mode cannot use credentials.");
  } else {
    if (environment.CRM_RUNTIME_ENABLE !== "approved-production-mysql-crm-runtime" || environment.CRM_RUNTIME_SOURCE !== "environment"
      || mysqlEnvironmentKeys.some(key => !environment[key]?.trim())) {
      fail("Native MySQL requires the production runtime acknowledgement, environment source and every CRM_MYSQL_* runtime field.");
    }
  }
  if (!productionOrigin(environment.APP_ORIGIN)) fail("APP_ORIGIN must be a canonical public HTTPS origin without a port or path.");
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(environment.CRM_API_INSTANCE_ID ?? "")) fail("CRM_API_INSTANCE_ID must be a nonempty lowercase instance slug.");
  const profile = { kind, databaseMode, zohoEnabled, zohoSyncEnabled, appOrigin: environment.APP_ORIGIN, instanceId: environment.CRM_API_INSTANCE_ID };
  if (kind === "web") {
    profile.host = host(environment.CRM_WEB_HOST, "CRM_WEB_HOST");
    profile.port = port(environment.CRM_WEB_PORT, "CRM_WEB_PORT");
    if (environment.CRM_FRONTEND_BACKEND !== "express") fail("CRM_FRONTEND_BACKEND must explicitly equal express.");
    try {
      const url = new URL(environment.CRM_EXPRESS_ORIGIN);
      if (url.protocol !== "http:" || url.origin !== environment.CRM_EXPRESS_ORIGIN
        || !["127.0.0.1", "[::1]"].includes(url.hostname) || port(url.port, "CRM_EXPRESS_ORIGIN port") === profile.port) throw new Error();
      profile.apiOrigin = url.origin;
    } catch { fail("CRM_EXPRESS_ORIGIN must be an explicit loopback HTTP origin on a different port from the web listener."); }
  } else {
    if (environment.CRM_API_ENVIRONMENT !== "production") fail("CRM_API_ENVIRONMENT must explicitly equal production.");
    profile.host = host(environment.CRM_API_HOST, "CRM_API_HOST");
    profile.port = port(environment.CRM_API_PORT, "CRM_API_PORT");
  }
  const keys = new Set([...commonKeys, ...(kind === "web" ? webKeys : [...apiKeys, ...nativeEnvironmentKeys, ...zohoCredentialKeys, ...zohoRuntimeKeys, ...zohoSyncKeys])]);
  profile.environment = Object.fromEntries(Object.entries(environment).filter(([key, value]) => value !== undefined
    && (keys.has(key) || operatingSystemKeys.has(key.toUpperCase()))));
  if (kind === "web") {
    // Next reads root .env itself. Explicit empty values prevent its dotenv
    // loader from reintroducing backend settings or expanding password data.
    // This is process-environment isolation, not a filesystem access boundary.
    for (const key of [...nativeEnvironmentKeys, ...zohoCredentialKeys, ...zohoRuntimeKeys, ...zohoSyncKeys]) profile.environment[key] = "";
    profile.environment.ZOHO_ENABLED = "false";
    profile.environment.ZOHO_SYNC_ENABLED = "false";
    profile.environment.ZOHO_NETWORK_DISABLED = "1";
  }
  return Object.freeze(profile);
}

/** One root .env is allowed; Next override files and nested environments are not. */
export function assertNoEnvironmentFiles(root) {
  assertSingleEnvironmentFileLayout(root);
}

export function validateApplication(environment) {
  const web = validateProfile("web", environment), api = validateProfile("api", environment);
  const expectedOrigin = `http://${api.host === "::1" ? "[::1]" : api.host}:${api.port}`;
  if (web.apiOrigin !== expectedOrigin) fail("CRM_EXPRESS_ORIGIN must match this application's CRM_API_HOST and CRM_API_PORT.");
  return Object.freeze({ web, api });
}
export function assertBuildOutput(root, kind) {
  const required = ["shared/contracts/dist/index.js", kind === "api" ? "server/dist/server.js" : ".next/BUILD_ID"];
  for (const relative of required) {
    const path = join(root, relative);
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
      fail(`Missing required build output: ${relative}. Build this release with the Hub web environment first.`);
    }
  }
}
export async function assertPortFree(bindHost, bindPort) {
  await new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new Error(`Hub listener ${bindHost}:${bindPort} is unavailable. Check the port and bind address; no existing process was stopped.`)));
    probe.listen({ host: bindHost, port: bindPort, exclusive: true }, () => probe.close(error => error ? reject(new Error("Hub port probe failed.")) : resolvePromise()));
  });
}

async function readApiHealth(profile, path, timeoutMs, fetcher) {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), timeoutMs);
  let reader;
  try {
    const response = await fetcher(`${profile.apiOrigin}${path}`, {
      method: "GET", credentials: "omit", cache: "no-store", redirect: "error", signal: abort.signal,
      headers: { accept: "application/json" },
    });
    if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
      || response.headers.has("set-cookie") || !response.body) throw new Error();
    reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 4_096) throw new Error();
      chunks.push(Buffer.from(part.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { clearTimeout(timeout); abort.abort(); if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); } }
}

export async function assertApiIdentity(profile, fetcher = fetch) {
  try {
    const identity = await readApiHealth(profile, "/api/v1/health/identity", 2_000, fetcher);
    if (identity?.service !== "hub-crm-api" || identity?.instanceId !== profile.instanceId || identity?.appOrigin !== profile.appOrigin
      || Object.keys(identity).length !== 3) throw new Error();
  } catch { fail("Hub API identity check failed. Verify the dedicated API service, origin and CRM_API_INSTANCE_ID before starting the web service."); }
}

export async function assertApiReadiness(profile, fetcher = fetch) {
  try {
    // The API's own dependency deadline is five seconds; allow transport time.
    const readiness = await readApiHealth(profile, "/api/v1/health/ready", 7_000, fetcher);
    if (readiness?.status !== "ready" || Object.keys(readiness).length !== 1) throw new Error();
  } catch { fail("Hub API database readiness check failed. Native web startup requires a ready API; no web listener was started."); }
}

async function runNode(root, environment, args, gracefulStop = false, dependencySignal) {
  await new Promise((resolvePromise, reject) => {
    if (dependencySignal?.aborted) { reject(new Error("Hub API stopped before the web process could start.")); return; }
    const child = spawn(process.execPath, args, { cwd: root, env: environment, stdio: "inherit", windowsHide: true });
    let stopping = false;
    let dependencyFailed = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (process.platform === "win32" && child.pid) {
        // This PID belongs to this invocation; never discover or stop other listeners.
        const stopTree = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        stopTree.once("error", () => child.kill("SIGTERM"));
      } else child.kill("SIGTERM");
    };
    const dependencyFailure = () => { dependencyFailed = true; stop(); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    dependencySignal?.addEventListener("abort", dependencyFailure, { once: true });
    const cleanup = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); dependencySignal?.removeEventListener("abort", dependencyFailure); };
    child.once("error", () => { cleanup(); reject(new Error("Hub child process could not start.")); });
    child.once("exit", code => {
      cleanup();
      if (dependencyFailed) reject(new Error("Hub API stopped unexpectedly; the owned web process was stopped too."));
      else if (stopping && !gracefulStop) reject(new Error("Hub build was interrupted; later build stages were not run. Rebuild this release before startup."));
      else if (code === 0 || (stopping && gracefulStop)) resolvePromise();
      else reject(new Error(`Hub child process failed (exit ${code ?? "signal"}); check configuration and listener availability.`));
    });
  });
}

const importModule = url => import(url);
function apiModule(root, development, name) {
  return pathToFileURL(join(root, "server", development ? "src" : "dist", `${name}.${development ? "ts" : "js"}`)).href;
}

/** Pure native validation: no composition, driver, listener or profile is loaded. */
export async function loadNativeConfiguration(root, profile, development = false, importer = importModule) {
  if (profile.kind !== "api") fail("Native configuration requires the API profile.");
  if (profile.databaseMode === "disabled") return undefined;
  try {
    if (process.execArgv.some(argument => /^--inspect(?:-brk|-wait)?(?:=|$)/.test(argument))) throw new Error();
    // Revalidate before deliberately removing the Hub selector. The native
    // validator must still refuse every unsupported schema/profile selection.
    const checked = validateProfile("api", profile.environment);
    if (checked.databaseMode !== "mysql-native") throw new Error();
    const environment = { ...checked.environment };
    delete environment.CRM_DATABASE_MODE;
    const { loadRuntimeConfiguration } = await importer(apiModule(root, development, "runtime/configuration"));
    return loadRuntimeConfiguration(join(root, "server"), environment, () => { throw new Error("Private profile fallback is unavailable."); });
  } catch {
    fail("Native MySQL configuration failed. Check the explicit production runtime fields, target UUID and issuer; no connection or fallback was attempted.");
  }
}

/** Offline integration validation does not open a provider session. */
export async function loadZohoConfiguration(root, profile, development = false, importer = importModule) {
  if (profile.kind !== "api") fail("Integration configuration requires the API profile.");
  if (!profile.zohoEnabled) return undefined;
  try {
    const checked = validateProfile("api", profile.environment);
    if (!checked.zohoEnabled || checked.databaseMode !== "mysql-native") throw new Error();
    const { loadRuntimeZohoConfiguration } = await importer(apiModule(root, development, "runtime/zoho-configuration"));
    return loadRuntimeZohoConfiguration(checked.environment);
  } catch { fail("Zoho configuration failed. Check the explicit backend integration profile and bindings; no connection or fallback was attempted."); }
}

export async function loadZohoSyncConfiguration(root, profile, development = false, importer = importModule) {
  if (!profile.zohoSyncEnabled) return undefined;
  try {
    const checked = validateProfile("api", profile.environment);
    if (!checked.zohoSyncEnabled || checked.databaseMode !== "mysql-native") throw new Error();
    const { loadRuntimeZohoSyncConfiguration } = await importer(apiModule(root, development, "runtime/zoho-configuration"));
    return loadRuntimeZohoSyncConfiguration(checked.environment);
  } catch { fail("Zoho inbound configuration failed. Check the pinned organization, existing administrator and polling interval; no connection or import was attempted."); }
}

/** Own one native runtime; readiness is checked before any HTTP listener. */
export async function prepareApiRuntime(root, profile, development = false, importer = importModule) {
  const configuration = await loadNativeConfiguration(root, profile, development, importer);
  if (!configuration) return undefined;
  const integrationConfiguration = await loadZohoConfiguration(root, profile, development, importer);
  const inboundConfiguration = await loadZohoSyncConfiguration(root, profile, development, importer);
  let runtime;
  let closing;
  const close = () => closing ??= Promise.resolve().then(() => runtime.close()).catch(() => {
    fail("Native CRM shutdown failed; no automatic recovery was attempted.");
  });
  try {
    // Keep an explicit inherited network veto authoritative. The root loader
    // validates its own flag but never changes the parent process environment.
    if (process.env.CRM_MYSQL_NETWORK_DISABLED === "1") throw new Error();
    if ((integrationConfiguration || inboundConfiguration) && (process.env.ZOHO_NETWORK_DISABLED === "1" || profile.environment.ZOHO_NETWORK_DISABLED === "1")) throw new Error();
    const { openCrmRuntime } = await importer(apiModule(root, development, "runtime/composition"));
    runtime = await openCrmRuntime(configuration, integrationConfiguration, { networkEnabled: Boolean(integrationConfiguration || inboundConfiguration) }, inboundConfiguration);
    if (!await runtime.readiness()) throw new Error();
    return { auth: runtime.auth, crmServices: runtime.crmServices, readiness: runtime.readiness, startBackground: runtime.startBackground, close };
  } catch {
    if (runtime) await close();
    fail("Native MySQL or selected Zoho readiness failed. Verify the native schema and selected integration; no listener, migration or fallback was started.");
  }
}

export async function startApi(root, profile, development = false, importer = importModule) {
  const runtime = await prepareApiRuntime(root, profile, development, importer);
  let instance;
  try {
    const { startServer } = await importer(apiModule(root, development, "server"));
    instance = await startServer({ environment: "production", host: profile.host, port: profile.port,
      appOrigin: profile.appOrigin, instanceId: profile.instanceId },
    runtime ? { auth: runtime.auth, crmServices: runtime.crmServices, readiness: runtime.readiness } : {}, runtime?.close);
    runtime?.startBackground?.();
    return instance;
  } catch {
    if (instance) await instance.stop();
    else await runtime?.close();
    fail("Hub API startup failed; the owned database runtime was closed and no fallback was started.");
  }
}

function databaseStatus(profile) {
  return profile.databaseMode === "mysql-native" ? `native MySQL${profile.zohoEnabled ? " and selected Zoho" : ""}${profile.zohoSyncEnabled ? "; inbound configuration/principal verified (freshness is separate)" : ""} readiness passed` : "database disabled";
}

async function startApplication(root, application, development = false) {
  const { api: profile, web } = application;
  const api = await startApi(root, profile, development);
  const dependency = new AbortController();
  const apiClosed = () => dependency.abort();
  api.server.once("close", apiClosed);
  try {
    await assertApiIdentity(web);
    process.stdout.write(`Hub ${development ? "development" : "application"}: web ${web.host}:${web.port}, API ${profile.host}:${profile.port}; ${databaseStatus(profile)}.\n`);
    if (development) process.stdout.write("Next supports hot reload. Restart npm run dev after API or shared-contract source changes.\n");
    const webEnvironment = development ? { ...web.environment, NODE_ENV: "development" } : web.environment;
    await runNode(root, webEnvironment, ["node_modules/next/dist/bin/next", development ? "dev" : "start", "--hostname", web.host, "--port", String(web.port)], true, dependency.signal);
  } finally {
    api.server.off("close", apiClosed);
    await api.stop();
  }
}

export async function main(command, environment = process.env, root = projectRoot) {
  if (!/^(?:dev|build|start|check|web|api|check-web|check-api)$/.test(command ?? "")) fail("Usage: npm run dev, or node tools/run-hub.mjs build|start|check|web|api|check-web|check-api");
  if (Number(process.versions.node.split(".")[0]) !== 24) fail("Hub requires its own Node.js 24 runtime; do not change another application's Node version.");
  environment = loadHubEnvironment(root, environment);
  if (command === "dev") {
    const application = validateApplication(environment);
    for (const profile of [application.api, application.web]) await assertPortFree(profile.host, profile.port);
    const source = join(root, "server/src/server.ts");
    if (!existsSync(source) || !lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) {
      fail("Missing Hub API development source: server/src/server.ts.");
    }
    await runNode(root, application.web.environment, ["node_modules/typescript/bin/tsc", "-p", "shared/contracts/tsconfig.json"]);
    await startApplication(root, application, true);
    return;
  }
  if (command === "start" || command === "check") {
    const application = validateApplication(environment);
    for (const profile of [application.api, application.web]) {
      assertBuildOutput(root, profile.kind);
      await assertPortFree(profile.host, profile.port);
    }
    if (command === "check") {
      const runtime = await prepareApiRuntime(root, application.api);
      await runtime?.close();
      process.stdout.write(`Hub application configuration, both build outputs and both ports passed; ${databaseStatus(application.api)}.\n`);
      return;
    }
    await startApplication(root, application);
    return;
  }
  const kind = command.endsWith("api") ? "api" : "web";
  const profile = validateProfile(kind, environment);
  if (command === "build") {
    const application = validateApplication(environment);
    for (const args of [["node_modules/typescript/bin/tsc", "-p", "shared/contracts/tsconfig.json"],
      ["node_modules/typescript/bin/tsc", "-p", "tsconfig.server.build.json"], ["node_modules/next/dist/bin/next", "build"]]) {
      if (args[0] === "node_modules/next/dist/bin/next") {
        await loadNativeConfiguration(root, application.api);
        await loadZohoConfiguration(root, application.api);
        await loadZohoSyncConfiguration(root, application.api);
      }
      await runNode(root, profile.environment, args);
    }
    return;
  }
  assertBuildOutput(root, kind);
  await assertPortFree(profile.host, profile.port);
  if (command.startsWith("check-")) {
    if (kind === "api") {
      const runtime = await prepareApiRuntime(root, profile);
      await runtime?.close();
    } else if (profile.databaseMode === "mysql-native") {
      await assertApiIdentity(profile);
      await assertApiReadiness(profile);
    }
    process.stdout.write(`Hub ${kind} configuration, build output and listener availability passed; ${kind === "web" && profile.databaseMode === "mysql-native" ? "API identity and database readiness passed" : databaseStatus(profile)}.\n`);
    return;
  }
  if (kind === "web") {
    await assertApiIdentity(profile);
    if (profile.databaseMode === "mysql-native") await assertApiReadiness(profile);
    await runNode(root, profile.environment, ["node_modules/next/dist/bin/next", "start", "--hostname", profile.host, "--port", String(profile.port)], true);
    return;
  }
  const api = await startApi(root, profile);
  process.stdout.write(`Hub API listening on ${profile.host}:${profile.port}; ${databaseStatus(profile)}.\n`);
  const stop = () => { void api.stop().catch(() => { process.exitCode = 1; }); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  api.server.once("close", () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); if (api.failed) process.exitCode = 1; });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.length === 3 ? process.argv[2] : undefined).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : "Hub startup failed."}\n`);
    process.exitCode = 1;
  });
}
