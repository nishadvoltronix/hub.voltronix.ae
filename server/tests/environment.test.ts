import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { EnvironmentFileError, isMysqlRuntimeSelected, loadBackendEnvironment, parseBackendEnvironment } from "../src/environment.js";

const settings = "CRM_API_ENVIRONMENT=test\nCRM_API_HOST=127.0.0.1\nCRM_API_PORT=3002\nAPP_ORIGIN=http://127.0.0.1:3001\n";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "crm-backend-environment-"));
  return { root, file: pathToFileURL(join(root, ".env")), remove: () => rmSync(root, { recursive: true, force: true }) };
}
function redacted(error: unknown): boolean {
  assert.ok(error instanceof EnvironmentFileError);
  assert.equal(error.message, "Invalid backend environment file; no server or database connection was started.");
  assert.equal(error.stack?.includes("synthetic-secret-marker"), false);
  return true;
}

test("native dotenv parsing supports comments, CRLF, BOM and quotes without interpolation", () => {
  const result = parseBackendEnvironment(`\uFEFF# local settings\r\n${settings.replaceAll("\n", "\r\n")}export CRM_MYSQL_NETWORK_DISABLED = '1' # guarded\r\nCRM_RUNTIME_PROFILE="\${UNEXPANDED}"\r\n`);
  assert.equal(result.CRM_RUNTIME_PROFILE, "${UNEXPANDED}");
  assert.equal(result.CRM_MYSQL_NETWORK_DISABLED, "1");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(loadConfig(result).port, 3002);
});

test("blank optional selectors do not implicitly enable MySQL; explicit selectors still require validation", () => {
  assert.deepEqual(parseBackendEnvironment("CRM_RUNTIME_ENABLE=\nCRM_RUNTIME_PROFILE='   '\nCRM_MYSQL_NETWORK_DISABLED=\n"), {});
  assert.equal(isMysqlRuntimeSelected({ CRM_RUNTIME_ENABLE: "", CRM_RUNTIME_PROFILE: " " }), false);
  assert.equal(isMysqlRuntimeSelected({ CRM_RUNTIME_PROFILE: ".local-data/operators/mysql-crm-runtime.json" }), true);
  assert.equal(isMysqlRuntimeSelected({ CRM_RUNTIME_ENABLE: "incorrect-nonempty-value" }), true);
});

test("Hub disabled database mode parses explicitly and never selects the native runtime", () => {
  const values = parseBackendEnvironment(settings + "CRM_DATABASE_MODE=disabled\nCRM_API_INSTANCE_ID=hub-crm\nCRM_MYSQL_NETWORK_DISABLED=1\n");
  assert.equal(values.CRM_DATABASE_MODE, "disabled"); assert.equal(values.CRM_API_INSTANCE_ID, "hub-crm");
  assert.equal(loadConfig(values).instanceId, "hub-crm"); assert.equal(isMysqlRuntimeSelected(values), false);
  assert.equal(isMysqlRuntimeSelected({ CRM_DATABASE_MODE: "disabled", CRM_RUNTIME_ENABLE: "", CRM_RUNTIME_PROFILE: " " }), false);
  for (const mode of ["legacy", "mysql", "", " ", "DISABLED"]) {
    assert.throws(() => isMysqlRuntimeSelected({ CRM_DATABASE_MODE: mode }), redacted);
    assert.throws(() => parseBackendEnvironment(`CRM_DATABASE_MODE='${mode}'\n`), redacted);
  }
  for (const id of ["", "HUB", "with space", "x".repeat(65)]) {
    assert.throws(() => parseBackendEnvironment(`CRM_API_INSTANCE_ID='${id}'\n`), redacted);
  }
});

test("Hub disabled mode refuses native credentials and selectors instead of silently ignoring them", () => {
  for (const key of ["CRM_RUNTIME_ENABLE", "CRM_RUNTIME_PROFILE", "CRM_RUNTIME_SOURCE", "CRM_MYSQL_HOST", "CRM_MYSQL_PORT",
    "CRM_MYSQL_DATABASE", "CRM_MYSQL_USER", "CRM_MYSQL_PASSWORD", "CRM_MYSQL_SERVER_UUID", "CRM_MYSQL_APPROVED"]) {
    const values = { CRM_DATABASE_MODE: "disabled", [key]: "synthetic-secret-marker" };
    assert.throws(() => isMysqlRuntimeSelected(values), redacted);
    assert.throws(() => parseBackendEnvironment(`CRM_DATABASE_MODE=disabled\n${key}=synthetic-secret-marker\n`), redacted);
  }
  for (const key of ["CRM_RUNTIME_UNKNOWN", "CRM_MYSQL_UNKNOWN"]) {
    assert.throws(() => isMysqlRuntimeSelected({ CRM_DATABASE_MODE: "disabled", [key]: "synthetic-secret-marker" }), redacted);
  }
  assert.throws(() => isMysqlRuntimeSelected({ CRM_DATABASE_MODE: "disabled", CRM_MYSQL_NETWORK_DISABLED: "0" }), redacted);
});

