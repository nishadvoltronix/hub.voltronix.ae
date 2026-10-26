import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/server/db/connection";
import { migrateDatabase } from "../src/server/db/migrations";
import { inspectSchema, SchemaInspectionError, writeSchemaReport } from "../src/server/db/schema";
import { filesystemFixture } from "./database-fixture";

test("read-only inspection reports metadata/counts without passwords, row values or SQL defaults", () => {
  const fixture = filesystemFixture();
  const writer = openDatabase(fixture.config, { create: true });
  try {
    migrateDatabase(writer);
    writer.prepare("INSERT INTO users(username,email,password) VALUES(?,?,?)").run("secret-display-value", "private@example.invalid", "private-password-hash");
    writer.exec("ALTER TABLE users ADD COLUMN fixture TEXT DEFAULT 'private-default-value'");
    assert.throws(() => inspectSchema(writer, fixture.config), SchemaInspectionError);
    const reader = openDatabase(fixture.config, { readonly: true });
    try {
      const report = inspectSchema(reader, fixture.config);
      assert.equal(report.integrity, "ok");
      assert.equal(report.foreignKeyViolations, 0);
      assert.equal(report.tables.find((table) => table.name === "users")?.rowCount, "1");
      for (const sensitive of ["secret-display-value", "private@example.invalid", "private-password-hash", "private-default-value"]) {
        assert.equal(JSON.stringify(report).includes(sensitive), false);
      }
      const first = writeSchemaReport(fixture.root, report);
      const original = readFileSync(first, "utf8");
      const second = writeSchemaReport(fixture.root, report);
      assert.notEqual(first, second);
      assert.equal(readFileSync(first, "utf8"), original);
      assert.deepEqual(JSON.parse(original), report);
      assert.throws(() => reader.prepare("DELETE FROM users").run(), /readonly/);
    } finally { reader.close(); }
  } finally { writer.close(); fixture.cleanup(); }
});

test("report destination rejects directory links without writing to the linked target", () => {
  const fixture = filesystemFixture();
  const writer = openDatabase(fixture.config, { create: true });
  try {
    migrateDatabase(writer);
    const reader = openDatabase(fixture.config, { readonly: true });
    try {
      const report = inspectSchema(reader, fixture.config);
      const target = join(fixture.root, "report-target");
      mkdirSync(target);
      symlinkSync(target, join(fixture.root, ".local-data", "reports"), process.platform === "win32" ? "junction" : "dir");
      assert.throws(() => writeSchemaReport(fixture.root, report), /Invalid database configuration/);
    } finally { reader.close(); }
  } finally { writer.close(); fixture.cleanup(); }
});

test("inspection includes SQLite-like user tables while excluding real internal tables and row values", () => {
  const fixture = filesystemFixture();
  const writer = openDatabase(fixture.config, { create: true });
  try {
    migrateDatabase(writer);
    writer.exec("CREATE TABLE sqliteXhistory(value TEXT); INSERT INTO sqliteXhistory VALUES('private synthetic history')");
    const reader = openDatabase(fixture.config, { readonly: true });
    try {
      const report = inspectSchema(reader, fixture.config);
      assert.equal(report.tables.find(({ name }) => name === "sqliteXhistory")?.rowCount, "1");
      assert.equal(report.tables.some(({ name }) => name.startsWith("sqlite_")), false);
      assert.equal(JSON.stringify(report).includes("private synthetic history"), false);
    } finally { reader.close(); }
  } finally { writer.close(); fixture.cleanup(); }
});
