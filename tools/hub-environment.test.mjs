import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertSingleEnvironmentFileLayout, loadHubEnvironment } from "./hub-environment.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "hub-environment-test-"));
  t.after(() => {
    const contained = relative(resolve(tmpdir()), resolve(root));
    assert.ok(contained && !isAbsolute(contained) && contained !== ".." && !contained.startsWith(`..${sep}`));
    assert.match(contained, /^hub-environment-test-/);
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    fs.rmSync(root, { recursive: true });
  });
  return root;
}
function writeEnvironment(root, contents) { fs.writeFileSync(join(root, ".env"), contents); }
function privateFailure(action, pattern) {
  assert.throws(action, error => {
    assert.equal(error.message.includes("private-fixture-value"), false);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test("missing root environment uses explicit ambient settings without reading templates or mutating input", t => {
  const root = fixture(t);
  fs.mkdirSync(join(root, "server"));
  fs.writeFileSync(join(root, ".env.example"), "not a valid environment assignment");
  fs.writeFileSync(join(root, "server", ".env.example"), "not a valid environment assignment");
  const ambient = Object.freeze({ NODE_ENV: "production", PATH: "example-system-path" });
  assert.deepEqual(loadHubEnvironment(root, ambient), ambient);
  assert.notEqual(loadHubEnvironment(root, ambient), ambient);
  assert.deepEqual(loadHubEnvironment(root, {}), {});
});

test("the single root template supplies every shared and listener setting", t => {
  const root = fixture(t);
  const template = fs.readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".env.example"));
  writeEnvironment(root, template);
  assert.deepEqual(loadHubEnvironment(root, {}), {
    NODE_ENV: "production", APP_ORIGIN: "https://hub.voltronix.ae", CRM_API_INSTANCE_ID: "hub-crm",
    CRM_DATABASE_MODE: "disabled", CRM_MYSQL_NETWORK_DISABLED: "1", ZOHO_ENABLED: "false",
    NEXT_TELEMETRY_DISABLED: "1", CRM_WEB_HOST: "127.0.0.1", CRM_WEB_PORT: "3301",
    CRM_FRONTEND_BACKEND: "express", CRM_EXPRESS_ORIGIN: "http://127.0.0.1:3302",
    CRM_API_ENVIRONMENT: "production", CRM_API_HOST: "127.0.0.1", CRM_API_PORT: "3302",
  });
});

test("plain assignments, comments, optional quotes and CRLF parse consistently", t => {
  const root = fixture(t);
  writeEnvironment(root, "# comment\r\n\r\nNODE_ENV = \"production\" # comment\r\nAPP_ORIGIN='https://hub.voltronix.ae'\r\n CRM_API_INSTANCE_ID = hub-crm # comment\r\nCRM_WEB_PORT=3301\r\n");
  assert.deepEqual(loadHubEnvironment(root, {}), { NODE_ENV: "production", APP_ORIGIN: "https://hub.voltronix.ae", CRM_API_INSTANCE_ID: "hub-crm", CRM_WEB_PORT: "3301" });
});

test("defined ambient values override root settings including empty values without mutating either source", t => {
  const root = fixture(t);
  const contents = "CRM_WEB_PORT=3301\nAPP_ORIGIN=https://hub.voltronix.ae\nCRM_API_INSTANCE_ID=hub-crm\n";
  writeEnvironment(root, contents);
  const ambient = Object.freeze({ CRM_WEB_PORT: "4401", APP_ORIGIN: "", CRM_API_INSTANCE_ID: undefined, PATH: "system-path" });
  assert.deepEqual(loadHubEnvironment(root, ambient), { CRM_WEB_PORT: "4401", APP_ORIGIN: "", CRM_API_INSTANCE_ID: "hub-crm", PATH: "system-path" });
  assert.equal(fs.readFileSync(join(root, ".env"), "utf8"), contents);
  assert.equal(ambient.CRM_API_INSTANCE_ID, undefined);
});

test("unknown, client-public and runtime injection keys are refused without displaying values", t => {
  const root = fixture(t);
  for (const key of ["DB_PASSWORD", "DATABASE_URL", "MYSQL_PASSWORD", "CRM_RUNTIME_PROFILE", "NEXT_PUBLIC_ORIGIN", "NODE_OPTIONS", "UNRELATED", "node_env"]) {
    writeEnvironment(root, `${key}=private-fixture-value\n`);
    privateFailure(() => loadHubEnvironment(root, {}));
  }
});

test("native credentials and stored Zoho credentials preserve literal password punctuation without expansion", t => {
  const root = fixture(t);
  const password = "private-fixture-value$VARIABLE${OTHER}$(literal)`command`\\n#with space";
  writeEnvironment(root, `CRM_DATABASE_MODE=mysql-native\nCRM_RUNTIME_SOURCE=environment\nCRM_MYSQL_PASSWORD='${password}'\nZOHO_REFRESH_TOKEN='${password}'\n`);
  const loaded = loadHubEnvironment(root, {});
  assert.equal(loaded.CRM_MYSQL_PASSWORD, password);
  assert.equal(loaded.ZOHO_REFRESH_TOKEN, password);
  assert.equal(loaded.CRM_RUNTIME_SOURCE, "environment");
  for (const raw of ["'unterminated", "\"first\nprivate-fixture-value\"", "'private-fixture-value\ttab'", "'private-fixture-value' extra"]) {
    writeEnvironment(root, `CRM_MYSQL_PASSWORD=${raw}\n`);
    privateFailure(() => loadHubEnvironment(root, {}));
  }
});

test("duplicate assignments fail even when values match or ambient settings would override them", t => {
  const root = fixture(t);
  writeEnvironment(root, "CRM_API_INSTANCE_ID=private-fixture-value\n CRM_API_INSTANCE_ID = private-fixture-value\n");
  privateFailure(() => loadHubEnvironment(root, { CRM_API_INSTANCE_ID: "hub-crm" }), /duplicate/);
});

test("interpolation, shell expansion, escapes and multiline values are refused", t => {
  const root = fixture(t);
  for (const value of ["$PRIVATE", "${PRIVATE}", "$(private-fixture-value)", "`private-fixture-value`", "\"line\\nprivate-fixture-value\"", "\"first\nprivate-fixture-value\"", "'unterminated", "\"value\" extra", "plain\"quoted", "'with\ttab'"]) {
    writeEnvironment(root, `CRM_API_INSTANCE_ID=${value}\n`);
    privateFailure(() => loadHubEnvironment(root, {}));
  }
});

test("export prefixes, missing assignments and multiple assignments on one line are not accepted as valid configuration", t => {
  const root = fixture(t);
  for (const line of ["export NODE_ENV=production", "NODE_ENV", "=private-fixture-value", "NODE_ENV=production CRM_WEB_PORT=3301"]) {
    writeEnvironment(root, line);
    privateFailure(() => loadHubEnvironment(root, {}), /assignment/);
  }
});

test("NUL, control, nonstandard whitespace and lone carriage returns fail with fixed diagnostics", t => {
  const root = fixture(t);
  for (const control of ["\0", "\x01", "\x7f", "\x85", "\v", "\f", "\r", "\u2028", "\u00a0", "\ufeff", "\u202e"]) {
    writeEnvironment(root, `CRM_API_INSTANCE_ID=private-fixture-value${control}suffix\n`);
    privateFailure(() => loadHubEnvironment(root, {}), /control|whitespace/);
  }
});

test("invalid UTF-8 is rejected rather than silently replaced", t => {
  const root = fixture(t);
  writeEnvironment(root, Buffer.from([0x43, 0x52, 0x4d, 0x3d, 0xc3, 0x28]));
  assert.throws(() => loadHubEnvironment(root, {}), /UTF-8/);
});

test("the 16 KiB limit is measured in bytes and includes comments", t => {
  const root = fixture(t);
  writeEnvironment(root, `#${"x".repeat(16 * 1024 - 1)}`);
  assert.deepEqual(loadHubEnvironment(root, {}), {});
  writeEnvironment(root, `#${"x".repeat(16 * 1024)}`);
  assert.throws(() => loadHubEnvironment(root, {}), /16 KiB/);
  writeEnvironment(root, `#${"é".repeat(8192)}`);
  assert.throws(() => loadHubEnvironment(root, {}), /16 KiB/);
});

test("all additional active root and server dotenv names are refused without fallback", t => {
  const root = fixture(t);
  fs.mkdirSync(join(root, "server"));
  for (const directory of [root, join(root, "server")]) {
    for (const name of [".env.local", ".env.production", ".env.production.local", ".ENV", ".env.example.private", ...(directory === root ? [] : [".env"])]) {
      const path = join(directory, name);
      fs.writeFileSync(path, "DB_PASSWORD=private-fixture-value");
      privateFailure(() => loadHubEnvironment(root, {}), /Only the root .env/);
      fs.rmSync(path);
    }
  }
});

test("directories named as environment files are rejected", t => {
  const root = fixture(t);
  fs.mkdirSync(join(root, ".env"));
  assert.throws(() => loadHubEnvironment(root, {}), /ordinary files/);
});

test("hard-linked environment files are rejected before reading", t => {
  const root = fixture(t);
  const original = join(root, "private-fixture");
  fs.writeFileSync(original, "CRM_API_INSTANCE_ID=private-fixture-value");
  fs.linkSync(original, join(root, ".env"));
  privateFailure(() => loadHubEnvironment(root, {}), /hard links/);
});

test("dangling environment links are rejected even though their target does not exist", t => {
  const root = fixture(t);
  fs.symlinkSync(join(root, "missing-target"), join(root, ".env"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => loadHubEnvironment(root, {}), /ordinary files/);
});

test("a linked project ancestor is rejected before any environment lookup", t => {
  const root = fixture(t);
  fs.mkdirSync(join(root, "ordinary", "project"), { recursive: true });
  fs.symlinkSync(join(root, "ordinary"), join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => loadHubEnvironment(join(root, "linked", "project"), {}), /without links|through links/);
});

test("linked server directories and template links cannot bypass the layout check", t => {
  const root = fixture(t);
  fs.mkdirSync(join(root, "ordinary"));
  fs.symlinkSync(join(root, "ordinary"), join(root, "server"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => assertSingleEnvironmentFileLayout(root), /without links/);
  fs.rmSync(join(root, "server"));
  fs.symlinkSync(join(root, "ordinary"), join(root, ".env.example"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => assertSingleEnvironmentFileLayout(root), /ordinary files/);
});

test("a file altered during reading is rejected and its descriptor is closed", t => {
  const root = fixture(t);
  writeEnvironment(root, "CRM_API_INSTANCE_ID=hub-crm\n");
  const read = fs.readSync;
  let changed = false;
  const mocked = t.mock.method(fs, "readSync", (...args) => {
    const count = read(...args);
    if (!changed) {
      changed = true;
      fs.appendFileSync(join(root, ".env"), "# private-fixture-value\n");
    }
    return count;
  });
  privateFailure(() => loadHubEnvironment(root, {}), /changed/);
  mocked.mock.restore();
  fs.renameSync(join(root, ".env"), join(root, "closed-descriptor-fixture"));
  assert.equal(changed, true);
});

test("a file replaced between inspection and open cannot supply a different environment", t => {
  const root = fixture(t);
  writeEnvironment(root, "CRM_API_INSTANCE_ID=hub-crm\n");
  const open = fs.openSync;
  let replaced = false;
  const mocked = t.mock.method(fs, "openSync", (...args) => {
    if (!replaced && args[0] === join(root, ".env")) {
      replaced = true;
      fs.renameSync(join(root, ".env"), join(root, "previous-environment"));
      fs.writeFileSync(join(root, ".env"), "CRM_API_INSTANCE_ID=private-fixture-value\n");
    }
    return open(...args);
  });
  privateFailure(() => loadHubEnvironment(root, {}), /changed/);
  mocked.mock.restore();
  assert.equal(replaced, true);
});

test("filesystem failures do not expose raw paths or original error values", t => {
  const root = fixture(t);
  writeEnvironment(root, "NODE_ENV=production\n");
  const mocked = t.mock.method(fs, "openSync", () => {
    throw Object.assign(new Error("private-fixture-value"), { code: "EACCES" });
  });
  privateFailure(() => loadHubEnvironment(root, {}), /Cannot safely read/);
  mocked.mock.restore();
});
