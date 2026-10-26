import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadHubEnvironment } from "./hub-environment.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const credentialKeys = ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN"];
const mappingFlags = {
  "--account-profile": { key: "accountPayloadProfile", values: ["legacy-account-email-v1", "standard-account-contact-email-v1"] },
  "--deal-profile": { key: "dealPayloadProfile", values: ["legacy-create-v1", "legacy-conversion-fields-v1"] },
  "--stage-profile": { key: "stagePayloadProfile", values: ["legacy-stage-v1", "voltronix-stage-labels-v1"] },
};
const help = `npm run hub:check:zoho -- --data-center=us
Read-only Zoho production metadata inspection using only this project's root .env.
Set ZOHO_ENABLED=false, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_REFRESH_TOKEN privately in that file.
The current inspector supports the US data center only; select it only after confirming the grant's region.
Optional explicit mappings (legacy defaults remain unchanged):
  --account-profile=standard-account-contact-email-v1
  --deal-profile=legacy-conversion-fields-v1
  --stage-profile=voltronix-stage-labels-v1
No credential or endpoint arguments are accepted. No business records, file changes or runtime enablement.
Exit 2 means a metadata report was produced, not production workflow or synchronization acceptance.`;
const failed = stderr => ({ exitCode: 1, stdout: "", stderr });
let commandPromise;
async function inspectionCommand() {
  // The diagnostic is optional source tooling. Help and invocation refusals do
  // not load TypeScript, credentials, backend dotenv files or a database driver.
  commandPromise ??= import("tsx/esm/api").then(({ tsImport }) =>
    tsImport("../server/scripts/zoho-inspect/command.ts", import.meta.url));
  return (await commandPromise).runZohoInspectionCommand;
}

/** Root-file-only diagnostic. Ambient credentials never override the file;
 * ambient debug/network vetoes still apply before any private-file access. */
export async function runHubZohoCheck(args = [], environment = process.env, execArgs = process.execArgv, dependencies = {}) {
  if (args.length === 1 && args[0] === "--help") return { exitCode: 0, stdout: help, stderr: "" };
  let profiles;
  const selected = new Set();
  for (const argument of args) {
    const [flag, value, extra] = argument.split("=");
    if (selected.has(flag) || extra !== undefined || (flag === "--data-center" ? value !== "us"
      : !Object.hasOwn(mappingFlags, flag) || !mappingFlags[flag].values.includes(value))) {
      return failed("Specify --data-center=us and only documented mapping flags. Duplicate flags, credentials and endpoint arguments are not accepted.");
    }
    selected.add(flag);
    if (flag !== "--data-center") {
      profiles ??= { accountPayloadProfile: "legacy-account-email-v1", dealPayloadProfile: "legacy-create-v1", stagePayloadProfile: "legacy-stage-v1" };
      profiles[mappingFlags[flag].key] = value;
    }
  }
  if (!selected.has("--data-center")) {
    return failed("Specify --data-center=us after confirming the Zoho grant's region. Only US metadata inspection is supported.");
  }
  if (["DEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_OPTIONS", "PWDEBUG"].some(key => environment[key]?.trim())
    || execArgs.some(value => value.startsWith("--inspect")) || environment.ZOHO_NETWORK_DISABLED === "1") {
    return failed("Hub Zoho inspection refused while debugging or ZOHO_NETWORK_DISABLED is active. No private file was loaded or request sent.");
  }
  if (Number(process.versions.node.split(".")[0]) !== 24) return failed("Hub Zoho inspection requires Node.js 24.");
  let configurationFailure;
  try {
    const command = await inspectionCommand();
    const output = await command([], environment, execArgs, {
      loadEnvironment(target) {
        let values;
        try { values = (dependencies.loadEnvironment ?? loadHubEnvironment)(dependencies.root ?? projectRoot, {}); }
        catch {
          configurationFailure = "Cannot safely load the root .env for Zoho inspection. Check its syntax and private file access; no request was sent.";
          throw new Error("Root environment unavailable.");
        }
        if (values.ZOHO_ENABLED !== "false") {
          configurationFailure = "Set ZOHO_ENABLED=false in the root .env. This diagnostic cannot enable synchronization; no request was sent.";
          throw new Error("Zoho runtime must remain disabled.");
        }
        if (credentialKeys.some(key => typeof values[key] !== "string" || !values[key].trim())) {
          configurationFailure = "Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_REFRESH_TOKEN privately in the root .env before inspection. No request was sent.";
          throw new Error("Zoho credentials are incomplete.");
        }
        // Do not pass database credentials or unrelated runtime settings into
        // the legacy command's environment validator or process.env.
        for (const key of ["ZOHO_ENABLED", ...credentialKeys]) target[key] = values[key];
      },
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      ...(dependencies.timeoutMs === undefined ? {} : { timeoutMs: dependencies.timeoutMs }),
      ...(profiles === undefined ? {} : { profiles }),
    });
    if (configurationFailure) return failed(configurationFailure);
    return { ...output, stderr: output.stderr.replaceAll("server/.env", "root .env") };
  } catch {
    return failed("Hub Zoho inspection failed. Check the installed tooling and root .env configuration. No secret or provider response was logged.");
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runHubZohoCheck(process.argv.slice(2)).then(output => {
    if (output.stdout) process.stdout.write(`${output.stdout}\n`);
    if (output.stderr) process.stderr.write(`${output.stderr}\n`);
    process.exitCode = output.exitCode;
  }).catch(() => {
    process.stderr.write("Hub Zoho inspection failed. No secret or provider response was logged.\n");
    process.exitCode = 1;
  });
}
