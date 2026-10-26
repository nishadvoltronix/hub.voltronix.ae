import assert from "node:assert/strict";
import test from "node:test";
import type { LocalMysqlConfig } from "../src/server/config/mysql";
import type { MysqlMigrationSession } from "../src/server/db/mysql/migrations";
import { MysqlBackupRehearsalError, rehearseMysqlApplicationBackup, validateMysqlBackupPair } from "../src/server/db/mysql/backup-rehearsal";

const source: LocalMysqlConfig = { provider: "mysql", environment: "test", host: "127.0.0.1", port: 3308,
  database: "crm_local_test_offline", user: "synthetic_source", password: "synthetic ignored credential" };
const target: LocalMysqlConfig = { ...source, database: "crm_local_restore_offline", user: "synthetic_target" };
function connection(database: string, mutations: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const db: MysqlMigrationSession = {
    async execute(sql) {
      calls.push(sql);
      if (sql.startsWith("SELECT DATABASE()")) return [[{ selectedDatabase: database, serverVersion: "8.4.11",
        versionComment: "MySQL Community Server - GPL", port: 3308, foreignKeys: 1, autocommit: 1, ...mutations }], []];
      if (sql.startsWith("SELECT CAST(COUNT(*) AS CHAR) AS n FROM information_schema.")) return [[{ n: mutations.objects ?? "0" }], []];
      if (sql.includes("information_schema.TABLES")) return [[], []];
      throw new Error("Synthetic private driver detail");
    },
    async query(sql) { calls.push(sql); return [[], []]; },
  };
  return { db, calls };
}

test("OFFLINE backup pair requires distinct test/restore schemas, identities, local endpoint and explicit source freeze acknowledgement", () => {
  assert.deepEqual(validateMysqlBackupPair(source, target, true), { source, target });
  for (const mutation of [
    { environment: "development" }, { host: "::1" }, { port: 3306 }, { database: "crm_local_dev" },
    { database: source.database }, { user: source.user },
  ]) assert.throws(() => validateMysqlBackupPair(source, { ...target, ...mutation } as LocalMysqlConfig, true));
  assert.throws(() => validateMysqlBackupPair(source, target, false), MysqlBackupRehearsalError);
  assert.throws(() => validateMysqlBackupPair({ ...source, database: "crm_local_dev" }, target, true), MysqlBackupRehearsalError);
});

test("OFFLINE missing acknowledgement refuses backup before database calls or filesystem work", async () => {
  const left = connection(source.database), right = connection(target.database);
  await assert.rejects(rehearseMysqlApplicationBackup({ source: left.db, target: right.db, sourceConfig: source, targetConfig: target,
    artifactRoot: "unselected", acknowledgeFrozenSource: false as unknown as true }), MysqlBackupRehearsalError);
  assert.deepEqual(left.calls, []); assert.deepEqual(right.calls, []);
});

test("OFFLINE backup rejects incompatible product/version, selected-schema mismatch and disabled foreign keys without DDL", async () => {
  for (const mutation of [{ serverVersion: "8.4.10" }, { versionComment: "MariaDB Server" }, { selectedDatabase: "crm_local_dev" },
    { port: 3306 }, { foreignKeys: 0 }, { autocommit: 0 }]) {
    const left = connection(source.database, mutation), right = connection(target.database);
    await assert.rejects(rehearseMysqlApplicationBackup({ source: left.db, target: right.db, sourceConfig: source, targetConfig: target,
      artifactRoot: "unselected", acknowledgeFrozenSource: true }), MysqlBackupRehearsalError);
    assert.equal([...left.calls, ...right.calls].some((sql) => !sql.startsWith("SELECT")), false);
  }
});

test("OFFLINE nonempty restore target is preserved and refused without source export or target mutations", async () => {
  const left = connection(source.database), right = connection(target.database, { objects: "1" });
  await assert.rejects(rehearseMysqlApplicationBackup({ source: left.db, target: right.db, sourceConfig: source, targetConfig: target,
    artifactRoot: "unselected", acknowledgeFrozenSource: true }), MysqlBackupRehearsalError);
  assert.equal([...left.calls, ...right.calls].some((sql) => /^(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|TRUNCATE|START)/u.test(sql)), false);
  assert.equal(left.calls.some((sql) => sql.includes("information_schema.TABLES")), false);
});

test("OFFLINE incompatible source migration/schema fails safely before artifact creation or restore mutation", async () => {
  const left = connection(source.database), right = connection(target.database);
  await assert.rejects(rehearseMysqlApplicationBackup({ source: left.db, target: right.db, sourceConfig: source, targetConfig: target,
    artifactRoot: "unselected", acknowledgeFrozenSource: true }), (error: unknown) => {
    assert.ok(error instanceof MysqlBackupRehearsalError);
    assert.equal(error.message.includes(source.password), false);
    assert.equal(error.message.includes("private driver detail"), false); return true;
  });
  assert.equal(right.calls.some((sql) => /^(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|TRUNCATE)/u.test(sql)), false);
});
