import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { MysqlDatabase, MysqlDatabaseError } from "../src/crm/db/mysql/database.js";
import type { MysqlWireConnection } from "../src/crm/db/mysql/driver.js";
import { createMysqlAuthStore } from "../src/auth/mysql-store.js";
import { AuthError } from "../src/auth/errors.js";

const config = { provider: "mysql", environment: "test", host: "127.0.0.1", port: 3308,
  database: "crm_local_crm_0123456789ab4def8123456789abcdef", user: "synthetic", password: "synthetic-test-only" } as const;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function wire(overrides: Partial<MysqlWireConnection> = {}) {
  const events: string[] = [], values: readonly unknown[][] = [];
  const connection: MysqlWireConnection = { async query(sql) { events.push(sql); return [[], []]; },
    async execute(sql) { events.push(sql); return sql.includes("crm_app_lock") ? [[{ id: 1 }], []] : [[{ result: "ok" }], []]; },
    async beginTransaction() { events.push("begin"); }, async commit() { events.push("commit"); },
    async rollback() { events.push("rollback"); }, async end() { events.push("end"); }, destroy() { events.push("destroy"); }, ...overrides };
  return { connection, events, values };
}
function fixture(overrides: Partial<MysqlWireConnection> = {}) {
  const f = wire(overrides); let connections = 0;
  const db = new MysqlDatabase(config, { connect: async () => { connections++; return f.connection; }, verify: async () => {} });
  return { ...f, db, connections: () => connections };
}

test("OFFLINE CRM auth bridge preserves warning status, raw integer strings and parameterization", async () => {
  const packet = { affectedRows: 1, warningStatus: 7, insertId: "9007199254740993" }, seen: unknown[] = [];
  const f = fixture({ async execute(sql, values) {
    if (sql.includes("crm_app_lock")) return [[{ id: 1 }], []];
    seen.push(sql, values); return [packet, []];
  } });
  const result = await f.db.authTransaction(tx => tx.execute("UPDATE users SET username=? WHERE id=?", ["' synthetic", "9007199254740993"]));
  assert.equal(result[0], packet);
  assert.deepEqual(seen, ["UPDATE users SET username=? WHERE id=?", ["' synthetic", "9007199254740993"]]);
  assert.equal(f.connections(), 1); assert.equal(f.events.filter(value => value === "commit").length, 1);
});

test("OFFLINE existing auth adapter rejects MySQL warnings through CRM bridge and rolls back", async () => {
  const f = fixture({ async execute(sql) { return sql.includes("crm_app_lock") ? [[{ id: 1 }], []] : [{ affectedRows: 1, warningStatus: 1 }, []]; } });
  const store = createMysqlAuthStore({ transaction: work => f.db.authTransaction(work) });
  await assert.rejects(store.transaction(tx => tx.deleteSession("a".repeat(64))), AuthError);
  assert.ok(f.events.includes("rollback")); assert.ok(!f.events.includes("commit"));
});

test("OFFLINE CRM auth bridge forbids SQL controls and no caught refusal can commit", async () => {
  for (const sql of ["DROP TABLE users", "SELECT 1; SELECT 2", "SELECT LOAD_FILE(?)", "SELECT 1 -- note", "SELECT /* note */ 1"]) {
    const f = fixture();
    await assert.rejects(f.db.authTransaction(async tx => {
      await assert.rejects(tx.execute(sql), MysqlDatabaseError);
    }), MysqlDatabaseError);
    assert.ok(!f.events.includes(sql)); assert.ok(!f.events.includes("commit"));
  }
});

test("OFFLINE CRM auth bridge rejects detached execution after callback completion", async () => {
  const f = fixture(); let saved: { execute(sql: string): Promise<[unknown, unknown]> } | undefined;
  await f.db.authTransaction(async tx => { saved = tx; });
  await assert.rejects(saved!.execute("SELECT detached"), MysqlDatabaseError);
  assert.ok(!f.events.includes("SELECT detached")); assert.equal(f.connections(), 1);
});

