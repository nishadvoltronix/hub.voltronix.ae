import { fileURLToPath } from "node:url";
import { HarnessRefusal } from "./mysql-auth/guard.js";
import { realHarness } from "./mysql-auth/runner.js";

// Fixed package root, no dotenv, discovery, automatic service start or fallback.
try {
  const execute = realHarness(fileURLToPath(new URL("..", import.meta.url)));
  const result = await execute(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  process.stderr.write(JSON.stringify({ status: "REFUSED_OR_FAILED", code: error instanceof HarnessRefusal ? error.code : "CHECK_FAILED",
    detail: "No automatic retry, reset, fallback or cleanup. Retain any partial target for private review." }) + "\n");
  process.exitCode = 1;
}
