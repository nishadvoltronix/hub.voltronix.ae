import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { DatabaseConfigurationError, parseDatabaseConfig } from "../src/server/config/database";
import { openDatabase, validateDatabasePath } from "../src/server/db/connection";
import { filesystemFixture } from "./database-fixture";

const environment = { DATABASE_ENVIRONMENT: "test", SQLITE_DATABASE_PATH: ".local-data/test/crm.sqlite" };

test("selecting MySQL cannot silently open the retained SQLite database", () => {
  for (const provider of ["mysql", "mariadb", "", "private-invalid-provider"]) {
    assert.throws(() => parseDatabaseConfig({ ...environment, DATABASE_PROVIDER: provider }), (error: unknown) => {
      assert.ok(error instanceof DatabaseConfigurationError);
      assert.deepEqual(error.fields, ["DATABASE_PROVIDER"]);
      assert.equal(error.message, "Invalid database configuration: DATABASE_PROVIDER.");
      return true;
    });
  }
  assert.equal(parseDatabaseConfig({ ...environment, DATABASE_PROVIDER: "sqlite" }).environment, "test");
});

test("configuration requires explicit local environment/path and never reveals invalid values", () => {
  assert.throws(() => parseDatabaseConfig({}), (error: unknown) => {
    assert.ok(error instanceof DatabaseConfigurationError);
    assert.deepEqual(error.fields, ["DATABASE_ENVIRONMENT", "SQLITE_DATABASE_PATH"]);
    return true;
  });
  assert.throws(() => parseDatabaseConfig({ ...environment, DATABASE_ENVIRONMENT: "production" }), DatabaseConfigurationError);
  assert.throws(() => parseDatabaseConfig({ ...environment, SQLITE_DATABASE_PATH: "private-secret-value" }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes("private-secret-value"), false);
    return true;
  });
});

test("SQLite paths reject traversal, other environments, drives, UNC, URI and in-memory targets", () => {
  for (const path of [
    ":memory:", "file:crm.sqlite?mode=rw", "../crm.sqlite", ".local-data/test/../development/crm.sqlite",
    ".local-data/development/crm.sqlite", ".local-data/test", ".local-data/test/crm.sqlite/..",
    ".local-data/test/CON.sqlite", ".local-data/test/crm.", ".local-data/test/crm.sqlite:secret",
    "G:\\crm.sqlite", "\\\\server\\share\\crm.sqlite", "/tmp/crm.sqlite", ".local-data/test/crm.sql",
  ]) assert.throws(() => parseDatabaseConfig({ ...environment, SQLITE_DATABASE_PATH: path }), DatabaseConfigurationError, path);
  assert.equal(parseDatabaseConfig({ ...environment, SQLITE_DATABASE_PATH: ".local-data\\test\\crm.sqlite" }).environment, "test");
});

test("validation has no filesystem side effects and normal access never creates a missing database", () => {
  const fixture = filesystemFixture();
  try {
    validateDatabasePath(fixture.config);
    assert.equal(existsSync(join(fixture.root, ".local-data")), false);
    assert.throws(() => openDatabase(fixture.config));
    assert.equal(existsSync(fixture.config.filename), false);
    const db = openDatabase(fixture.config, { create: true });
    db.close();
    assert.equal(existsSync(fixture.config.filename), true);
  } finally { fixture.cleanup(); }
});

test("directory junctions are rejected and linked targets remain unchanged", () => {
  const fixture = filesystemFixture();
  try {
    const target = join(fixture.root, "preserve");
    mkdirSync(target);
    writeFileSync(join(target, "sentinel.txt"), "unchanged");
    symlinkSync(target, join(fixture.root, ".local-data"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => openDatabase(fixture.config, { create: true }), DatabaseConfigurationError);
    assert.equal(readFileSync(join(target, "sentinel.txt"), "utf8"), "unchanged");
    assert.equal(existsSync(join(target, "test")), false);
  } finally { fixture.cleanup(); }
});

test("database and WAL hardlinks cannot redirect writes into other preserved files", () => {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const fixture = filesystemFixture();
    try {
      mkdirSync(dirname(fixture.config.filename), { recursive: true });
      const preserved = join(fixture.root, "preserved-file");
      writeFileSync(preserved, "preserve these bytes");
      linkSync(preserved, fixture.config.filename + suffix);
      assert.throws(() => openDatabase(fixture.config, { create: true }), DatabaseConfigurationError);
      assert.equal(readFileSync(preserved, "utf8"), "preserve these bytes");
    } finally { fixture.cleanup(); }
  }
});

test("a hand-built config cannot escape the approved local directory", () => {
  const fixture = filesystemFixture();
  try {
    assert.throws(() => openDatabase({ ...fixture.config, filename: join(fixture.root, "outside.sqlite") }, { create: true }), DatabaseConfigurationError);
    assert.equal(existsSync(join(fixture.root, "outside.sqlite")), false);
  } finally { fixture.cleanup(); }
});
