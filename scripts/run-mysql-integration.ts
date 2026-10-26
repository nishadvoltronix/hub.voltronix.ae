import { spawn } from "node:child_process";
import { liveMysqlAcknowledgements, liveMysqlArguments, liveMysqlBlockedMessage } from "../tests/mysql-integration/guard";

try {
  // No profile is read and no socket opened until the complete explicit contract passes.
  const fixtureRoot = liveMysqlArguments(process.argv.slice(2));
  const child = spawn(process.execPath, ["--import", "tsx", "--test", "tests/mysql-integration/live.test.ts"], {
    cwd: process.cwd(), windowsHide: true, stdio: "inherit",
    env: { ...process.env, CRM_MYSQL_LIVE_TEST_ACK: liveMysqlAcknowledgements.join(" "), CRM_MYSQL_LIVE_TEST_FIXTURE: fixtureRoot },
  });
  child.on("error", () => { console.error(liveMysqlBlockedMessage); process.exitCode = 2; });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
} catch {
  console.error(liveMysqlBlockedMessage);
  process.exitCode = 2;
}
