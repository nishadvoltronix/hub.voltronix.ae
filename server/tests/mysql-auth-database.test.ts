import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { AuthError, authFailure } from "../src/auth/errors.js";
import { createMysqlAuthentication } from "../src/auth/mysql.js";
import { MysqlAuthDatabaseError, validateMysqlAuthConfig } from "../src/db/mysql/config.js";
import { createMysqlAuthDatabase, type MysqlAuthSqlTransaction } from "../src/db/mysql/database.js";
import { connectMysqlAuth, mysqlAuthConnectionOptions, mysqlAuthParameters, type MysqlAuthWireConnection } from "../src/db/mysql/driver.js";

// Synthetic configuration only; no profile is read and no real connector is used.
const config = { provider: "mysql", environment: "test", host: "127.0.0.1", port: 3308,
  database: "crm_local_auth_0123456789ab4def8123456789abcdef", user: "synthetic_auth", password: "synthetic-test-only" } as const;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function wire(overrides: Partial<MysqlAuthWireConnection> = {}) {
  const events: string[] = [];
  const connection: MysqlAuthWireConnection = {
    async query(sql) { events.push(sql); return [[], []]; },
    async execute(sql) { events.push(sql); return sql.includes("crm_app_lock") ? [[{ id: "1" }], []] : [[], []]; },
    async beginTransaction() { events.push("begin"); }, async commit() { events.push("commit"); },
    async rollback() { events.push("rollback"); }, async end() { events.push("end"); },
    destroy() { events.push("destroy"); }, ...overrides,
  };
  return { connection, events };
}
function database(fixture = wire()) {
  const calls: string[] = [];
  const db = createMysqlAuthDatabase(config, {
    connect: async selected => { assert.deepEqual(selected, config); calls.push("connect"); return fixture.connection; },
    verify: async (connection, selected) => { assert.equal(connection, fixture.connection); assert.deepEqual(selected, config); calls.push("verify"); },
  });
  return { db, calls, ...fixture };
}

test("MySQL auth configuration is explicit, frozen, exact loopback/8.4 target family, with no driver overrides", () => {
  assert.ok(Object.isFrozen(validateMysqlAuthConfig(config)));
  assert.equal(validateMysqlAuthConfig({ ...config, environment: "development", database: "crm_local_dev" }).database, "crm_local_dev");
  for (const patch of [
    { provider: "sqlite" }, { host: "localhost" }, { host: "::1" }, { host: "example.invalid" }, { port: 3306 },
    { environment: "production" }, { environment: "development" }, { database: "crm_local_dev" },
    { database: "crm_local_auth_0123456789ab1def8123456789abcdef" }, { database: "crm_nextjs_development" },
    { database: "mysql" }, { database: "crm_local_browser_0123456789ab4def8123456789abcdef" },
    { user: "invalid@user" }, { password: "" }, { password: "x\0y" }, { password: "😀".repeat(1100) },
    { socketPath: "synthetic.sock" }, { multipleStatements: true },
  ]) assert.throws(() => validateMysqlAuthConfig({ ...config, ...patch }), MysqlAuthDatabaseError);
  assert.throws(() => validateMysqlAuthConfig({ get provider() { throw new Error("synthetic-private-value"); } }),
    error => error instanceof MysqlAuthDatabaseError && !error.message.includes("private-value"));
});

test("driver options disable multiple statements/local files/debug and retain exact numbers", () => {
  const options = mysqlAuthConnectionOptions(config);
  assert.equal(options.host, "127.0.0.1"); assert.equal(options.port, 3308);
  assert.equal(options.multipleStatements, false); assert.equal(options.namedPlaceholders, false);
  assert.equal(options.supportBigNumbers, true); assert.equal(options.bigNumberStrings, true);
  assert.equal(options.decimalNumbers, false); assert.equal(options.dateStrings, true);
  assert.equal(options.debug, false); assert.equal(options.trace, false);
  assert.deepEqual(options.flags, ["-LOCAL_FILES", "-FOUND_ROWS"]);
  assert.equal(options.charset, "utf8mb4_bin"); assert.equal(options.timezone, "Z");
  assert.equal(options.socketPath, undefined); assert.equal(options.infileStreamFactory, undefined);
  assert.equal(mysqlAuthParameters(["9007199254740993"])[0], "9007199254740993");
  assert.equal(mysqlAuthParameters([null])[0], null);
  assert.doesNotThrow(() => mysqlAuthParameters([0, Number.MAX_SAFE_INTEGER, -1]));
  for (const value of [Number.MAX_SAFE_INTEGER + 1, 0.5, NaN, Infinity, {}, true, undefined, 1n]) {
    assert.throws(() => mysqlAuthParameters([value]), MysqlAuthDatabaseError);
  }
});

