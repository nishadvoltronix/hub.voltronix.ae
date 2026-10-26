import { readDevelopmentRuntimeMysqlConfig } from "../src/server/config/mysql-runtime";

try {
  readDevelopmentRuntimeMysqlConfig();
  console.log(JSON.stringify({ status: "LOCAL_MYSQL_RUNTIME_CONFIG_VALID", connectionAttempted: false, schemaVerified: false }));
} catch {
  console.error("BLOCKED: the explicitly selected private MySQL runtime profile must select the approved 127.0.0.1:3308 / crm_local_dev development target. The preserved inspector remains the default until CRM_MYSQL_RUNTIME_PROFILE selects .env.mysql.runtime.local. No values were logged and no connection was attempted.");
  process.exitCode = 1;
}
