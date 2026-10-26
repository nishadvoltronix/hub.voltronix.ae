import nextEnvironment from "@next/env";
import { createDevelopmentUser, DevelopmentUserError } from "../src/server/auth/provision";
import { readDevelopmentRuntimeMysqlConfig } from "../src/server/config/mysql-runtime";
import { MysqlDatabase } from "../src/server/db/mysql/database";
import { assertMysqlMigrationsCurrent } from "../src/server/db/mysql/migrations";
import { assertMysqlRuntimePrivileges } from "../src/server/db/mysql/runtime-privileges";

const { loadEnvConfig } = nextEnvironment;

async function main() {
  let db: MysqlDatabase | undefined;
  try {
    loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
    if (process.argv.slice(2).join(" ") !== "--approve-local-user") throw new DevelopmentUserError("Explicit local user provisioning approval is required.");
    const config = readDevelopmentRuntimeMysqlConfig();
    if (config.environment !== "development") throw new DevelopmentUserError();
    db = new MysqlDatabase(config, { verify: async (connection, database) => {
      await assertMysqlRuntimePrivileges(connection, database);
      await assertMysqlMigrationsCurrent(connection, database);
    } });
    await createDevelopmentUser(db, {
      environment: config.environment,
      email: process.env.DEV_USER_EMAIL,
      name: process.env.DEV_USER_NAME,
      password: process.env.DEV_USER_PASSWORD,
      externalUserId: process.env.DEV_USER_EXTERNAL_ID || undefined,
      permissions: process.env.DEV_USER_PERMISSIONS === undefined ? undefined :
        process.env.DEV_USER_PERMISSIONS.split(",").map((key) => key.trim()).filter(Boolean),
    });
    console.log("Explicit development account created. No existing account or CRM record was modified.");
  } catch (error: unknown) {
    console.error(error instanceof DevelopmentUserError
      ? error.message : "Development account creation failed. Check local configuration and migrations.");
    process.exitCode = 1;
  } finally {
    db?.close();
    delete process.env.DEV_USER_PASSWORD;
  }
}

void main();
