import assert from "node:assert/strict";
import test from "node:test";
import { parseLocalMysqlConfig, validateLocalMysqlConfig, type LocalMysqlConfig } from "../src/crm/config/mysql.js";
import { mysqlConnectionOptions, type MysqlWireConnection } from "../src/crm/db/mysql/driver.js";
import type { MysqlMigrationSession } from "../src/crm/db/mysql/migrations.js";
import { migrationAcknowledgement, MysqlOperatorError, mysqlMigrationPrivileges, parseMysqlOperatorArguments,
  runMysqlOperator, validateMysqlOperatorProfile, verifyMysqlOperator } from "../src/operations/mysql-command.js";

// OFFLINE doubles only. No sockets, database, private profile or credentials.
const timestamp = Date.parse("2026-10-14T12:00:00.000Z");
const candidate = () => ({ version: 1, mysql: { provider: "mysql" as const, environment: "production" as const, host: "127.0.0.1" as const,
  port: 3306, database: "synthetic_target", user: "synthetic_migration", password: "offline-only-placeholder" }, runtimeUser: "synthetic_runtime",
  approval: { approved: true, reference: "synthetic approval only", validFrom: "2026-10-14T11:00:00.000Z", validUntil: "2026-10-14T13:00:00.000Z",
    serverUuid: "12345678-1234-4234-8234-123456789abc", exclusiveOperatorWindow: true, schemaChanges: true,
    backupReference: "synthetic backup receipt", rollbackPlanReference: "synthetic rollback plan" } });
const grants = () => ["GRANT USAGE ON *.* TO `synthetic_migration`@`127.0.0.1`",
  `GRANT ${mysqlMigrationPrivileges.join(", ")} ON \`synthetic_target\`.* TO \`synthetic_migration\`@\`127.0.0.1\``];
