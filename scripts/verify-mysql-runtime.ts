import { readDevelopmentRuntimeMysqlConfig } from "../src/server/config/mysql-runtime";
import { connectMysql, type MysqlWireConnection } from "../src/server/db/mysql/driver";
import { assertMysqlMigrationsCurrent } from "../src/server/db/mysql/migrations";
import { assertMysqlRuntimePrivileges, mysqlRuntimePrivileges } from "../src/server/db/mysql/runtime-privileges";

async function main() {
  let connection: MysqlWireConnection | undefined;
  try {
    if (process.argv.slice(2).join(" ") !== "--verify-local-runtime" ||
        process.env.CRM_MYSQL_RUNTIME_PROFILE !== ".env.mysql.runtime.local") throw new Error();
    const config = readDevelopmentRuntimeMysqlConfig();
    connection = await connectMysql(config);
    await assertMysqlRuntimePrivileges(connection, config.database);
    await assertMysqlMigrationsCurrent(connection, config.database);
    await connection.end(); connection = undefined;
    console.log(JSON.stringify({ status: "PASS_READ_ONLY_LOCAL_MYSQL_RUNTIME", version: "8.4.11",
      verifiedTableGrantSets: Object.keys(mysqlRuntimePrivileges).length, schemaCurrent: true,
      mutations: 0, profilesChanged: false, applicationWorkflowsVerified: false, stagingVerified: false }));
  } catch {
    console.error("BLOCKED/FAILED: explicitly select the separate development runtime profile and --verify-local-runtime after approved standalone startup. Target, schema and exact runtime permissions must pass; no fallback or grant changes were attempted.");
    process.exitCode = 2;
  } finally {
    if (connection) try { await connection.end(); }
    catch { try { connection.destroy(); } catch { /* Never expose driver cleanup details. */ } process.exitCode = 2; }
  }
}
void main();