test("explicit composition constructs without connecting, reading profiles or selecting a fixture", async () => {
  const composition = createMysqlAuthentication(config);
  assert.equal(await composition.auth.authenticate("bad-token"), null);
  await composition.close();
  assert.throws(() => createMysqlAuthentication(undefined), MysqlAuthDatabaseError);
});

test("network-disabled guard refuses the real connector before any handshake", async () => {
  const previous = process.env.CRM_MYSQL_NETWORK_DISABLED;
  process.env.CRM_MYSQL_NETWORK_DISABLED = "1";
  try { await assert.rejects(connectMysqlAuth(config), MysqlAuthDatabaseError); }
  finally { if (previous === undefined) delete process.env.CRM_MYSQL_NETWORK_DISABLED; else process.env.CRM_MYSQL_NETWORK_DISABLED = previous; }
});

test("each auth callback gets a fresh verified connection, strict session, shared lock and one commit", async () => {
  const fixtures = [wire(), wire()]; let opens = 0, verifies = 0;
  const db = createMysqlAuthDatabase(config, { connect: async () => fixtures[opens++]!.connection,
    verify: async connection => { verifies++; assert.ok(fixtures.some(item => item.connection === connection)); } });
  for (let index = 0; index < 2; index++) {
    assert.equal(await db.transaction(async tx => { await tx.execute("SELECT id FROM users WHERE email=?", ["synthetic@example.invalid"]); return 7; }), 7);
  }
  assert.equal(opens, 2); assert.equal(verifies, 2);
  for (const { events } of fixtures) {
    assert.ok(events.includes("SET SESSION foreign_key_checks = 1"));
    assert.ok(events.includes("SET SESSION unique_checks = 1"));
    assert.ok(events.includes("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ"));
    assert.deepEqual(events.slice(-5), ["begin", "SELECT id FROM crm_app_lock WHERE id=1 FOR UPDATE", "SELECT id FROM users WHERE email=?", "commit", "end"]);
  }
  await db.close();
});

test("placeholder values reach only execute, never query or concatenated SQL", async () => {
  const captured: { sql: string; values: readonly unknown[] }[] = [];
  const fixture = wire({ async execute(sql, values = []) {
    captured.push({ sql, values }); return sql.includes("crm_app_lock") ? [[{ id: 1 }], []] : [[], []];
  } });
  const { db } = database(fixture);
  const hostile = "' OR 1=1; -- synthetic";
  await db.transaction(tx => tx.execute("SELECT id FROM users WHERE email=?", [hostile]));
  assert.equal(captured[1]!.sql, "SELECT id FROM users WHERE email=?");
  assert.deepEqual(captured[1]!.values, [hostile]);
  assert.ok(!fixture.events.some(event => event.includes(hostile))); await db.close();
});

test("safe callback authentication refusal rolls back and preserves canonical auth status", async () => {
  const { db, events } = database();
  await assert.rejects(db.transaction(async () => { throw new AuthError("credentials"); }), error => authFailure(error).status === 401);
  assert.deepEqual(events.slice(-2), ["rollback", "end"]); assert.ok(!events.includes("commit")); await db.close();
});

test("callback/driver failures are redacted and never automatically replayed", async () => {
  let attempts = 0;
  const fixture = wire({ async execute(sql) {
    if (sql.includes("crm_app_lock")) return [[{ id: 1 }], []];
    attempts++; throw new Error("synthetic-secret SQL details");
  } });
  const { db, events } = database(fixture);
  await assert.rejects(db.transaction(tx => tx.execute("SELECT id FROM users WHERE email=?", ["x"])),
    error => error instanceof MysqlAuthDatabaseError && !error.message.includes("synthetic-secret"));
  assert.equal(attempts, 1); assert.ok(events.includes("rollback")); assert.ok(!events.includes("commit")); await db.close();
});

