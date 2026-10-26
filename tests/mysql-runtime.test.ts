import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { approvedMysqlBrowserFixture, assertRuntimeMysqlTarget, browserMysqlAcknowledgement,
  browserMysqlFixtureRelativeRoot, readDevelopmentMigrationMysqlConfig, readDevelopmentRuntimeMysqlConfig,
  readRuntimeMysqlConfig } from "../src/server/config/mysql-runtime";
import type { LocalMysqlConfig } from "../src/server/config/mysql";
import { connectMysql, mysqlParameterValues } from "../src/server/db/mysql/driver";

const local: LocalMysqlConfig = { provider: "mysql", environment: "development", host: "127.0.0.1", port: 3308,
  database: "crm_local_dev", user: "synthetic_local", password: "unused-synthetic-runtime-fixture" };
const profile = ["DATABASE_PROVIDER=mysql", "MYSQL_ENVIRONMENT=development", "MYSQL_HOST=127.0.0.1",
  "MYSQL_PORT=3308", "MYSQL_DATABASE=crm_local_dev", "MYSQL_USER=synthetic_local", "MYSQL_PASSWORD=unused-synthetic-runtime-fixture"].join("\n");

function filesystem() {
  const parent = realpathSync(tmpdir()), root = realpathSync(mkdtempSync(join(parent, "crm-mysql-runtime-test-")));
  return { root, cleanup() {
    const target = resolve(root);
    assert.equal(dirname(target), parent);
    assert.ok(basename(target).startsWith("crm-mysql-runtime-test-"));
    assert.equal(realpathSync(target), target);
    rmSync(target, { recursive: true });
  } };
}

test("offline MySQL runtime accepts only the explicitly approved local development target", () => {
  assert.equal(assertRuntimeMysqlTarget(local), local);
  for (const changed of [{ provider: "sqlite" }, { environment: "test" }, { host: "::1" },
    { host: "production.invalid" }, { port: 3306 }, { database: "crm" }]) {
    assert.throws(() => assertRuntimeMysqlTarget({ ...local, ...changed } as LocalMysqlConfig), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes("no fallback"));
      assert.equal(error.message.includes("synthetic-runtime-fixture"), false);
      return true;
    });
  }
});

test("offline MySQL runtime missing or mismatched profile never uses the preserved SQLite environment", () => {
  const f = filesystem();
  try {
    const sqliteEnvironment = "DATABASE_PROVIDER=sqlite\nDATABASE_ENVIRONMENT=development\nSQLITE_DATABASE_PATH=.local-data/development/preserved.sqlite\n";
    const environmentPath = join(f.root, ".env.local");
    writeFileSync(environmentPath, sqliteEnvironment);
    assert.throws(() => readRuntimeMysqlConfig(f.root, {}));
    writeFileSync(join(f.root, ".env.mysql.local"), profile.replace("MYSQL_DATABASE=crm_local_dev", "MYSQL_DATABASE=wrong_local_database"));
    assert.throws(() => readRuntimeMysqlConfig(f.root, {}));
    writeFileSync(join(f.root, ".env.mysql.local"), profile);
    assert.equal(readRuntimeMysqlConfig(f.root, {}).database, "crm_local_dev");
    assert.equal(readFileSync(environmentPath, "utf8"), sqliteEnvironment);
    assert.equal(existsSync(join(f.root, ".local-data")), false);
  } finally { f.cleanup(); }
});

test("offline runtime selection preserves the inspector until explicit opt-in and never falls back", () => {
  const f = filesystem();
  try {
    const inspector = profile.replace("crm_local_dev", "crm_nextjs_development");
    const preserved = join(f.root, ".env.mysql.local");
    writeFileSync(preserved, inspector);
    const selected = { CRM_MYSQL_RUNTIME_PROFILE: ".env.mysql.runtime.local" };
    assert.throws(() => readRuntimeMysqlConfig(f.root, selected));
    writeFileSync(join(f.root, ".env.mysql.runtime.local"), profile);
    assert.throws(() => readRuntimeMysqlConfig(f.root, {}));
    assert.equal(readRuntimeMysqlConfig(f.root, selected).database, "crm_local_dev");
    assert.equal(readDevelopmentRuntimeMysqlConfig(f.root, selected).database, "crm_local_dev");
    writeFileSync(join(f.root, ".env.mysql.runtime.local"), "MYSQL_PASSWORD=synthetic-redaction-marker\n");
    assert.throws(() => readRuntimeMysqlConfig(f.root, selected), (error: unknown) => {
      assert.ok(error instanceof Error); assert.equal(error.message.includes("synthetic-redaction-marker"), false); return true;
    });
    assert.equal(readFileSync(preserved, "utf8"), inspector);
  } finally { f.cleanup(); }
});

