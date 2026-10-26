import { fileURLToPath } from "node:url";
import { HarnessRefusal } from "./mysql-auth/guard.js";
import { CrmDemoRefusal } from "./crm-demo/guard.js";
import { realCrmDemoHarness } from "./crm-demo/runner.js";

// No dotenv, startup, fallback or automatic action. Each effect requires an
// explicit command, private approval and absent/new fixture ownership.
try {
  const result = await realCrmDemoHarness(fileURLToPath(new URL("..", import.meta.url)))(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  process.stderr.write(JSON.stringify({ status: "REFUSED_OR_FAILED", code: error instanceof CrmDemoRefusal || error instanceof HarnessRefusal
    ? error.code : "CHECK_FAILED", detail: "No automatic retry, reset, fallback or cleanup. Retain partial targets for private review." }) + "\n");
  process.exitCode = 1;
}
