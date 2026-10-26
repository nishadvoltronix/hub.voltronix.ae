import "server-only";
import { readRuntimeMysqlConfig } from "../config/mysql-runtime";
import { MysqlDatabase } from "./mysql/database";
import { assertMysqlMigrationsCurrent } from "./mysql/migrations";
import { assertMysqlRuntimePrivileges } from "./mysql/runtime-privileges";
import { requireNextDatabase } from "../config/frontend-backend";

const runtime = globalThis as typeof globalThis & { crmMysqlDatabase?: MysqlDatabase };

/** Lazy MySQL-only runtime. Never migrates, seeds, starts a server or opens SQLite. */
export function getDatabase(): MysqlDatabase {
  requireNextDatabase(process.env);
  if (!runtime.crmMysqlDatabase) runtime.crmMysqlDatabase = new MysqlDatabase(readRuntimeMysqlConfig(), {
    verify: async (connection, database) => {
      await assertMysqlRuntimePrivileges(connection, database);
      await assertMysqlMigrationsCurrent(connection, database);
    },
  });
  return runtime.crmMysqlDatabase;
}
