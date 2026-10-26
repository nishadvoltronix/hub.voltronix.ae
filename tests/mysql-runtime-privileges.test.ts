import assert from "node:assert/strict";
import test from "node:test";
import { assertMysqlRuntimePrivileges, mysqlRuntimePrivileges, MysqlRuntimePrivilegeError } from "../src/server/db/mysql/runtime-privileges";
import { mysqlExpectedTables } from "../src/server/db/mysql/schema";
import type { MysqlMigrationSession } from "../src/server/db/mysql/migrations";

const schema = "crm_local_dev", recipient = "`synthetic_runtime`@`127.0.0.1`";
const grants = () => ["GRANT USAGE ON *.* TO " + recipient, ...Object.entries(mysqlRuntimePrivileges)
  .map(([table, permissions]) => `GRANT ${permissions.join(", ")} ON \`${schema}\`.\`${table}\` TO ${recipient}`)];
function fixture(lines = grants(), changes: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const connection: MysqlMigrationSession = {
    async execute() { throw new Error("Unexpected mutation/execute"); },
    async query(sql) {
      calls.push(sql);
      return sql === "SHOW GRANTS" ? [lines.map((line) => ({ Grants: line })), []] : [[{ selectedDatabase: schema,
        identity: "synthetic_runtime@127.0.0.1", activeRoles: "NONE", mandatoryRoles: "", version: "8.4.11",
        family: "MySQL Community Server - GPL", port: 3308, ...changes }], []];
    },
  };
  return { connection, calls };
}

test("OFFLINE runtime privilege map covers current tables without DDL, ledger writes or history mutation", () => {
  assert.deepEqual(Object.keys(mysqlRuntimePrivileges).sort(), [...mysqlExpectedTables, "crm_mysql_schema_migrations"].sort());
  for (const [table, rights] of Object.entries(mysqlRuntimePrivileges)) {
    assert.ok(rights.includes("SELECT"));
    assert.ok(rights.every((right) => ["SELECT", "INSERT", "UPDATE", "DELETE"].includes(right)));
    if (table.includes("audit") || table === "crm_department_work_logs") assert.deepEqual(rights, ["SELECT", "INSERT"]);
  }
  assert.deepEqual(mysqlRuntimePrivileges.crm_mysql_schema_migrations, ["SELECT"]);
  assert.deepEqual(mysqlRuntimePrivileges.crm_app_lock, ["SELECT", "UPDATE"]);
});

test("OFFLINE exact runtime grants accept reviewed DML only through read-only statements", async () => {
  const f = fixture(); await assertMysqlRuntimePrivileges(f.connection, schema);
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every((sql) => /^(SELECT|SHOW)/u.test(sql)));
});

test("OFFLINE runtime grants reject missing, extra, global, cross-schema, column, routine, role and delegable privileges", async () => {
  const variants = [grants().slice(0, -1), [...grants(), "GRANT SELECT ON *.* TO " + recipient],
    grants().map((line) => line.includes(".`crm_app_lock`") ? line.replace("SELECT, UPDATE", "SELECT") : line),
    [...grants(), "GRANT `extra_role`@`%` TO " + recipient], [...grants(), "GRANT SYSTEM_USER ON *.* TO " + recipient],
    grants().map((line) => line.replace(" ON `crm_local_dev`.", " ON `other_local_schema`.")),
    grants().map((line) => line.includes(".`users`") ? line + " WITH GRANT OPTION" : line),
    [...grants(), "GRANT SELECT (`password`) ON `crm_local_dev`.`users` TO " + recipient],
    [...grants(), "GRANT EXECUTE ON PROCEDURE `crm_local_dev`.`unexpected` TO " + recipient],
    [...grants(), grants()[1]!], grants().map((line) => line.includes(".`tasks`") ? line.replace("SELECT,", "CREATE, SELECT,") : line)];
  for (const lines of variants) await assert.rejects(assertMysqlRuntimePrivileges(fixture(lines).connection, schema), MysqlRuntimePrivilegeError);
});

test("OFFLINE wrong target, role, product and private driver failures stay redacted", async () => {
  for (const changes of [{ selectedDatabase: "wrong" }, { activeRoles: "extra_role" }, { mandatoryRoles: "unexpected" },
    { version: "8.4.10" }, { family: "MariaDB" }, { port: 3306 }, { identity: "synthetic_runtime@%" }]) {
    await assert.rejects(assertMysqlRuntimePrivileges(fixture(grants(), changes).connection, schema), MysqlRuntimePrivilegeError);
  }
  const f = fixture(); f.connection.query = async () => { throw new Error("private driver and identity detail"); };
  await assert.rejects(assertMysqlRuntimePrivileges(f.connection, schema), (error: unknown) => {
    assert.ok(error instanceof MysqlRuntimePrivilegeError); assert.equal(error.message.includes("private driver"), false); return true;
  });
});
