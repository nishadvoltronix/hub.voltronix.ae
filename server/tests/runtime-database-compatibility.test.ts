import assert from "node:assert/strict";
import test from "node:test";
import { MysqlDatabase, MysqlDatabaseError } from "../src/crm/db/mysql/database.js";
import { mysqlConnectionOptions, type MysqlWireConnection } from "../src/crm/db/mysql/driver.js";
import type { LocalMysqlConfig } from "../src/crm/config/mysql.js";

// Offline, injected wire protocol only. No MySQL process, socket, schema or record is touched.
const config: LocalMysqlConfig = { provider: "mysql", environment: "test", host: "127.0.0.1",
  port: 3308, database: "crm_test_adapter", user: "synthetic_fixture", password: "unused-isolated-test-value" };
type Reply = [unknown, unknown];
function fixture(options: { execute?: (sql: string, values: readonly unknown[]) => Reply | Promise<Reply>;
  query?: (sql: string) => void; commitFailure?: boolean; verifyFailure?: boolean; endFailure?: boolean; destroyFailure?: boolean } = {}) {
  const trace: string[] = [], parameters: unknown[][] = [];
  let connections = 0;
  const connection: MysqlWireConnection = {
    async execute(sql, values = []) {
      trace.push(sql); parameters.push([...values]);
      if (sql === "SELECT id FROM crm_app_lock WHERE id=1 FOR UPDATE") return [[{ id: 1 }], []];
      return options.execute ? options.execute(sql, values) : [[{ result: "ok" }], []];
    },
    async query(sql) { trace.push(sql); options.query?.(sql); return [[], []]; },
    async beginTransaction() { trace.push("BEGIN"); },
    async commit() { trace.push("COMMIT"); if (options.commitFailure) throw new Error("private synthetic commit detail"); },
    async rollback() { trace.push("ROLLBACK"); },
    async end() { trace.push("END"); if (options.endFailure) throw new Error("private synthetic close detail"); },
    destroy() { trace.push("DESTROY"); if (options.destroyFailure) throw new Error("private synthetic destroy detail"); },
  };
  const db = new MysqlDatabase(config, { connect: async () => { connections++; return connection; },
    verify: async () => { trace.push("VERIFY"); if (options.verifyFailure) throw new Error("private synthetic schema detail"); } });
  return { db, trace, parameters, connections: () => connections };
}
const unavailable = (error: unknown) => error instanceof MysqlDatabaseError && error.code === "MYSQL_UNAVAILABLE"
  && !error.message.includes("private synthetic");

test("offline MySQL transaction pins nested operations and acquires the application lock first", async () => {
  const f = fixture();
  const answer = await f.db.transaction(async () => {
    assert.equal(f.db.inTransaction, true);
    await f.db.prepare("SELECT first_value").get();
    return f.db.transaction(async () => {
      await f.db.prepare("SELECT second_value").all();
      return 42;
    }).immediate();
  })();
  assert.equal(answer, 42);
  assert.equal(f.connections(), 1);
  assert.equal(f.trace.filter((item) => item === "BEGIN").length, 1);
  assert.equal(f.trace.filter((item) => item === "COMMIT").length, 1);
  assert.ok(f.trace.indexOf("SELECT id FROM crm_app_lock WHERE id=1 FOR UPDATE") < f.trace.indexOf("SELECT first_value"));
  assert.ok(f.trace.some((item) => item.startsWith("SAVEPOINT crm_nested_")));
  assert.ok(f.trace.some((item) => item.startsWith("RELEASE SAVEPOINT crm_nested_")));
  assert.equal(f.trace.includes("ROLLBACK"), false);
  assert.equal(f.db.inTransaction, false);
});

