import { runZohoInspectionCommand } from "./zoho-inspect/command.js";

void runZohoInspectionCommand(process.argv.slice(2), process.env, process.execArgv).then(result => {
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exitCode = result.exitCode;
}).catch(() => {
  console.error("Read-only inspection failed. No secret or provider response was logged.");
  process.exitCode = 1;
});
