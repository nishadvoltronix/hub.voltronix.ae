import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseDatabaseConfig } from "../src/server/config/database";

export function filesystemFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "crm-sqlite-test-")));
  const config = parseDatabaseConfig({ DATABASE_ENVIRONMENT: "test", SQLITE_DATABASE_PATH: ".local-data/test/crm.sqlite" }, root);
  return {
    root, config,
    cleanup() {
      const target = resolve(root);
      assert.equal(dirname(target), realpathSync(tmpdir()));
      assert.ok(basename(target).startsWith("crm-sqlite-test-"));
      rmSync(target, { recursive: true, force: true });
    },
  };
}