test("offline development runtime rejects migration credentials, arbitrary names and partial browser selectors", () => {
  const f = filesystem();
  try {
    writeFileSync(join(f.root, ".env.mysql.local"), profile);
    for (const environment of [
      { CRM_MYSQL_RUNTIME_PROFILE: ".env.mysql.migration.local" },
      { CRM_MYSQL_RUNTIME_PROFILE: "../.env.mysql.runtime.local" },
      { CRM_MYSQL_RUNTIME_PROFILE: "" },
      { CRM_MYSQL_RUNTIME_PROFILE: "isolated-browser-fixture" },
      { CRM_MYSQL_BROWSER_FIXTURE: "" },
      { CRM_MYSQL_BROWSER_ACK: "" },
      { CRM_MYSQL_RUNTIME_PROFILE: ".env.mysql.local", CRM_MYSQL_BROWSER_FIXTURE: "unapproved" },
    ]) {
      assert.throws(() => readRuntimeMysqlConfig(f.root, environment));
      assert.throws(() => readDevelopmentRuntimeMysqlConfig(f.root, environment));
    }
  } finally { f.cleanup(); }
});

test("offline development DDL requires its exact approval and separate migration profile", () => {
  const f = filesystem();
  const args = ["--approve-local-application-schema", "--profile", ".env.mysql.migration.local"];
  try {
    writeFileSync(join(f.root, ".env.mysql.local"), profile);
    writeFileSync(join(f.root, ".env.mysql.runtime.local"), profile);
    assert.throws(() => readDevelopmentMigrationMysqlConfig(args, f.root, {}));
    writeFileSync(join(f.root, ".env.mysql.migration.local"), profile.replace("synthetic_local", "synthetic_migrator"));
    assert.equal(readDevelopmentMigrationMysqlConfig(args, f.root, {}).user, "synthetic_migrator");
    for (const invalid of [[], args.slice(1), args.slice(0, 1), [...args, "extra"],
      [args[0]!, "--profile", ".env.mysql.runtime.local"], [args[0]!, "--profile", ".env.mysql.local"]]) {
      assert.throws(() => readDevelopmentMigrationMysqlConfig(invalid, f.root, {}));
    }
    assert.throws(() => readDevelopmentMigrationMysqlConfig(args, f.root, { CRM_MYSQL_RUNTIME_PROFILE: "isolated-browser-fixture" }));
    assert.throws(() => readDevelopmentMigrationMysqlConfig(args, f.root, { CRM_MYSQL_BROWSER_ACK: browserMysqlAcknowledgement }));
    writeFileSync(join(f.root, ".env.mysql.migration.local"), profile.replace("crm_local_dev", "crm_other"));
    assert.throws(() => readDevelopmentMigrationMysqlConfig(args, f.root, {}));
  } finally { f.cleanup(); }
});

const browserId = "01234567-89ab-4cde-8123-456789abcdef";
const browserRelative = `.local-data/test/mysql-browser-${browserId}`;
const browserEnvironment = { CRM_MYSQL_RUNTIME_PROFILE: "isolated-browser-fixture", CRM_MYSQL_BROWSER_FIXTURE: browserRelative,
  CRM_MYSQL_BROWSER_ACK: browserMysqlAcknowledgement, APP_ORIGIN: "http://127.0.0.1:41234" };
const browserProfile = profile.replace("MYSQL_ENVIRONMENT=development", "MYSQL_ENVIRONMENT=test")
  .replace("crm_local_dev", `crm_local_browser_${browserId.replaceAll("-", "")}`);

