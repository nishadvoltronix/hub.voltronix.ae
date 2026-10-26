import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectionOptions } from "mysql2/promise";
import { MysqlConfigurationError, parseLocalMysqlConfig, type LocalMysqlConfig } from "../src/server/config/mysql";
import { inspectLocalMysql, LOCAL_MYSQL_TIMEOUT_MS, LocalMysqlInspectionError, type MysqlConnectionFactory, type MysqlInspectionConnection } from "../src/server/db/mysql-local";

const environment = { DATABASE_PROVIDER: "mysql", MYSQL_ENVIRONMENT: "test", MYSQL_HOST: "127.0.0.1", MYSQL_PORT: "3306",
  MYSQL_DATABASE: "crm_isolated_test", MYSQL_USER: "crm_test_user", MYSQL_PASSWORD: " synthetic test password, no real credential " };
const session = { serverVersion: "8.4.8", versionComment: "MySQL Community Server - GPL", selectedDatabase: environment.MYSQL_DATABASE,
  connectionCharset: "utf8mb4", connectionCollation: "utf8mb4_general_ci", sessionTimeZone: "+00:00", autocommit: 1 };
function fixture(responses: unknown[] = [[session], [{ tables: "0", views: "0" }], [{ columns: "0" }], [{ triggers: "0" }]]) {
  const calls: { sql: string; timeout: number; values: string[] }[] = [];
  let connectionOptions: ConnectionOptions | undefined, ended = 0, destroyed = 0;
  const connection: MysqlInspectionConnection = { async execute(query, values) {
    calls.push({ ...query, values }); return [responses[calls.length - 1], []];
  }, async end() { ended++; }, destroy() { destroyed++; } };
  const connect: MysqlConnectionFactory = async (options) => { connectionOptions = options; return connection; };
  return { calls, connection, connect, get options() { return connectionOptions!; }, get ended() { return ended; }, get destroyed() { return destroyed; } };
}
function safeError(error: unknown) {
  assert.ok(error instanceof LocalMysqlInspectionError);
  assert.equal(JSON.stringify(error).includes(environment.MYSQL_PASSWORD), false);
  assert.equal(error.message.includes("synthetic driver secret"), false); return true;
}

test("local MySQL configuration requires an explicit provider/environment/loopback profile and preserves passwords without printing values", () => {
  assert.throws(() => parseLocalMysqlConfig({}), (error: unknown) => {
    assert.ok(error instanceof MysqlConfigurationError); assert.equal(error.fields.length, 7); return true;
  });
  const parsed = parseLocalMysqlConfig(environment);
  assert.equal(parsed.password, environment.MYSQL_PASSWORD);
  assert.equal(parsed.port, 3306);
  assert.equal(parseLocalMysqlConfig({ ...environment, MYSQL_HOST: "::1", MYSQL_ENVIRONMENT: "development" }).host, "::1");
  for (const [field, values] of Object.entries({ DATABASE_PROVIDER: ["sqlite", ""], MYSQL_ENVIRONMENT: ["production", "staging", ""],
    MYSQL_HOST: ["localhost", "127.1", "127.0.0.2", "[::1]", "::ffff:127.0.0.1", "remote.invalid", "127.0.0.1:3306"],
    MYSQL_PORT: ["0", "65536", "-1", "1.5", "03306", "", "synthetic private value"],
    MYSQL_DATABASE: ["mysql", "SYS", "information_schema", "performance_schema", "crm;DROP TABLE users", "../crm", ""],
    MYSQL_USER: ["", "user@remote", "user;sql"], MYSQL_PASSWORD: ["", "nul\0value", "x".repeat(4097)] })) {
    for (const value of values) assert.throws(() => parseLocalMysqlConfig({ ...environment, [field]: value }), (error: unknown) => {
      assert.ok(error instanceof MysqlConfigurationError); assert.deepEqual(error.fields, [field]);
      assert.equal(error.message.includes("synthetic private value"), false); return true;
    });
  }
});

