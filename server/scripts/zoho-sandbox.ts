import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadBackendEnvironment } from "../src/environment.js";
import { createZohoClient } from "../src/integrations/zoho/client.js";
import { checkZohoReadiness } from "../src/integrations/zoho/readiness.js";
import { authorizeSandbox, sandboxAuthorizationUrl } from "./zoho-sandbox/oauth.js";
import { assertNewSandboxProfile, readSandboxProfile, saveNewSandboxProfile, SandboxSetupError } from "./zoho-sandbox/profile.js";
import { hiddenSandboxCallback } from "./zoho-sandbox/terminal.js";

async function main() {
  const args = process.argv.slice(2), action = args[0];
  if (args.length !== 1 || !["setup", "check"].includes(action ?? "")) throw new SandboxSetupError("Use zoho:sandbox:setup or zoho:sandbox:check without credential arguments.");
  if (["DEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_OPTIONS", "PWDEBUG"].some(key => process.env[key]?.trim())
    || process.execArgv.some(value => value.startsWith("--inspect")) || process.env.ZOHO_NETWORK_DISABLED === "1") {
    throw new SandboxSetupError("Sandbox calls refused while debugging or ZOHO_NETWORK_DISABLED is active. No request was sent.");
  }
  const root = fileURLToPath(new URL("..", import.meta.url));
  if (action === "setup") {
    assertNewSandboxProfile(root);
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new SandboxSetupError("Run zoho:sandbox:setup in your own interactive terminal.");
    // Client registration may be reused; the production refresh token is NEVER
    // supplied to authorizeSandbox or copied to its separate private profile.
    const env: Record<string, string | undefined> = {};
    loadBackendEnvironment(env);
    const credentials = { clientId: env.ZOHO_CLIENT_ID ?? "", clientSecret: env.ZOHO_CLIENT_SECRET ?? "" };
    const state = randomBytes(32).toString("hex");
    console.log("Choose SANDBOX in Zoho consent, not Production. A company name alone does not identify the environment. If Sandbox is absent, first verify access in Zoho CRM Setup > Data Administration > Sandbox.\nThis creates a separate private sandbox grant; server/.env stays unchanged.\nA callback 404 is OK: paste its full address immediately; the code is short-lived and single-use.\n");
    console.log(sandboxAuthorizationUrl(credentials.clientId, state));
    console.log();
    const profile = await authorizeSandbox(credentials, await hiddenSandboxCallback(), state);
    saveNewSandboxProfile(root, profile);
    console.log("PASS: Zoho confirmed a sandbox organization; its separate grant was saved privately. Production credentials unchanged. No business records were written.");
  }
  const profile = readSandboxProfile(root);
  const client = createZohoClient({ clientId: profile.clientId, clientSecret: profile.clientSecret,
    refreshToken: profile.refreshToken, organizationId: profile.organizationId, environment: "sandbox", allowWrites: false }, { networkEnabled: true });
  try {
    await client.verifyOrganization();
    console.log("PASS: saved grant matches the pinned sandbox organization. Read-only field checks follow; no business writes.");
    console.log(JSON.stringify(await checkZohoReadiness(client), null, 2));
    // A metadata report cannot certify financial/workflow/schema acceptance.
    console.log("Metadata review completed; this is not full CRM workflow or production acceptance.");
    process.exitCode = 2; // Valid inspection, not integration/workflow acceptance.
  } finally { client.close(); }
}
void main().catch(error => {
  console.error(error instanceof SandboxSetupError ? error.message : "Sandbox check failed. Confirm sandbox consent, scopes and private profile access. No secret or provider response was logged.");
  process.exitCode = 1;
});