test("offline browser selection binds an exact owned fixture path, profile and loopback origin", () => {
  const f = filesystem();
  try {
    const fixtureRoot = join(f.root, ...browserRelative.split("/"));
    mkdirSync(fixtureRoot, { recursive: true });
    writeFileSync(join(f.root, ".env.mysql.local"), profile);
    writeFileSync(join(fixtureRoot, ".env.mysql.local"), browserProfile);
    assert.throws(() => approvedMysqlBrowserFixture(f.root, browserEnvironment));
    writeFileSync(join(fixtureRoot, ".env.mysql.runtime.local"), browserProfile);
    const approved = approvedMysqlBrowserFixture(f.root, browserEnvironment);
    assert.equal(approved.fixtureRoot, fixtureRoot);
    assert.equal(approved.fixtureId, browserId);
    assert.equal(approved.origin, browserEnvironment.APP_ORIGIN);
    assert.equal(approved.config.environment, "test");
    assert.deepEqual(readRuntimeMysqlConfig(f.root, browserEnvironment), approved.config);
    assert.throws(() => readDevelopmentRuntimeMysqlConfig(f.root, browserEnvironment));
    assert.equal(readFileSync(join(f.root, ".env.mysql.local"), "utf8"), profile);
  } finally { f.cleanup(); }
});

test("offline browser selection rejects unsafe origins, ambiguity and mismatched database targets before connecting", () => {
  const f = filesystem();
  try {
    const fixtureRoot = join(f.root, ...browserRelative.split("/"));
    mkdirSync(fixtureRoot, { recursive: true });
    const filename = join(fixtureRoot, ".env.mysql.runtime.local");
    writeFileSync(filename, browserProfile);
    for (const origin of [undefined, "", "http://localhost:41234", "https://127.0.0.1:41234", "http://127.0.0.1",
      "http://127.0.0.1:41234/", "http://127.0.0.1:41234?a=1", "http://127.0.0.1:41234#x", "http://user@127.0.0.1:41234",
      "http://127.0.0.1:0", "http://127.0.0.1:80", "http://127.0.0.1:65536", "http://127.0.0.1:041234", " http://127.0.0.1:41234"]) {
      assert.throws(() => approvedMysqlBrowserFixture(f.root, { ...browserEnvironment, APP_ORIGIN: origin }));
    }
    for (const key of ["CRM_MYSQL_RUNTIME_PROFILE", "CRM_MYSQL_BROWSER_FIXTURE", "CRM_MYSQL_BROWSER_ACK"]) {
      assert.throws(() => approvedMysqlBrowserFixture(f.root, { ...browserEnvironment, [key]: undefined }));
      assert.throws(() => approvedMysqlBrowserFixture(f.root, { ...browserEnvironment, [key]: "" }));
    }
    for (const content of [browserProfile.replace("MYSQL_ENVIRONMENT=test", "MYSQL_ENVIRONMENT=development"),
      browserProfile.replace("127.0.0.1", "::1"), browserProfile.replace("3308", "3306"),
      browserProfile.replace(browserId.replaceAll("-", ""), "1123456789ab4cde8123456789abcdef"), profile]) {
      writeFileSync(filename, content);
      assert.throws(() => approvedMysqlBrowserFixture(f.root, browserEnvironment), (error: unknown) => {
        assert.ok(error instanceof Error); assert.equal(error.message.includes("synthetic"), false); return true;
      });
    }
  } finally { f.cleanup(); }
});

test("offline browser fixture path rejects traversal, alternate UUIDs and profile hardlinks or directory links", () => {
  for (const invalid of [undefined, "", browserRelative + "/..", browserRelative.replace("/", "\\"),
    browserRelative.toUpperCase(), browserRelative.replace("4cde", "1cde"), browserRelative.replace("8123", "7123"),
    ".local-data/test/mysql-integration-" + browserId, "G:/" + browserRelative]) {
    assert.throws(() => browserMysqlFixtureRelativeRoot(invalid));
  }
  assert.equal(browserMysqlFixtureRelativeRoot(browserRelative), browserRelative);
  const f = filesystem();
  try {
    const directory = join(f.root, ...browserRelative.split("/"));
    mkdirSync(directory, { recursive: true });
    const filename = join(directory, ".env.mysql.runtime.local");
    writeFileSync(filename, browserProfile);
    linkSync(filename, join(directory, "duplicate-profile"));
    assert.throws(() => approvedMysqlBrowserFixture(f.root, browserEnvironment));
    const linkedRelative = browserRelative.replace(browserId, "11234567-89ab-4cde-8123-456789abcdef");
    symlinkSync(directory, join(f.root, ...linkedRelative.split("/")), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => approvedMysqlBrowserFixture(f.root, { ...browserEnvironment, CRM_MYSQL_BROWSER_FIXTURE: linkedRelative }));
  } finally { f.cleanup(); }
});

