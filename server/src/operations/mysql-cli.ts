import { fileURLToPath } from "node:url";
import { readPrivateMigrationProfile } from "../runtime/private-profile.js";
import { migrationProfilePath, MysqlOperatorError, parseMysqlOperatorArguments, runMysqlOperator } from "./mysql-command.js";

// No dotenv loader: neither API runtime selection nor an ambient credential may
// redirect this command. One fixed private migration identity is mandatory.
try {
  parseMysqlOperatorArguments(process.argv.slice(2));
  for (const key of ["NODE_DEBUG", "NODE_DEBUG_NATIVE", "DEBUG", "PWDEBUG", "NODE_OPTIONS"]) {
    if (process.env[key]?.trim()) throw new MysqlOperatorError("CONFIGURATION");
  }
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  const profile = readPrivateMigrationProfile(packageRoot, migrationProfilePath);
  console.log(JSON.stringify(await runMysqlOperator(process.argv.slice(2), profile)));
} catch (error) {
  console.error(JSON.stringify({ status: "REFUSED", stage: error instanceof MysqlOperatorError ? error.stage : "CONFIGURATION",
    message: "Stop and retain the target. No automatic provision, import, retry or rollback. Check private approval, exact target identity, grants, backups and schema lineage." }));
  process.exitCode = 1;
}