test("offline MySQL nested callback error rolls back to savepoint and preserves the domain error", async () => {
  const f = fixture(), domain = new Error("Synthetic expected domain conflict");
  await f.db.transaction(async () => {
    await assert.rejects(f.db.transaction(async () => { throw domain; })(), (error: unknown) => error === domain);
    await f.db.prepare("SELECT after_savepoint").get();
  })();
  assert.ok(f.trace.some((item) => item.startsWith("ROLLBACK TO SAVEPOINT crm_nested_")));
  assert.equal(f.trace.filter((item) => item === "COMMIT").length, 1);
  assert.equal(f.trace.includes("ROLLBACK"), false);
});

test("offline MySQL outer callback rejection dispatches rollback and never commits", async () => {
  const f = fixture(), domain = new Error("Synthetic input conflict");
  await assert.rejects(f.db.transaction(async () => { throw domain; })(), (error: unknown) => error === domain);
  assert.ok(f.trace.includes("ROLLBACK"));
  assert.equal(f.trace.includes("COMMIT"), false);
  assert.equal(f.connections(), 1);
});

test("offline MySQL savepoint release failure cannot expose raw driver details", async () => {
  let releases = 0;
  const f = fixture({ query: (sql) => {
    if (sql.startsWith("RELEASE SAVEPOINT") && ++releases === 1) throw new Error("private synthetic savepoint detail");
  } });
  await assert.rejects(f.db.transaction(async () => f.db.transaction(async () => "synthetic")())(), unavailable);
  assert.equal(f.trace.includes("COMMIT"), false);
});

test("offline MySQL uncertain commit destroys the connection without retrying business work", async () => {
  const f = fixture({ commitFailure: true });
  let operations = 0;
  await assert.rejects(f.db.transaction(async () => { operations++; return "synthetic"; })(), unavailable);
  assert.equal(operations, 1);
  assert.equal(f.connections(), 1);
  assert.equal(f.trace.filter((item) => item === "COMMIT").length, 1);
  assert.ok(f.trace.includes("DESTROY"));
  assert.equal(f.trace.includes("ROLLBACK"), false);
});

test("offline MySQL detached async work cannot reuse an expired transaction connection", async () => {
  const f = fixture();
  let release!: () => void, detached!: Promise<unknown>;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  await f.db.transaction(async () => {
    detached = (async () => { await wait; return f.db.prepare("SELECT must_not_execute").get(); })();
  })();
  const rejected = assert.rejects(detached, unavailable);
  release();
  await rejected;
  assert.equal(f.trace.includes("SELECT must_not_execute"), false);
  assert.equal(f.connections(), 1);
});

test("offline MySQL detached nested work prevents commit and cannot execute after its parent closes", async () => {
  const f = fixture();
  let release!: () => void, entered!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let detached!: Promise<{ error?: unknown }>, parentError: unknown;
  try {
    await f.db.transaction(async () => {
      detached = f.db.transaction(async () => {
        entered(); await wait;
        await f.db.prepare("SELECT detached_nested_must_not_execute").get();
      })().then(() => ({}), (error: unknown) => ({ error }));
      await started;
      // Deliberate invalid caller: parent returns without awaiting its child.
    })();
  } catch (error) { parentError = error; }
  finally { release(); }
  const child = await detached;
  assert.ok(unavailable(parentError));
  assert.ok(unavailable(child.error));
  assert.equal(f.trace.includes("SELECT detached_nested_must_not_execute"), false);
  assert.equal(f.trace.includes("COMMIT"), false);
});

test("offline MySQL rejects overlapping sibling savepoints while preserving awaited nesting", async () => {
  const f = fixture();
  let release!: () => void, entered!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  await f.db.transaction(async () => {
    const first = f.db.transaction(async () => { entered(); await wait; })();
    await started;
    await assert.rejects(f.db.transaction(async () => "overlap")(), unavailable);
    release(); await first;
    await f.db.transaction(async () => f.db.transaction(async () => {
      await f.db.prepare("SELECT legitimate_nested_value").get();
    })())();
  })();
  assert.equal(f.connections(), 1);
  assert.equal(f.trace.filter((sql) => sql === "COMMIT").length, 1);
});