test("offline MySQL network-disable gate rejects before attempting any socket connection", async (t) => {
  const previous = process.env.CRM_MYSQL_NETWORK_DISABLED;
  const connect = t.mock.method(Socket.prototype, "connect", function () {
    throw new Error("Unexpected socket attempt in offline test.");
  });
  try {
    process.env.CRM_MYSQL_NETWORK_DISABLED = "1";
    await assert.rejects(connectMysql(local), (error: unknown) => error instanceof Error && error.message.includes("networking is disabled"));
    assert.equal(connect.mock.callCount(), 0);
  } finally {
    if (previous === undefined) delete process.env.CRM_MYSQL_NETWORK_DISABLED;
    else process.env.CRM_MYSQL_NETWORK_DISABLED = previous;
    connect.mock.restore();
  }
});

test("offline MySQL explicit parameter encoding sends pagination integers as LONGLONG without server hints", () => {
  const require = createRequire(import.meta.url);
  // Inspect the installed locked driver encoder, never a running MySQL service.
  const encoder = require(join(dirname(require.resolve("mysql2/package.json")), "lib/packets/encode_parameter.js")) as {
    toParameter(value: unknown, encoding: string, zone: string, jsonAsString: boolean): {
      type: number; length: number; value: unknown; writer(this: { writeUIntLE(value: bigint, bytes: number): void }, value: unknown): void;
    };
  };
  const encoded = mysqlParameterValues([25, 0, Number.MAX_SAFE_INTEGER, -9_223_372_036_854_775_808n]);
  const expected = [25n, 0n, BigInt(Number.MAX_SAFE_INTEGER), 1n << 63n];
  encoded.forEach((value, index) => {
    const wire = encoder.toParameter(value, "utf8", "Z", false);
    assert.equal(wire.type, 8); // MYSQL_TYPE_LONGLONG, never DOUBLE or interpolated SQL.
    assert.equal(wire.length, 8);
    let bytesWritten = 0;
    wire.writer.call({ writeUIntLE(integer, bytes) {
      assert.equal(integer, expected[index]); assert.equal(bytes, 8); bytesWritten += bytes;
    } }, wire.value);
    assert.equal(bytesWritten, 8);
  });
  const content = Buffer.from("synthetic binary");
  assert.deepEqual(mysqlParameterValues(["12345678901234567890.001", "9223372036854775807", content, true, null, 0.5]),
    ["12345678901234567890.001", "9223372036854775807", content, true, null, 0.5]);
  for (const value of [Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity, 9_223_372_036_854_775_808n, {}, undefined]) {
    assert.throws(() => mysqlParameterValues([value]), /^Error: Invalid MySQL parameter\.$/);
  }
});

test("offline runtime database import graph contains MySQL and no SQLite adapter or regression implementation", () => {
  const visited = new Set<string>(), packages = new Set<string>();
  function inspect(filename: string) {
    filename = resolve(filename);
    if (visited.has(filename)) return;
    visited.add(filename);
    const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith(".")) { packages.add(specifier); continue; }
      const base = resolve(dirname(filename), specifier);
      const imported = [base + ".ts", base + ".tsx", join(base, "index.ts")].find(existsSync);
      assert.ok(imported, "Every local database import must resolve to a source file.");
      inspect(imported);
    }
  }
  inspect("src/server/db/index.ts");
  assert.ok(packages.has("mysql2/promise"));
  assert.equal(packages.has("better-sqlite3"), false);
  assert.equal([...visited].some((file) => /sqlite-reference|[/\\]db[/\\]connection\.ts$/u.test(file)), false);
});