function wire(changes: Record<string, unknown> = {}, grantLines = grants()) {
  const calls: string[] = [];
  const connection: MysqlWireConnection = {
    async query(sql) {
      calls.push(sql);
      if (sql === "SHOW GRANTS") return [grantLines.map(value => ({ grant: value })), []];
      assert.match(sql, /^SELECT DATABASE\(\)/);
      return [[{ selectedDatabase: "synthetic_target", identity: "synthetic_migration@127.0.0.1",
        serverUuid: candidate().approval.serverUuid, version: "8.4.11", family: "MySQL Community Server - GPL", port: 3306,
        activeRoles: "NONE", mandatoryRoles: "", partialRevokes: 1, binaryLog: 1, trustedCreators: 1,
        autocommit: 1, foreignKeyChecks: 1, uniqueChecks: 1, ...changes }], []];
    },
    async execute() { throw new Error("Unexpected fake SQL"); },
    async beginTransaction() { throw new Error("Unexpected transaction"); }, async commit() { throw new Error("Unexpected commit"); },
    async rollback() { throw new Error("Unexpected fictitious rollback"); }, async end() { calls.push("END"); }, destroy() { calls.push("DESTROY"); },
  };
  return { calls, connection };
}
test("OFFLINE production MySQL uses explicit loopback ports and non-system least-privilege identities", () => {
  for (const port of [3306, 3308]) {
    const config = validateLocalMysqlConfig({ ...candidate().mysql, port });
    const options = mysqlConnectionOptions(config);
    assert.equal(options.host, "127.0.0.1"); assert.equal(options.port, port); assert.equal(options.multipleStatements, false);
    assert.equal(options.debug, false); assert.equal(options.trace, false); assert.equal(options.ssl, undefined);
  }
  for (const change of [{ host: "localhost" }, { host: "::1" }, { host: "external.invalid" }, { port: 3307 },
    { database: "mysql" }, { database: "Uppercase" }, { user: "root" }, { user: "mysql.session" }, { password: "" }]) {
    assert.throws(() => validateLocalMysqlConfig({ ...candidate().mysql, ...change } as LocalMysqlConfig));
  }
  assert.equal(parseLocalMysqlConfig({ DATABASE_PROVIDER: "mysql", MYSQL_ENVIRONMENT: "test", MYSQL_HOST: "::1", MYSQL_PORT: "3308",
    MYSQL_DATABASE: "crm_local_test", MYSQL_USER: "synthetic_test", MYSQL_PASSWORD: "offline-only" }).environment, "test");
});
test("OFFLINE operator requires exact command and explicit retained-DDL acknowledgement", () => {
  assert.equal(parseMysqlOperatorArguments(["inspect"]), "inspect");
  assert.equal(parseMysqlOperatorArguments(["migrate", migrationAcknowledgement]), "migrate");
  for (const input of [[], ["migrate"], ["inspect", migrationAcknowledgement], ["reset"], ["migrate", migrationAcknowledgement, "--force"], ["inspect", "--password=x"]]) {
    assert.throws(() => parseMysqlOperatorArguments(input), MysqlOperatorError);
  }
});
test("OFFLINE migration profile requires distinct identity, bounded actual approval and recovery references", () => {
  assert.equal(validateMysqlOperatorProfile(candidate(), timestamp).mysql.port, 3306);
  for (const mutate of [
    (value: ReturnType<typeof candidate>) => { value.runtimeUser = value.mysql.user; },
    (value: ReturnType<typeof candidate>) => { value.approval.approved = false; },
    (value: ReturnType<typeof candidate>) => { value.approval.schemaChanges = false; },
    (value: ReturnType<typeof candidate>) => { value.approval.exclusiveOperatorWindow = false; },
    (value: ReturnType<typeof candidate>) => { value.approval.validUntil = "2026-10-14T12:00:00.000Z"; },
    (value: ReturnType<typeof candidate>) => { value.approval.validUntil = "2026-10-16T12:00:00.000Z"; },
    (value: ReturnType<typeof candidate>) => { value.approval.validFrom = "2026-10-14T12:01:00.000Z"; },
    (value: ReturnType<typeof candidate>) => { value.approval.backupReference = ""; },
    (value: ReturnType<typeof candidate>) => { value.approval.rollbackPlanReference = ""; },
  ]) {
    const value = candidate(); mutate(value); assert.throws(() => validateMysqlOperatorProfile(value, timestamp), MysqlOperatorError);
  }
  assert.throws(() => validateMysqlOperatorProfile({ ...candidate(), fallback: true }, timestamp), MysqlOperatorError);
});
test("OFFLINE migration identity observes exact version UUID port roles schema and limited direct grants", async () => {
  const profile = validateMysqlOperatorProfile(candidate(), timestamp), f = wire();
  await verifyMysqlOperator(f.connection, profile);
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(value => /^(SELECT|SHOW) /.test(value)));
  for (const changes of [{ identity: "root@localhost" }, { port: 3308 }, { version: "8.4.10" }, { family: "MariaDB" },
    { serverUuid: "wrong" }, { selectedDatabase: "wrong" }, { activeRoles: "unreviewed" }, { mandatoryRoles: "role" },
    { partialRevokes: 0 }, { foreignKeyChecks: 0 }, { uniqueChecks: 0 }, { autocommit: 0 }, { trustedCreators: 0 }]) {
    await assert.rejects(verifyMysqlOperator(wire(changes).connection, profile), MysqlOperatorError);
  }
  await verifyMysqlOperator(wire({ binaryLog: 0, trustedCreators: 0 }).connection, profile);
  for (const lines of [[], grants().slice(0, 1), [...grants(), grants()[1]!], [...grants(), "GRANT SYSTEM_USER ON *.* TO `synthetic_migration`@`127.0.0.1`"],
    grants().map(value => value.replace("SELECT,", "DELETE, SELECT,")), grants().map(value => value + " WITH GRANT OPTION"),
    grants().map(value => value.replace("`synthetic_target`", "`other_schema`")), [...grants(), "GRANT `role`@`%` TO `synthetic_migration`@`127.0.0.1`"]]) {
    await assert.rejects(verifyMysqlOperator(wire({}, lines).connection, profile), MysqlOperatorError);
  }
});
test("OFFLINE inspect connects once, verifies identity and schema without application or migration writes", async () => {
  const f = wire(); let connections = 0;
  const result = await runMysqlOperator(["inspect"], candidate(), { now: () => timestamp, connect: async () => { connections++; return f.connection; },
    inspect: async (_, schema) => { assert.equal(schema, "synthetic_target"); f.calls.push("READ_SCHEMA"); return { installed: 1, pending: 2 }; },
    migrate: async () => { assert.fail("Read-only inspect cannot migrate"); } });
  assert.deepEqual(result, { status: "PASS_READ_ONLY_TARGET_INSPECTION", installed: 1, pending: 2, migrationsApplied: 0 });
  assert.equal(connections, 1); assert.equal(f.calls.at(-1), "END");
});
test("OFFLINE operator refuses arguments/profile/identity/schema before DDL and redacts private failure", async () => {
  let opened = 0, migrated = 0;
  const options = { now: () => timestamp, connect: async () => { opened++; return wire({ serverUuid: "wrong" }).connection; },
    inspect: async () => ({ installed: 0, pending: 3 }), migrate: async () => { migrated++; return 3; } };
  await assert.rejects(runMysqlOperator(["migrate"], candidate(), options), MysqlOperatorError);
  await assert.rejects(runMysqlOperator(["inspect"], {}, options), MysqlOperatorError);
  assert.equal(opened, 0);
  await assert.rejects(runMysqlOperator(["migrate", migrationAcknowledgement], candidate(), options), MysqlOperatorError);
  assert.equal(migrated, 0);
  const f = wire();
  await assert.rejects(runMysqlOperator(["migrate", migrationAcknowledgement], candidate(), { ...options, connect: async () => f.connection,
    inspect: async () => { throw new Error("private connection detail"); } }), error => {
    assert.ok(error instanceof MysqlOperatorError); assert.equal(error.stage, "SCHEMA"); assert.doesNotMatch(error.message, /private connection detail/); return true;
  });
  assert.equal(migrated, 0); assert.equal(f.calls.at(-1), "END");
});
test("OFFLINE explicit migration uses existing engine and verifies current schema; uncertain DDL is never retried or rolled back", async () => {
  const f = wire(); let inspections = 0, applications = 0;
  const options = { now: () => timestamp, connect: async () => f.connection,
    inspect: async () => ++inspections === 1 ? { installed: 1, pending: 2 } : { installed: 3, pending: 0 },
    migrate: async (_: MysqlMigrationSession, input: { database: string; allowSchemaChanges: true }) => {
      applications++; assert.deepEqual(input, { database: "synthetic_target", allowSchemaChanges: true }); return 2;
    } };
  const result = await runMysqlOperator(["migrate", migrationAcknowledgement], candidate(), options);
  assert.equal(result.migrationsApplied, 2); assert.equal(applications, 1); assert.equal(inspections, 2);
  await assert.rejects(runMysqlOperator(["migrate", migrationAcknowledgement], candidate(), { ...options,
    migrate: async () => { applications++; throw new Error("private partial DDL"); } }), error => {
    assert.ok(error instanceof MysqlOperatorError); assert.equal(error.stage, "MIGRATION"); assert.doesNotMatch(error.message, /private partial DDL/); return true;
  });
  assert.equal(applications, 2); assert.equal(f.calls.filter(value => value === "END").length, 2);
});
test("OFFLINE expiry between migration statements refuses further work and shutdown errors cannot claim success", async () => {
  const f = wire(); let now = timestamp;
  await assert.rejects(runMysqlOperator(["migrate", migrationAcknowledgement], candidate(), { now: () => now, connect: async () => f.connection,
    inspect: async () => ({ installed: 0, pending: 3 }), migrate: async connection => {
      now = Date.parse(candidate().approval.validUntil); await connection.query("CREATE TABLE must_not_execute (id INT)"); return 3;
    } }), MysqlOperatorError);
  assert.ok(f.calls.every(sql => !sql.startsWith("CREATE")));
  f.connection.end = async () => { throw new Error("private shutdown detail"); };
  await assert.rejects(runMysqlOperator(["inspect"], candidate(), { now: () => timestamp, connect: async () => f.connection,
    inspect: async () => ({ installed: 3, pending: 0 }) }), MysqlOperatorError);
  assert.equal(f.calls.at(-1), "DESTROY");
});