test("caught statement failure poisons the callback instead of committing partial state", async () => {
  const fixture = wire({ async execute(sql) { if (sql.includes("crm_app_lock")) return [[{ id: 1 }], []]; throw new Error("synthetic failure"); } });
  const { db, events } = database(fixture);
  await assert.rejects(db.transaction(async tx => { try { await tx.execute("DELETE FROM crm_sessions WHERE token_hash=?", ["x"]); } catch { /* caller cannot recover this lease */ } }), MysqlAuthDatabaseError);
  assert.ok(events.includes("rollback")); assert.ok(!events.includes("commit")); await db.close();
});

test("wrong metadata, unsafe setup or absent/invalid singleton refuse callback before mutation", async () => {
  for (const lock of [[], [{ id: 2 }], [{ id: 1 }, { id: 1 }], [{}]]) {
    const fixture = wire({ async execute() { return [lock, []]; } }); const { db } = database(fixture);
    let called = false;
    await assert.rejects(db.transaction(async () => { called = true; }), MysqlAuthDatabaseError);
    assert.equal(called, false); await db.close();
  }
  for (const phase of ["verify", "setup", "begin"] as const) {
    const fixture = wire(phase === "setup" ? { async query() { throw new Error("private"); } }
      : phase === "begin" ? { async beginTransaction() { throw new Error("private"); } } : {});
    const db = createMysqlAuthDatabase(config, { connect: async () => fixture.connection,
      verify: async () => { if (phase === "verify") throw new Error("private"); } });
    let called = false; await assert.rejects(db.transaction(async () => { called = true; }), MysqlAuthDatabaseError);
    assert.equal(called, false); assert.ok(fixture.events.includes("destroy")); await db.close();
  }
});

test("outage fails closed; a later explicit request opens again without replaying failed work", async () => {
  const fixture = wire(); let opens = 0, operations = 0;
  const db = createMysqlAuthDatabase(config, { connect: async () => { if (++opens === 1) throw new Error("private endpoint"); return fixture.connection; }, verify: async () => {} });
  await assert.rejects(db.transaction(async () => { operations++; }), MysqlAuthDatabaseError);
  await db.transaction(async () => { operations++; });
  assert.equal(opens, 2); assert.equal(operations, 1); await db.close();
});

test("commit acknowledgement loss destroys uncertain connection without rollback or automatic replay", async () => {
  const fixture = wire({ async commit() { fixture.events.push("commit-uncertain"); throw new Error("private"); } });
  const { db, calls, events } = database(fixture);
  await assert.rejects(db.transaction(async () => 1), MysqlAuthDatabaseError);
  assert.equal(calls.filter(value => value === "connect").length, 1);
  assert.ok(events.includes("destroy")); assert.ok(!events.includes("rollback")); await db.close();
});

test("rollback failure destroys the connection and does not expose wire errors", async () => {
  const fixture = wire({ async rollback() { throw new Error("private rollback"); } });
  const { db, events } = database(fixture);
  await assert.rejects(db.transaction(async () => { throw new Error("private callback"); }), MysqlAuthDatabaseError);
  assert.ok(events.includes("destroy")); assert.ok(!events.includes("commit")); await db.close();
});

test("nested auth transactions, including caught misuse, cannot commit", async () => {
  const { db, events } = database();
  await assert.rejects(db.transaction(async () => { await assert.rejects(db.transaction(async () => 1), MysqlAuthDatabaseError); }), MysqlAuthDatabaseError);
  assert.ok(events.includes("rollback")); assert.ok(!events.includes("commit")); await db.close();
});

test("escaped transaction handles and detached inherited contexts cannot borrow new connections", async () => {
  const { db, calls } = database(); let escaped: MysqlAuthSqlTransaction | undefined;
  const later = deferred<void>(); let detached: Promise<void> | undefined;
  await db.transaction(async tx => {
    escaped = tx;
    detached = (async () => { await later.promise; await assert.rejects(db.transaction(async () => {}), MysqlAuthDatabaseError); })();
  });
  await assert.rejects(escaped!.execute("SELECT id FROM users"), MysqlAuthDatabaseError);
  later.resolve(); await detached;
  assert.equal(calls.filter(value => value === "connect").length, 1); await db.close();
});