test("inspection uses bounded loopback driver options and parameterized metadata SELECTs without business rows or credentials in output", async () => {
  const f = fixture();
  const result = await inspectLocalMysql(parseLocalMysqlConfig(environment), { connect: f.connect });
  assert.equal(f.ended, 1); assert.equal(f.destroyed, 0);
  assert.equal(f.options.host, "127.0.0.1"); assert.equal(f.options.connectTimeout, LOCAL_MYSQL_TIMEOUT_MS);
  for (const field of ["multipleStatements", "decimalNumbers", "namedPlaceholders", "debug", "trace", "enableKeepAlive"] as const) assert.equal(f.options[field], false);
  for (const field of ["supportBigNumbers", "bigNumberStrings", "dateStrings"] as const) assert.equal(f.options[field], true);
  assert.deepEqual(f.options.flags, ["-LOCAL_FILES"]); assert.equal(f.options.infileStreamFactory, undefined); assert.equal(f.options.socketPath, undefined);
  assert.equal(f.calls.length, 4);
  for (const [index, call] of f.calls.entries()) {
    assert.match(call.sql, /^SELECT\b/); assert.equal(call.timeout, LOCAL_MYSQL_TIMEOUT_MS);
    assert.equal(call.sql.includes(";"), false); assert.deepEqual(call.values, index === 0 ? [] : [environment.MYSQL_DATABASE]);
    assert.equal(call.sql.includes(environment.MYSQL_DATABASE), false);
  }
  assert.deepEqual(result.objectsVisibleToCurrentUser, { tables: "0", views: "0", columns: "0", triggers: "0" });
  assert.equal(result.server.family, "mysql"); assert.equal(result.runtimeReady, false); assert.equal(result.historicalDataVerified, false);
  assert.equal(JSON.stringify(result).includes(environment.MYSQL_PASSWORD), false);
  assert.equal(JSON.stringify(result).includes(environment.MYSQL_USER), false);
});

test("hand-built remote configs and injected driver fields cannot bypass the local profile", async () => {
  let connections = 0;
  const connect: MysqlConnectionFactory = async () => { connections++; throw new Error(); };
  await assert.rejects(inspectLocalMysql({ ...parseLocalMysqlConfig(environment), host: "remote.invalid" } as unknown as LocalMysqlConfig, { connect }), MysqlConfigurationError);
  assert.equal(connections, 0);
  const f = fixture();
  await inspectLocalMysql({ ...parseLocalMysqlConfig(environment), socketPath: "synthetic-ignored", multipleStatements: true } as LocalMysqlConfig, { connect: f.connect });
  assert.equal(f.options.socketPath, undefined); assert.equal(f.options.multipleStatements, false);
});

test("server family and visible metadata counts are reported without certifying MariaDB or historical compatibility", async () => {
  const f = fixture([[{ ...session, serverVersion: "11.8.3-MariaDB", versionComment: "MariaDB Server" }],
    [{ tables: "23", views: "2" }], [{ columns: "314" }], [{ triggers: "8" }]]);
  const result = await inspectLocalMysql(parseLocalMysqlConfig(environment), { connect: f.connect });
  assert.equal(result.server.family, "mariadb"); assert.equal(result.runtimeReady, false);
  assert.equal(result.objectsVisibleToCurrentUser.tables, "23"); assert.equal(result.historicalDataVerified, false);
});

test("wrong selected schema, malformed metadata and impossible counts fail safely and close the connection", async () => {
  for (const responses of [
    [[{ ...session, selectedDatabase: "other_preserved_database" }]],
    [[{ ...session, serverVersion: "synthetic driver secret\nunsafe" }]],
    [[], [{ tables: "0", views: "0" }]],
    [[session], [{ tables: -1, views: "0" }]],
    [[session], [{ tables: "0", views: "0" }], [{ columns: "invalid" }]],
  ]) {
    const f = fixture(responses);
    await assert.rejects(inspectLocalMysql(parseLocalMysqlConfig(environment), { connect: f.connect }), safeError);
    assert.equal(f.destroyed, 1); assert.equal(f.ended, 0);
  }
});

test("connect, query and shutdown failures never expose raw driver or authentication details", async () => {
  await assert.rejects(inspectLocalMysql(parseLocalMysqlConfig(environment), { connect: async () => { throw new Error("synthetic driver secret"); } }), safeError);
  for (const failing of ["execute", "end"] as const) {
    const f = fixture();
    f.connection[failing] = async () => { throw new Error("synthetic driver secret"); };
    await assert.rejects(inspectLocalMysql(parseLocalMysqlConfig(environment), { connect: f.connect }), safeError);
    assert.equal(f.destroyed, 1);
  }
});

test("overall inspection deadline destroys a hung query without issuing another query", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); let queries = 0;
  f.connection.execute = async () => { queries++; return new Promise(() => {}); };
  const pending = inspectLocalMysql(parseLocalMysqlConfig(environment), { connect: f.connect });
  await Promise.resolve(); await Promise.resolve();
  const rejected = assert.rejects(pending, safeError);
  context.mock.timers.tick(LOCAL_MYSQL_TIMEOUT_MS);
  await rejected; assert.equal(queries, 1); assert.equal(f.destroyed, 1); assert.equal(f.ended, 0);
});

test("a connection completing after the overall deadline is destroyed before any SELECT", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); let release: (value: MysqlInspectionConnection) => void = () => { throw new Error(); };
  const connect: MysqlConnectionFactory = () => new Promise((resolve) => { release = resolve; });
  const pending = inspectLocalMysql(parseLocalMysqlConfig(environment), { connect });
  const rejected = assert.rejects(pending, safeError);
  context.mock.timers.tick(LOCAL_MYSQL_TIMEOUT_MS); await rejected;
  release(f.connection); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.destroyed, 1); assert.equal(f.calls.length, 0); assert.equal(f.ended, 0);
});
