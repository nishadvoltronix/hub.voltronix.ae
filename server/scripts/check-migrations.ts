import { mysqlMigrations } from "../src/crm/db/mysql/migrations.js";
import { mysqlMigrations as authenticationMigrations } from "../src/db/mysql/migrations.js";
import { mysqlExpectedIndexes, mysqlExpectedTables, mysqlExpectedTriggers } from "../src/crm/db/mysql/schema.js";

// Offline manifest audit only. The runner deliberately has no apply mode,
// credentials, connector or private profile lookup.
try {
  if (process.argv.length !== 2 || JSON.stringify(mysqlMigrations.slice(0, authenticationMigrations.length)) !== JSON.stringify(authenticationMigrations)
    || mysqlMigrations.some((migration, index) => migration.version !== index + 1)) throw new Error();
  console.log(JSON.stringify({ status: "PASS_OFFLINE_MIGRATION_MANIFEST", migrations: mysqlMigrations.map(migration => ({
    version: migration.version, name: migration.name, statements: migration.statements.length,
  })), applicationTables: mysqlExpectedTables.length - 1, technicalTables: 2,
  expectedIndexes: mysqlExpectedIndexes.length, expectedTriggers: mysqlExpectedTriggers.length,
  foundationLineageMatches: true, databaseConnections: 0, databaseWrites: 0,
  limitation: "Ordered source manifest only. Actual MySQL DDL, idempotence, restore and CRM runtime remain NOT RUN for this extraction." }));
} catch {
  console.error(JSON.stringify({ status: "REFUSED", code: "MIGRATION_MANIFEST", databaseConnections: 0, databaseWrites: 0 }));
  process.exitCode = 1;
}