test("OFFLINE nested auth invocation poisons its transaction even when caller catches the refusal", async () => {
  const f = fixture();
  await assert.rejects(f.db.authTransaction(async () => {
    await assert.rejects(f.db.authTransaction(async () => 1), MysqlDatabaseError);
  }), MysqlDatabaseError);
  assert.ok(f.events.includes("destroy")); assert.ok(!f.events.includes("commit"));
});

test("OFFLINE CRM auth bridge refuses overlapping calls and destroys uncertain in-flight work", async () => {
  const delayed = deferred<[unknown, unknown]>(), started = deferred<void>();
  const f = fixture({ async execute(sql) {
    if (sql.includes("crm_app_lock")) return [[{ id: 1 }], []]; started.resolve(); return delayed.promise;
  } });
  await assert.rejects(f.db.authTransaction(async tx => {
    const first = tx.execute("SELECT delayed"); await started.promise;
    await assert.rejects(tx.execute("SELECT overlapping"), MysqlDatabaseError);
    delayed.resolve([[], []]); await first;
  }), MysqlDatabaseError);
  assert.ok(f.events.includes("destroy")); assert.ok(!f.events.includes("commit"));
});

test("OFFLINE close drains an owned transaction, rejects fresh work, and is idempotent", async () => {
  const f = fixture(), waiting = deferred<void>(), started = deferred<void>();
  const work = f.db.transaction(async () => { started.resolve(); await waiting.promise; return f.db.prepare("SELECT finishing").get(); })();
  await started.promise;
  const stop = f.db.close(); assert.equal(f.db.close(), stop);
  await assert.rejects(f.db.prepare("SELECT new").get(), MysqlDatabaseError);
  waiting.resolve(); assert.deepEqual(await work, { result: "ok" }); await stop;
  assert.ok(f.events.includes("commit")); assert.ok(!f.events.includes("destroy"));
});

test("OFFLINE shutdown deadline aborts callback, prevents later SQL and never commits", async () => {
  const f = fixture(), waiting = deferred<void>(), started = deferred<void>();
  const work = f.db.transaction(async () => { started.resolve(); await waiting.promise; return f.db.prepare("SELECT too_late").get(); })();
  const failed = assert.rejects(work, MysqlDatabaseError); await started.promise;
  await f.db.close(5); await failed; waiting.resolve(); await tick();
  assert.ok(f.events.includes("destroy")); assert.ok(!f.events.includes("commit")); assert.ok(!f.events.includes("SELECT too_late"));
});

test("OFFLINE shutdown disposes a connection which resolves after the deadline", async () => {
  const delayed = deferred<MysqlWireConnection>(), f = wire();
  const db = new MysqlDatabase(config, { connect: () => delayed.promise, verify: async () => {} });
  const failed = assert.rejects(db.prepare("SELECT never").get(), MysqlDatabaseError);
  await db.close(5); await failed; delayed.resolve(f.connection); await tick();
  assert.deepEqual(f.events, ["destroy"]);
});

test("OFFLINE uncertain COMMIT failure is redacted and never retried or rolled back", async () => {
  const f = fixture({ async commit() { throw new Error("synthetic-private-failure"); } }); let operations = 0;
  await assert.rejects(f.db.authTransaction(async () => { operations++; }), error => error instanceof MysqlDatabaseError
    && !error.message.includes("private-failure"));
  assert.equal(operations, 1); assert.equal(f.connections(), 1);
  assert.ok(f.events.includes("destroy")); assert.ok(!f.events.includes("rollback"));
});

test("OFFLINE graceful drain retains ordinary nested CRM savepoint behavior", async () => {
  const f = fixture();
  assert.equal(await f.db.transaction(() => f.db.transaction(async () => 42)())(), 42);
  assert.ok(f.events.includes("SAVEPOINT crm_nested_1")); assert.ok(f.events.includes("RELEASE SAVEPOINT crm_nested_1"));
  assert.equal(f.connections(), 1); await f.db.close();
});
