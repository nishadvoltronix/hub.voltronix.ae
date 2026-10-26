import { demoConfiguration, openDemo } from "./storage.js";
import { createSqliteDemoRuntime } from "./runtime.js";
import { startServer } from "../src/server.js";

try {
  const config = demoConfiguration(process.env);
  const runtime = createSqliteDemoRuntime(openDemo());
  const server = await startServer(config, { auth: runtime.auth, crmServices: runtime.services }, runtime.close);
  let closing = false;
  const stop = async () => {
    if (closing) return; closing = true;
    try { await server.stop(); process.disconnect?.(); }
    catch { process.exitCode = 1; process.disconnect?.(); }
  };
  process.on("SIGINT", () => { void stop(); });
  process.on("SIGTERM", () => { void stop(); });
  process.on("message", message => { if (message === "sqlite-demo-stop") void stop(); });
  process.once("disconnect", () => { void stop(); });
  process.send?.({ status: "SQLITE_DEMO_API_READY" });
  console.log("SQLite demo API ready on http://127.0.0.1:3002; MySQL and external integrations are disabled.");
} catch {
  console.error("SQLite demo API failed. Check explicit selection, private demo initialization and port ownership.");
  process.exitCode = 1;
}