for (const [label, content] of [
  ["duplicate", `${settings}CRM_API_PORT=3003`],
  ["unknown", "MYSQL_PASSWORD=synthetic-secret-marker"],
  ["process injection", "NODE_OPTIONS=synthetic-secret-marker"],
  ["prototype key", "__proto__=synthetic-secret-marker"],
  ["missing assignment", "synthetic-secret-marker"],
  ["unterminated quote", 'APP_ORIGIN="synthetic-secret-marker'],
  ["multiline value", 'APP_ORIGIN="synthetic-secret-marker\ncontinuation"'],
  ["quoted trailing garbage", 'APP_ORIGIN="synthetic-secret-marker" continuation'],
  ["null byte", "APP_ORIGIN=synthetic-secret-marker\0"],
  ["oversized bytes", `#${"é".repeat(8192)}`],
  ["unsupported network switch", "CRM_MYSQL_NETWORK_DISABLED=0"],
] as const) {
  test(`environment ${label} fails closed without revealing contents`, () => {
    assert.throws(() => parseBackendEnvironment(content), redacted);
  });
}

test("missing environment file leaves explicit configuration unchanged", () => {
  const files = fixture();
  try {
    const environment = { CRM_API_ENVIRONMENT: "test", SYNTHETIC: "unchanged" };
    loadBackendEnvironment(environment, files.file);
    assert.deepEqual(environment, { CRM_API_ENVIRONMENT: "test", SYNTHETIC: "unchanged" });
  } finally { files.remove(); }
});

test("file fills only missing process settings, including the MySQL network guard", () => {
  const files = fixture();
  try {
    writeFileSync(files.file, `${settings}CRM_MYSQL_NETWORK_DISABLED=1\nCRM_RUNTIME_ENABLE=\nCRM_RUNTIME_PROFILE=\n`);
    const environment: Record<string, string | undefined> = { CRM_API_PORT: "3004", SYNTHETIC: "unchanged" };
    loadBackendEnvironment(environment, files.file);
    assert.equal(loadConfig(environment).port, 3004);
    assert.equal(environment.CRM_MYSQL_NETWORK_DISABLED, "1");
    assert.equal(environment.SYNTHETIC, "unchanged");
    assert.equal(isMysqlRuntimeSelected(environment), false);
    assert.equal(environment.CRM_RUNTIME_ENABLE, undefined);
  } finally { files.remove(); }
});

test("explicit empty process values cannot be silently replaced by file defaults", () => {
  const files = fixture();
  try {
    writeFileSync(files.file, settings);
    const environment = { CRM_API_PORT: "" };
    loadBackendEnvironment(environment, files.file);
    assert.equal(environment.CRM_API_PORT, "");
    assert.throws(() => loadConfig(environment));
  } finally { files.remove(); }
});

test("invalid input never partially mutates process settings", () => {
  const files = fixture();
  try {
    writeFileSync(files.file, `${settings}MYSQL_PASSWORD=synthetic-secret-marker`);
    const environment = { CRM_API_PORT: "3004" };
    assert.throws(() => loadBackendEnvironment(environment, files.file), redacted);
    assert.deepEqual(environment, { CRM_API_PORT: "3004" });
  } finally { files.remove(); }
});

test("non-file, hard-linked, oversized and invalid UTF-8 files are refused", () => {
  const files = fixture();
  try {
    assert.throws(() => loadBackendEnvironment({}, pathToFileURL(files.root)), redacted);
    writeFileSync(files.file, Buffer.from([0xc3, 0x28]));
    assert.throws(() => loadBackendEnvironment({}, files.file), redacted);
    writeFileSync(files.file, "#".repeat(16_385));
    assert.throws(() => loadBackendEnvironment({}, files.file), redacted);
    writeFileSync(files.file, settings);
    linkSync(files.file, join(files.root, "linked.env"));
    assert.throws(() => loadBackendEnvironment({}, files.file), redacted);
  } finally { files.remove(); }
});

test("import has no side effects and source/built paths read server-owned env, never root env, independent of cwd", () => {
  const files = fixture();
  try {
    // Preserve the relocated loader's import.meta.url while resolving its real
    // security/config dependencies, not mocks, from the source package.
    const source = readFileSync(new URL("../src/environment.ts", import.meta.url), "utf8")
      .replace("./runtime/environment-settings.js", new URL("../src/runtime/environment-settings.ts", import.meta.url).href)
      .replace("./runtime/private-profile.js", new URL("../src/runtime/private-profile.ts", import.meta.url).href);
    const backend = join(files.root, "server");
    mkdirSync(join(backend, "src"), { recursive: true });
    mkdirSync(join(backend, "dist"));
    writeFileSync(join(backend, ".env"), settings);
    writeFileSync(join(files.root, ".env"), "CRM_API_PORT=5999\n");
    // Node 24 strips types in these isolated source and built-layout fixtures.
    for (const directory of ["src", "dist"]) {
      const module = join(backend, directory, "environment.ts");
      writeFileSync(module, source);
      for (const cwd of [files.root, backend, dirname(fileURLToPath(import.meta.url))]) {
        const script = `const before = JSON.stringify(process.env); const module = await import(${JSON.stringify(pathToFileURL(module).href)}); if (JSON.stringify(process.env) !== before) throw new Error("import side effect"); const values = {}; module.loadBackendEnvironment(values); process.stdout.write(JSON.stringify(values));`;
        const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], {
          cwd, encoding: "utf8", timeout: 10_000, windowsHide: true,
          env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:NODE_OPTIONS|NODE_DEBUG|NODE_DEBUG_NATIVE)$/i.test(key))),
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
        assert.deepEqual(JSON.parse(result.stdout), parseBackendEnvironment(settings));
      }
    }
  } finally { files.remove(); }
});