test("offline MySQL cannot commit after a caught unawaited grandchild transaction", async () => {
  const f = fixture();
  let release!: () => void, entered!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let detached!: Promise<{ error?: unknown }>, rootError: unknown;
  try {
    await f.db.transaction(async () => {
      try {
        await f.db.transaction(async () => {
          detached = f.db.transaction(async () => {
            entered(); await wait;
            await f.db.prepare("SELECT detached_grandchild_must_not_execute").get();
          })().then(() => ({}), (error: unknown) => ({ error }));
          await started;
        })();
      } catch { /* Deliberately invalid caller tries to continue after the broken nested scope. */ }
    })();
  } catch (error) { rootError = error; }
  finally { release(); }
  const child = await detached;
  assert.ok(unavailable(rootError));
  assert.ok(unavailable(child.error));
  assert.equal(f.trace.includes("SELECT detached_grandchild_must_not_execute"), false);
  assert.equal(f.trace.includes("COMMIT"), false);
});

test("offline MySQL preserves integer, decimal, null and insert identity precision", async () => {
  const f = fixture({ execute: (sql) => sql.startsWith("INSERT")
    ? [{ affectedRows: 1, insertId: "9223372036854775807" }, []]
    : [[{ small: "7", large: "9223372036854775807", amount: "12345678901234567890.123456", absent: null }],
      [{ name: "small", columnType: 3 }, { name: "large", columnType: 8 }, { name: "amount", columnType: 246 }, { name: "absent", columnType: 8 }]] });
  assert.deepEqual(await f.db.prepare("SELECT exact_values").get(),
    { small: 7, large: 9223372036854775807n, amount: "12345678901234567890.123456", absent: null });
  assert.deepEqual(await f.db.prepare("SELECT exact_values").safeIntegers().get(),
    { small: 7n, large: 9223372036854775807n, amount: "12345678901234567890.123456", absent: null });
  const inserted = await f.db.prepare("INSERT INTO synthetic_fixture(value) VALUES(?)").run(9223372036854775807n);
  assert.deepEqual(inserted, { changes: 1, lastInsertRowid: 9223372036854775807n });
  assert.deepEqual(f.parameters.at(-1), ["9223372036854775807"]);
});

test("offline MySQL rejects unsafe numeric and unsupported parameter values before execution", async () => {
  const f = fixture();
  for (const value of [Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, undefined, {}]) {
    await assert.rejects(f.db.prepare("SELECT ?").get(value), unavailable);
  }
  assert.equal(f.trace.includes("SELECT ?"), false);
});

test("offline MySQL duplicate errors expose only a safe conflict code", async () => {
  const f = fixture({ execute: () => { throw Object.assign(new Error("private synthetic unique value"),
    { code: "ER_DUP_ENTRY", sqlMessage: "private synthetic SQL detail" }); } });
  await assert.rejects(f.db.prepare("INSERT INTO synthetic_fixture(value) VALUES(?)").run("synthetic"),
    (error: unknown) => error instanceof MysqlDatabaseError && error.code === "MYSQL_CONFLICT"
      && !JSON.stringify(error).includes("private synthetic") && !error.message.includes("private synthetic"));
  assert.equal(f.connections(), 1);
});

test("offline MySQL schema verification failure is redacted and prevents application SQL", async () => {
  const f = fixture({ verifyFailure: true });
  await assert.rejects(f.db.prepare("SELECT must_not_execute").get(), unavailable);
  assert.equal(f.trace.includes("SELECT must_not_execute"), false);
  assert.ok(f.trace.includes("END"));
});

test("offline MySQL close failure destroys the connection and does not retry", async () => {
  const f = fixture({ endFailure: true });
  assert.deepEqual(await f.db.prepare("SELECT one_value").get(), { result: "ok" });
  assert.ok(f.trace.includes("DESTROY"));
  assert.equal(f.connections(), 1);
  f.db.close();
  await assert.rejects(f.db.prepare("SELECT must_not_execute").get(), unavailable);
  assert.equal(f.connections(), 1);
});