test("unawaited SQL and sibling executes fail rather than escape transaction ownership", async () => {
  for (const parallel of [false, true]) {
    const pending = deferred<[unknown, unknown]>();
    const fixture = wire({ async execute(sql) { return sql.includes("crm_app_lock") ? [[{ id: 1 }], []] : pending.promise; } });
    const { db, events } = database(fixture);
    await assert.rejects(db.transaction(async tx => {
      void tx.execute("SELECT id FROM users");
      if (parallel) await assert.rejects(tx.execute("SELECT id FROM permissions"), MysqlAuthDatabaseError);
    }), MysqlAuthDatabaseError);
    pending.resolve([[], []]); await tick();
    assert.ok(events.includes("destroy")); assert.ok(!events.includes("commit")); await db.close();
  }
});

test("auth SQL boundary refuses DDL, transaction commands, files and multiple statements", async () => {
  for (const sql of ["DROP TABLE users", "COMMIT", "CREATE TABLE synthetic(x INT)", "SELECT 1; DELETE FROM users", "SELECT LOAD_FILE(?)", "SELECT id INTO OUTFILE 'x' FROM users"]) {
    const { db, events } = database();
    await assert.rejects(db.transaction(tx => tx.execute(sql)), MysqlAuthDatabaseError);
    assert.ok(!events.includes(sql)); assert.ok(!events.includes("commit")); await db.close();
  }
});

test("bounded capacity rejects without queuing and releases slots after acquisition failure", async () => {
  const gate = deferred<MysqlAuthWireConnection>(); let opens = 0;
  const db = createMysqlAuthDatabase(config, { connect: () => { opens++; return gate.promise; }, verify: async () => {} });
  const active = Array.from({ length: 16 }, () => db.transaction(async () => 1));
  const observed = active.map(promise => assert.rejects(promise, MysqlAuthDatabaseError));
  await tick(); assert.equal(opens, 16);
  await assert.rejects(db.transaction(async () => 1), MysqlAuthDatabaseError); assert.equal(opens, 16);
  gate.reject(new Error("synthetic acquisition failed")); await Promise.all(observed);
  await assert.rejects(db.transaction(async () => 1), MysqlAuthDatabaseError); assert.equal(opens, 17);
  await db.close();
});

test("close rejects new work, drains acknowledged transaction and is idempotent", async () => {
  const { db, events } = database(); const gate = deferred<void>(); const entered = deferred<void>();
  const work = db.transaction(async () => { entered.resolve(); await gate.promise; return 9; });
  await entered.promise;
  const stopping = db.close(); assert.equal(db.close(), stopping);
  await assert.rejects(db.transaction(async () => 1), MysqlAuthDatabaseError);
  gate.resolve(); assert.equal(await work, 9); await stopping;
  assert.ok(events.includes("commit")); assert.ok(!events.includes("destroy"));
});

test("close deadline destroys stalled owned connections and never commits late callback work", async () => {
  const { db, events } = database(); const gate = deferred<void>(); const entered = deferred<void>();
  const work = db.transaction(async tx => { entered.resolve(); await gate.promise; await tx.execute("SELECT id FROM users"); });
  const outcome = assert.rejects(work, MysqlAuthDatabaseError); await entered.promise;
  await db.close(15); await outcome; gate.resolve(); await tick();
  assert.ok(events.includes("destroy")); assert.ok(!events.includes("commit")); assert.ok(!events.includes("SELECT id FROM users"));
});

test("close during connection acquisition destroys any socket returned after the deadline", async () => {
  const gate = deferred<MysqlAuthWireConnection>(); const fixture = wire();
  const db = createMysqlAuthDatabase(config, { connect: () => gate.promise, verify: async () => {} });
  const work = assert.rejects(db.transaction(async () => 1), MysqlAuthDatabaseError);
  await tick(); await db.close(15); await work;
  gate.resolve(fixture.connection); await tick();
  assert.deepEqual(fixture.events, ["destroy"]);
});

test("invalid drain limits cannot close an open facade", async () => {
  const { db } = database();
  for (const value of [0, -1, 5001, NaN, 1.1]) await assert.rejects(db.close(value), MysqlAuthDatabaseError);
  assert.equal(await db.transaction(async () => 1), 1); await db.close();
});
