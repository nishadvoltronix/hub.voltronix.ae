import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import test from "node:test";
import { frontendBackend } from "../src/server/config/frontend-backend";

const template = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
const loader = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
const configuration = new URL("../scripts/frontend-configuration.ts", import.meta.url).href;
const refusal = { status: "REFUSED", code: "FRONTEND_CONFIGURATION", databaseConnections: 0, databaseWrites: 0,
  hint: "Use CRM_FRONTEND_BACKEND=express and CRM_EXPRESS_ORIGIN=http://127.0.0.1:<port 1024-65535> or http://[::1]:<port 1024-65535>. APP_ORIGIN must be a distinct HTTP 127.0.0.1 origin with an explicit port or a canonical HTTPS DNS origin on port 443. HTTPS also requires CRM_API_INSTANCE_ID matching the API configuration. Production never falls back to direct Next database access. Check readable frontend-owned dotenv files." };
const contents = Object.entries(template).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
function environment(values: Record<string, string | undefined>) {
  const result: NodeJS.ProcessEnv = { NODE_ENV: "test", CRM_MYSQL_NETWORK_DISABLED: "1", NEXT_TELEMETRY_DISABLED: "1" };
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "USERPROFILE", "LOCALAPPDATA"]) {
    if (process.env[name] !== undefined) result[name] = process.env[name];
  }
  return { ...result, ...values };
}
function check(values: Record<string, string | undefined>) {
  // A real project .env may now exist. Test configuration against an isolated
  // empty root so the operator's root file never supplies missing test values.
  return fixture({}, values);
}
function fixture(files: Record<string, string>, values: Record<string, string | undefined> = {}, refuseRead = false) {
  const directory = mkdtempSync(join(tmpdir(), "crm-frontend-environment-"));
  const root = join(directory, "frontend"), unrelated = join(directory, "unrelated");
  mkdirSync(root); mkdirSync(unrelated);
  try {
    for (const [name, value] of Object.entries(files)) writeFileSync(join(root, name), value);
    // Neither the workspace parent nor the caller's cwd is an environment source.
    writeFileSync(join(directory, ".env"), "CRM_FRONTEND_BACKEND=parent-secret-marker\n");
    writeFileSync(join(unrelated, ".env"), "CRM_FRONTEND_BACKEND=cwd-secret-marker\n");
    // Simulate EACCES only inside this child; never alter real filesystem permissions.
    const readFailure = refuseRead ? `import fs from 'node:fs';const read=fs.readFileSync;fs.readFileSync=function(path,...args){if(path===${JSON.stringify(join(root, ".env"))})throw Object.assign(new Error('read-secret-marker'),{code:'EACCES'});return read.call(this,path,...args);};` : "";
    const code = `import { runFrontendConfigurationCheck } from ${JSON.stringify(configuration)};${readFailure}runFrontendConfigurationCheck([], ${JSON.stringify(root)});`;
    return spawnSync(process.execPath, ["--import", loader, "--input-type=module", "--eval", code], {
      cwd: unrelated, env: environment(values), encoding: "utf8", windowsHide: true, timeout: 20_000,
    });
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    assert.match(directory.slice(resolve(tmpdir()).length + 1), /^crm-frontend-environment-[A-Za-z0-9]+$/);
    rmSync(directory, { recursive: true, force: true });
  }
}
function assertPass(result: ReturnType<typeof check>) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { status: "PASS_CONFIGURATION_ONLY", mode: "express", databaseConnections: 0, databaseWrites: 0,
    limitation: "Upstream health, authorization, target schema and production acceptance are separate checks." });
}
function assertRefused(result: ReturnType<typeof check>) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes("secret-marker"), false);
  assert.deepEqual(JSON.parse(result.stderr), refusal);
}