test("offline MySQL absent or nonlocal configuration fails before any connector or fallback", () => {
  let connections = 0;
  const options = { connect: async () => { connections++; throw new Error("Must not connect"); } };
  assert.throws(() => new MysqlDatabase({ ...config, password: "" }, options));
  assert.throws(() => new MysqlDatabase({ ...config, host: "remote.example.invalid" } as unknown as LocalMysqlConfig, options));
  assert.equal(connections, 0);
});

test("offline MySQL expected constraint failures cannot be confused with privilege or availability failures", async () => {
  for (const [driverCode, expected] of [["ER_DUP_ENTRY", "MYSQL_CONFLICT"], ["ER_NO_REFERENCED_ROW_2", "MYSQL_FOREIGN_KEY"],
    ["ER_ROW_IS_REFERENCED_2", "MYSQL_FOREIGN_KEY"], ["ER_CHECK_CONSTRAINT_VIOLATED", "MYSQL_CHECK"],
    ["ER_SIGNAL_EXCEPTION", "MYSQL_SIGNAL"], ["ER_TABLEACCESS_DENIED_ERROR", "MYSQL_UNAVAILABLE"], ["ECONNRESET", "MYSQL_UNAVAILABLE"]]) {
    const f = fixture({ execute: () => { throw Object.assign(new Error("private synthetic row and account"), { code: driverCode }); } });
    await assert.rejects(f.db.prepare("INSERT INTO synthetic_fixture(value) VALUES(?)").run("private synthetic input"),
      (error: unknown) => error instanceof MysqlDatabaseError && error.code === expected && !JSON.stringify(error).includes("private synthetic"));
  }
});

test("offline MySQL cleanup failure cannot replace a redacted uncertain-commit error", async () => {
  const f = fixture({ commitFailure: true, destroyFailure: true });
  await assert.rejects(f.db.transaction(async () => "synthetic")(), unavailable);
  assert.equal(f.trace.filter((value) => value === "COMMIT").length, 1);
});

test("offline MySQL caps concurrent connections and releases capacity after completion", async () => {
  let release!: () => void, entered!: () => void, opened = 0, executing = 0;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const full = new Promise<void>((resolve) => { entered = resolve; });
  const db = new MysqlDatabase(config, { verify: async () => {}, connect: async () => {
    opened++;
    return {
      async execute() { if (++executing === 16) entered(); await waiting; return [[{ result: "ok" }], []]; },
      async query() { return [[], []]; }, async beginTransaction() {}, async commit() {},
      async rollback() {}, async end() {}, destroy() {},
    };
  } });
  const operations = Array.from({ length: 16 }, () => db.prepare("SELECT synthetic_bounded_work").get());
  await full;
  try { await assert.rejects(db.prepare("SELECT excess_connection").get(), unavailable); }
  finally { release(); }
  await Promise.all(operations);
  assert.equal(opened, 16);
  assert.deepEqual(await db.prepare("SELECT released_capacity").get(), { result: "ok" });
  assert.equal(opened, 17);
});

test("offline MySQL driver settings disable multiple statements/local files and preserve decimals", () => {
  const value = mysqlConnectionOptions(config);
  assert.equal(value.multipleStatements, false);
  assert.equal(value.decimalNumbers, false);
  assert.equal(value.bigNumberStrings, true);
  assert.equal(value.dateStrings, true);
  assert.equal(value.charset, "utf8mb4_bin");
  assert.equal(value.debug, false);
  assert.ok(Array.isArray(value.flags) && value.flags.includes("-LOCAL_FILES"));
  const f = fixture();
  for (const sql of ["DROP TABLE synthetic_fixture", "TRUNCATE TABLE synthetic_fixture", "LOAD DATA LOCAL INFILE ?",
    "SELECT LOAD_FILE(?)", "SELECT value INTO OUTFILE ? FROM synthetic_fixture"]) {
    assert.throws(() => f.db.prepare(sql), unavailable);
  }
  assert.equal(f.connections(), 0);
});
