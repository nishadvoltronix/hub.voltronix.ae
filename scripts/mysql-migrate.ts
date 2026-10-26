import { readDevelopmentMigrationMysqlConfig } from "../src/server/config/mysql-runtime";
import { connectMysql, type MysqlWireConnection } from "../src/server/db/mysql/driver";
import { migrateMysqlApplicationSchema } from "../src/server/db/mysql/migrations";

async function main() {
  let connection: MysqlWireConnection | undefined;
  try {
    const config = readDevelopmentMigrationMysqlConfig(process.argv.slice(2));
    connection = await connectMysql(config);
    const applied = await migrateMysqlApplicationSchema(connection, { database: config.database, allowSchemaChanges: true });
    console.log(JSON.stringify({ status: "LOCAL_MYSQL_APPLICATION_SCHEMA", applied, importedRecords: 0 }));
  } catch {
    console.error("BLOCKED/FAILED: MySQL application-schema migration requires --approve-local-application-schema --profile .env.mysql.migration.local, reviewed local DDL approval, a separate migration identity and an approved empty application schema/current ledger. MySQL DDL implicitly commits; interrupted changes require operator review. No automatic recovery, import, database creation or server start is performed.");
    process.exitCode = 1;
  } finally {
    if (connection) try { await connection.end(); } catch {
      try { connection.destroy(); } catch { /* Driver cleanup errors remain redacted. */ }
    }
  }
}
void main();
