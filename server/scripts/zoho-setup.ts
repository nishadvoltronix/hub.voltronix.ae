import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadBackendEnvironment, parseBackendEnvironment } from "../src/environment.js";
import { validateZohoEnvironment } from "../src/runtime/environment-settings.js";
import { authorizationUrl, callbackCode, checkMetadata, exchangeCode, refreshAccess, saveRefreshToken, ZohoSetupError } from "./zoho-oauth.js";

/** Local terminal input is hidden and never supplied in process arguments. */
function hiddenCallback(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new ZohoSetupError("Run this command in your local interactive terminal.");
  process.stdout.write("Paste the FULL new callback URL here, then press Enter (input hidden): ");
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = process.stdin.isRaw;
    const finish = (error?: ZohoSetupError) => {
      process.stdin.off("data", onData); process.stdin.off("error", onError); process.stdin.off("end", onEnd);
      process.stdin.setRawMode(wasRaw); process.stdin.pause(); process.stdout.write("\n");
      if (error) reject(error); else resolve(value.replaceAll("\u001b[200~", "").replaceAll("\u001b[201~", ""));
      value = "";
    };
    const onError = () => finish(new ZohoSetupError("Terminal input failed."));
    const onEnd = () => finish(new ZohoSetupError("Terminal input ended before a callback URL was supplied."));
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003" || char === "\u0004") { finish(new ZohoSetupError("Setup cancelled; file unchanged.")); return; }
        if (char === "\r" || char === "\n") { finish(); return; }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char === "\u001b" || (char.charCodeAt(0) >= 32 && char.charCodeAt(0) < 127)) value += char;
        if (value.length > 8204) { finish(new ZohoSetupError("Callback URL is too long.")); return; }
      }
    };
    process.stdin.setRawMode(true); process.stdin.resume();
    process.stdin.on("data", onData); process.stdin.once("error", onError); process.stdin.once("end", onEnd);
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("npm run zoho:setup  # optional fresh production consent, exchange and replace saved refresh token\nnpm run zoho:check  # reuse saved token; read-only Deals metadata only\nFresh consent includes organization-read and user-read scopes; refreshing an old grant does not add scopes.\nThe check does not verify organization binding, user mapping or live workflows. US PMCRM only. MySQL is skipped; automatic Zoho sync stays disabled.");
    return;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) throw new ZohoSetupError("Use zoho:setup or zoho:check without credential arguments.");
  const file = fileURLToPath(new URL("../.env", import.meta.url));
  const env: Record<string, string | undefined> = {};
  loadBackendEnvironment(env, new URL("../.env", import.meta.url));
  validateZohoEnvironment(env);
  const source = readFileSync(file, "utf8");
  if (JSON.stringify(parseBackendEnvironment(source)) !== JSON.stringify(env)) throw new ZohoSetupError("server/.env changed while loading. Rerun setup.");
  if (!env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET) throw new ZohoSetupError("Set ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET privately in server/.env first.");
  const credentials = { clientId: env.ZOHO_CLIENT_ID, clientSecret: env.ZOHO_CLIENT_SECRET };
  let accessToken: string;
  if (args[0] === "--check") {
    accessToken = await refreshAccess(credentials, env.ZOHO_REFRESH_TOKEN ?? "");
    console.log("PASS: saved refresh token accepted by Zoho.");
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new ZohoSetupError("Run zoho:setup in your local interactive terminal.");
    const state = randomBytes(32).toString("hex");
    console.log("Open this NEW link in your browser and approve the intended PRODUCTION CRM organization.\nIt requests full CRM module access plus field metadata, search, organization-read and user-read scopes.\nThis interactive setup replaces the saved refresh token after a successful exchange; it does not enable automatic sync.\nA 404 on the callback is OK: copy its complete address bar URL. Paste it here immediately; the code is short-lived and single-use.\n");
    console.log(authorizationUrl(credentials.clientId, state));
    console.log();
    const code = callbackCode(await hiddenCallback(), state);
    if (readFileSync(file, "utf8") !== source) throw new ZohoSetupError("server/.env changed while awaiting consent. Rerun setup before exchanging the code.");
    const result = await exchangeCode(credentials, code);
    saveRefreshToken(file, source, result.refreshToken);
    accessToken = result.accessToken;
    console.log("PASS: refresh token saved privately in server/.env. MySQL settings unchanged.");
  }
  if (await checkMetadata(accessToken)) console.log("PASS: Zoho CRM Deals field metadata read succeeded. Organization binding, user mapping and live workflows were not verified. Automatic synchronization is still disabled.");
  else {
    console.error("Token accepted, but the read-only metadata check failed (permissions, scope or connectivity). The saved token is retained. Run zoho:check to retry.");
    process.exitCode = 1;
  }
}

void main().catch(error => {
  console.error(error instanceof ZohoSetupError ? error.message : "Zoho setup/check failed. Check server/.env syntax and private file access. No secret values were logged.");
  process.exitCode = 1;
});