test("single root environment template supplies the Hub bridge and both isolated listeners without credentials", () => {
  assert.deepEqual(Object.keys(template).sort(), ["APP_ORIGIN", "CRM_API_ENVIRONMENT", "CRM_API_HOST", "CRM_API_INSTANCE_ID",
    "CRM_API_PORT", "CRM_DATABASE_MODE", "CRM_EXPRESS_ORIGIN", "CRM_FRONTEND_BACKEND", "CRM_MYSQL_NETWORK_DISABLED",
    "CRM_WEB_HOST", "CRM_WEB_PORT", "NEXT_TELEMETRY_DISABLED", "NODE_ENV", "ZOHO_ENABLED"]);
  assert.deepEqual(frontendBackend(template), { mode: "express", origin: "http://127.0.0.1:3302", appOrigin: "https://hub.voltronix.ae", instanceId: "hub-crm" });
  assert.equal(template.CRM_DATABASE_MODE, "disabled");
  assert.equal(template.CRM_MYSQL_NETWORK_DISABLED, "1");
  assert.equal(template.ZOHO_ENABLED, "false");
});

test("frontend configuration checker works outside its package without reading a MySQL profile in Express mode", () => {
  assertPass(check(template));
});

test("production HTTPS configuration checks without database secrets, profiles or network calls", () => {
  assertPass(check({ ...template, NODE_ENV: "production", APP_ORIGIN: "https://crm.example.invalid", CRM_API_INSTANCE_ID: "hub-crm" }));
  assertRefused(check({ ...template, NODE_ENV: "production", APP_ORIGIN: "https://crm.example.invalid", CRM_API_INSTANCE_ID: undefined }));
  for (const mode of [undefined, "nextjs"]) {
    assertRefused(check({ NODE_ENV: "production", CRM_FRONTEND_BACKEND: mode, APP_ORIGIN: "https://crm.example.invalid" }));
  }
});

test("missing or unsafe frontend configuration fails closed without leaking values or connecting", () => {
  for (const values of [{}, { ...template, CRM_EXPRESS_ORIGIN: "https://secret-marker.invalid" },
    { ...template, APP_ORIGIN: template.CRM_EXPRESS_ORIGIN }, { ...template, CRM_FRONTEND_BACKEND: "invalid-secret-marker" }]) {
    assertRefused(check(values));
  }
});

test("frontend-owned dotenv works from an unrelated cwd without selecting parent or legacy configuration", () => {
  assertPass(fixture({ ".env": contents, ".env.mysql.local": "unsafe-profile-secret-marker" }));
  assertRefused(fixture({}));
});

test("explicit process values take precedence over dotenv and invalid process overrides still refuse", () => {
  assertPass(fixture({ ".env": contents.replace("CRM_FRONTEND_BACKEND=express", "CRM_FRONTEND_BACKEND=file-secret-marker") }, template));
  assertRefused(fixture({ ".env": contents }, { CRM_EXPRESS_ORIGIN: "https://process-secret-marker.invalid" }));
  assertRefused(fixture({ ".env": contents }, { APP_ORIGIN: "" }));
});

test("frontend checker follows development, production and test Next dotenv precedence", () => {
  const fallback = "CRM_FRONTEND_BACKEND=fallback-secret-marker\n";
  for (const mode of ["development", "production", "test"]) {
    assertPass(fixture({ ".env": fallback, [`.env.${mode}`]: fallback, [`.env.${mode}.local`]: contents,
      ".env.local": "CRM_FRONTEND_BACKEND=local-secret-marker\n" }, { NODE_ENV: mode }));
  }
  assertPass(fixture({ ".env": contents, ".env.local": fallback }, { NODE_ENV: "test" }));
  assertPass(fixture({ ".env": fallback, ".env.development.local": contents }, { NODE_ENV: undefined }));
});

test("malformed required settings and Next dotenv expansion failures refuse without leaking file values", () => {
  for (const value of [contents.replace(`APP_ORIGIN=${template.APP_ORIGIN}`, "APP_ORIGIN"),
    contents.replace(`APP_ORIGIN=${template.APP_ORIGIN}`, "APP_ORIGIN='malformed-secret-marker"),
    contents + "CRM_EXPANSION_PROBE=$CRM_EXPANSION_PROBE\n"]) {
    assertRefused(fixture({ ".env": value }));
  }
});

test("Next dotenv read errors refuse despite valid process settings and do not disclose the raw error", () => {
  assertRefused(fixture({ ".env": contents }, template, true));
});
