import assert from "node:assert/strict";
import test from "node:test";
import type { LocalMysqlConfig } from "../src/server/config/mysql";
import { assertMysqlBrowserProfilePair, mysqlBrowserArguments, mysqlBrowserFlags } from "../scripts/mysql-browser-guard";

const fixture = ".local-data/test/mysql-browser-12345678-1234-4234-8234-123456789abc";
const database = "crm_local_browser_12345678123442348234123456789abc";
const operator: LocalMysqlConfig = { provider: "mysql", environment: "test", host: "127.0.0.1", port: 3308,
  database, user: "synthetic_operator", password: "non-secret-operator-fixture" };
const runtime: LocalMysqlConfig = { ...operator, user: "synthetic_runtime", password: "non-secret-runtime-fixture" };

test("MySQL browser guard requires explicit exact opt-ins and a unique owned fixture", () => {
  assert.deepEqual(mysqlBrowserArguments([...mysqlBrowserFlags, "--fixture-root", fixture]), {
    relativeRoot: fixture, fixtureId: "12345678-1234-4234-8234-123456789abc", database,
  });
  for (const args of [[], ["--fixture-root", fixture], [...mysqlBrowserFlags, "--fixture-root", fixture, "--force"],
    [mysqlBrowserFlags[1], mysqlBrowserFlags[0], "--fixture-root", fixture]]) assert.throws(() => mysqlBrowserArguments(args));
});

test("MySQL browser guard rejects original profiles, traversal, non-v4 IDs and reused integration roots", () => {
  for (const path of [".env.mysql.local", ".local-data/test/../development", fixture + "/..", fixture.replace("4234", "1234"),
    fixture.replace("8234", "7234"), fixture.toUpperCase(), fixture.replaceAll("/", "\\"),
    fixture.replace("mysql-browser", "mysql-integration"), "G:/" + fixture]) {
    assert.throws(() => mysqlBrowserArguments([...mysqlBrowserFlags, "--fixture-root", path]));
  }
});

test("MySQL browser profile pair is local, fixture-bound and uses separate application credentials", () => {
  assert.doesNotThrow(() => assertMysqlBrowserProfilePair(operator, runtime, database));
  for (const change of [{ environment: "development" }, { host: "localhost" }, { host: "203.0.113.1" }, { port: 3306 },
    { database: "crm_local_dev" }, { database: "crm_nextjs_development" }, { database: database.slice(0, -1) + "d" }]) {
    assert.throws(() => assertMysqlBrowserProfilePair({ ...operator, ...change } as LocalMysqlConfig, runtime, database));
    assert.throws(() => assertMysqlBrowserProfilePair(operator, { ...runtime, ...change } as LocalMysqlConfig, database));
  }
  assert.throws(() => assertMysqlBrowserProfilePair(operator, { ...runtime, user: operator.user }, database));
  assert.throws(() => assertMysqlBrowserProfilePair(operator, { ...runtime, password: operator.password }, database));
});
