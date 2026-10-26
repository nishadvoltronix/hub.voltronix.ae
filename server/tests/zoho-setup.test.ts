import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  accountsOrigin, apiOrigin, authorizationUrl, callbackCode, checkMetadata, exchangeCode,
  redirectUri, refreshAccess, saveRefreshToken, withRefreshToken, ZohoSetupError,
} from "../scripts/zoho-oauth.js";
import { assertPrivateAccess } from "../src/runtime/private-profile.js";

const state = "a".repeat(64);
const credentials = { clientId: "1000.synthetic-client", clientSecret: "synthetic-secret-marker" };
const code = "1000.synthetic-code-marker";
const accessToken = "1000.synthetic-access-marker";
const refreshToken = "1000.synthetic-refresh-marker";
const sensitive = [credentials.clientSecret, code, accessToken, refreshToken, "synthetic-provider-detail"];

function callback(): URL {
  const result = new URL(redirectUri);
  result.search = new URLSearchParams({ code, state, location: "us", "accounts-server": accountsOrigin }).toString();
  return result;
}

function jsonRequest(payload: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function redactedError(pattern: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ZohoSetupError);
    assert.match(error.message, pattern);
    for (const value of sensitive) assert.equal(error.stack?.includes(value), false);
    return true;
  };
}

test("authorization URL binds the registered callback and state with offline consent", () => {
  const url = new URL(authorizationUrl(credentials.clientId, state));
  assert.equal(url.origin, "https://accounts.zoho.com");
  assert.equal(url.pathname, "/oauth/v2/auth");
  assert.equal(url.searchParams.get("redirect_uri"), "https://crm.voltronix.ae/crm/pm/index.php/zoho/callback");
  assert.equal(url.searchParams.get("client_id"), credentials.clientId);
  assert.equal(url.searchParams.get("state"), state);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("scope"), "ZohoCRM.modules.ALL,ZohoCRM.settings.fields.READ,ZohoSearch.securesearch.READ,ZohoCRM.org.READ,ZohoCRM.users.READ");
  const requested = url.searchParams.get("scope")!.split(",");
  assert.equal(new Set(requested).size, 5);
  assert.equal(requested.includes("ZohoCRM.org.ALL"), false);
  assert.equal(requested.includes("ZohoCRM.users.ALL"), false);
  assert.equal(url.searchParams.has("client_secret"), false);
  assert.equal(url.searchParams.has("refresh_token"), false);
});

test("setup help explains optional token replacement and the metadata-only check without reading private settings", () => {
  // --help returns before the executable's private environment loader. No
  // callback, refresh token, network call or runtime startup is involved.
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/zoho-setup.ts", "--help"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 10_000, windowsHide: true,
  });
  assert.equal(result.status, 0); assert.equal(result.stderr, "");
  assert.match(result.stdout, /optional fresh production consent/);
  assert.match(result.stdout, /replace saved refresh token/);
  assert.match(result.stdout, /read-only Deals metadata only/);
  assert.match(result.stdout, /refreshing an old grant does not add scopes/);
  assert.match(result.stdout, /does not verify organization binding, user mapping or live workflows/);
  assert.match(result.stdout, /automatic Zoho sync stays disabled/);
});

test("authorization URL rejects invalid client IDs and session states", () => {
  assert.throws(() => authorizationUrl("client&redirect_uri=https://example.invalid", state), ZohoSetupError);
  assert.throws(() => authorizationUrl(credentials.clientId, ""), ZohoSetupError);
  assert.throws(() => authorizationUrl(credentials.clientId, "b".repeat(63)), ZohoSetupError);
});

test("a complete callback URL yields only the decoded code", () => {
  assert.equal(callbackCode(`  ${callback().href}  `, state), code);
});

const invalidCallbacks: [string, (url: URL) => void][] = [
  ["foreign callback host", url => { url.hostname = "example.invalid"; }],
  ["wrong callback path", url => { url.pathname = "/other/callback"; }],
  ["HTTP callback", url => { url.protocol = "http:"; }],
  ["URL credentials", url => { url.username = "synthetic-user"; }],
  ["fragment", url => { url.hash = "synthetic-fragment"; }],
  ["duplicate code", url => { url.searchParams.append("code", "1000.second-code"); }],
  ["duplicate state", url => { url.searchParams.append("state", state); }],
  ["wrong state", url => { url.searchParams.set("state", "b".repeat(64)); }],
  ["missing state", url => { url.searchParams.delete("state"); }],
  ["foreign Accounts endpoint", url => { url.searchParams.set("accounts-server", "https://example.invalid"); }],
  ["different Accounts data center", url => { url.searchParams.set("accounts-server", "https://accounts.zoho.eu"); }],
  ["different location", url => { url.searchParams.set("location", "eu"); }],
  ["provider error", url => { url.searchParams.set("error", "synthetic-provider-detail"); }],
  ["missing code", url => { url.searchParams.delete("code"); }],
  ["embedded query tail", url => { url.searchParams.set("code", `${code}&location=us`); }],
];

for (const [label, modify] of invalidCallbacks) {
  test(`callback validation rejects ${label} without revealing callback contents`, () => {
    const url = callback();
    modify(url);
    assert.throws(() => callbackCode(url.href, state), redactedError(/complete callback URL/));
  });
}

test("code exchange sends credentials only in the POST body and disallows redirects", async () => {
  let calls = 0;
  const request: typeof fetch = async (input, init) => {
    calls += 1;
    assert.equal(input, `${accountsOrigin}/oauth/v2/token`);
    const destination = new URL(String(input));
    assert.equal(destination.search, "");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Content-Type"), "application/x-www-form-urlencoded");
    assert.ok(init?.signal instanceof AbortSignal);
    assert.ok(init.body instanceof URLSearchParams);
    assert.deepEqual(Object.fromEntries(init.body), {
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
    });
    return new Response(JSON.stringify({ access_token: accessToken, refresh_token: refreshToken, api_domain: apiOrigin }));
  };
  assert.deepEqual(await exchangeCode(credentials, code, request), { accessToken, refreshToken });
  assert.equal(calls, 1);
});

test("exchange success requires a refresh token", async () => {
  await assert.rejects(exchangeCode(credentials, code, jsonRequest({ access_token: accessToken, api_domain: apiOrigin })),
    redactedError(/did not return a refresh token/));
});

test("exchange success requires the expected Zoho API origin", async () => {
  for (const domain of [undefined, "https://www.zohoapis.eu", "https://www.zohoapis.com.example.invalid"]) {
    await assert.rejects(exchangeCode(credentials, code, jsonRequest({
      access_token: accessToken, refresh_token: refreshToken, api_domain: domain,
    })), redactedError(/Unexpected Zoho API region/));
  }
});

test("invalid_code errors use a fixed explanation without echoing the provider payload", async () => {
  await assert.rejects(exchangeCode(credentials, code, jsonRequest({
    error: "invalid_code", error_description: sensitive.join(" "),
  }, 400)), redactedError(/invalid, expired or already used/));
});

test("unknown OAuth errors cannot reflect provider details or token values", async () => {
  await assert.rejects(exchangeCode(credentials, code, jsonRequest({
    error: "synthetic-provider-detail", access_token: accessToken,
  }, 400)), redactedError(/token request failed \(HTTP 400\)/));
});

test("HTML and malformed provider responses are redacted", async () => {
  const request: typeof fetch = async () => new Response(`<html>${sensitive.join(" ")}</html>`, { status: 502 });
  await assert.rejects(exchangeCode(credentials, code, request), redactedError(/unexpected response \(HTTP 502\)/));
  await assert.rejects(exchangeCode(credentials, code, jsonRequest(["synthetic-provider-detail"])),
    redactedError(/unexpected response/));
});

test("redirect and transport failures cannot expose request or response secrets", async () => {
  const request: typeof fetch = async (_input, init) => {
    assert.equal(init?.redirect, "error");
    throw new TypeError(`redirect failed: ${sensitive.join(" ")}`);
  };
  await assert.rejects(exchangeCode(credentials, code, request), redactedError(/request failed or timed out/));
});

test("refresh rejects callback query tails before invoking fetch", async () => {
  let calls = 0;
  const request: typeof fetch = async () => { calls += 1; throw new Error("Unexpected request"); };
  await assert.rejects(refreshAccess(credentials, `${code}&location=us&accounts-server=${accountsOrigin}`, request),
    redactedError(/invalid characters/));
  assert.equal(calls, 0);
});

test("refresh uses the stored refresh token grant without sending it in the URL", async () => {
  const request: typeof fetch = async (input, init) => {
    assert.equal(input, `${accountsOrigin}/oauth/v2/token`);
    assert.ok(init?.body instanceof URLSearchParams);
    assert.deepEqual(Object.fromEntries(init.body), {
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    return new Response(JSON.stringify({ access_token: accessToken, api_domain: apiOrigin }));
  };
  assert.equal(await refreshAccess(credentials, refreshToken, request), accessToken);
});

test("fresh consent scopes do not expand an existing token check into organization, user or business requests", async () => {
  const calls: string[] = [];
  const request: typeof fetch = async (input, init) => {
    calls.push(String(input));
    if (calls.length === 1) {
      assert.equal(input, `${accountsOrigin}/oauth/v2/token`);
      assert.equal(init?.method, "POST"); assert.ok(init.body instanceof URLSearchParams);
      assert.equal(init.body.get("grant_type"), "refresh_token");
      assert.equal(init.body.get("refresh_token"), refreshToken);
      assert.equal(init.body.has("scope"), false); assert.equal(init.body.has("code"), false);
      return new Response(JSON.stringify({ access_token: accessToken, api_domain: apiOrigin }));
    }
    assert.equal(calls.length, 2);
    assert.equal(input, `${apiOrigin}/crm/v8/settings/fields?module=Deals`);
    assert.equal(init?.method ?? "GET", "GET"); assert.equal(init?.body, undefined);
    return new Response(JSON.stringify({ fields: [{ api_name: "Deal_Name" }] }));
  };
  assert.equal(await checkMetadata(await refreshAccess(credentials, refreshToken, request), request), true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(url => !/\/org$|\/users|\/Deals(?:\/|$)/.test(url)));
});

test("metadata check reads only fixed Deals field metadata using the authorization header", async () => {
  let calls = 0;
  const request: typeof fetch = async (input, init) => {
    calls += 1;
    assert.equal(input, "https://www.zohoapis.com/crm/v8/settings/fields?module=Deals");
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(init?.body, undefined);
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
    assert.deepEqual(headers, { authorization: `Zoho-oauthtoken ${accessToken}` });
    assert.equal(String(input).includes(accessToken), false);
    return new Response(JSON.stringify({ fields: [{ api_name: "Deal_Name" }] }));
  };
  assert.equal(await checkMetadata(accessToken, request), true);
  assert.equal(calls, 1);
});

test("metadata check rejects failed HTTP status and missing or malformed field metadata", async () => {
  assert.equal(await checkMetadata(accessToken, jsonRequest({ fields: [] })), true);
  assert.equal(await checkMetadata(accessToken, jsonRequest({ fields: [] }, 403)), false);
  for (const payload of [null, [], {}, { fields: null }, { fields: "synthetic-provider-detail" }]) {
    assert.equal(await checkMetadata(accessToken, jsonRequest(payload)), false);
  }
});

test("metadata failures return only false without logging provider details or tokens", async context => {
  const logs = ["log", "warn", "error"].map(method =>
    context.mock.method(console, method as "log" | "warn" | "error", () => {}));
  const htmlRequest: typeof fetch = async () => new Response(`<html>${sensitive.join(" ")}</html>`, { status: 502 });
  const failedRequest: typeof fetch = async () => { throw new Error(sensitive.join(" ")); };
  assert.equal(await checkMetadata(accessToken, htmlRequest), false);
  assert.equal(await checkMetadata(accessToken, failedRequest), false);
  assert.equal(await checkMetadata(accessToken, jsonRequest({ error: sensitive.join(" ") }, 401)), false);
  for (const log of logs) assert.equal(log.mock.callCount(), 0);
});

test("refresh token replacement preserves all other source bytes including CRLF and MySQL values", () => {
  const prefix = "# Synthetic test settings\r\nCRM_MYSQL_DATABASE=synthetic_crm\r\nCRM_MYSQL_SERVER_UUID='<unchanged>'\r\n";
  const suffix = "\r\nZOHO_ENABLED=false\r\n# Keep this comment\r\nCRM_MYSQL_PASSWORD='synthetic-mysql-marker'\r\n";
  const source = `${prefix}  export ZOHO_REFRESH_TOKEN = 'old.synthetic-token'${suffix}`;
  assert.equal(withRefreshToken(source, refreshToken), `${prefix}ZOHO_REFRESH_TOKEN=${refreshToken}${suffix}`);
});

test("refresh token insertion retains existing settings when the key is absent", () => {
  const source = "# Synthetic settings\nCRM_MYSQL_DATABASE=synthetic_crm\nZOHO_ENABLED=false";
  assert.equal(withRefreshToken(source, refreshToken), `${source}\nZOHO_REFRESH_TOKEN=${refreshToken}\n`);
});

test("refresh token replacement handles a BOM-prefixed first-line key and retains the BOM", () => {
  const suffix = "\r\nCRM_MYSQL_DATABASE=synthetic_crm\r\nZOHO_ENABLED=false\r\n";
  const source = `\uFEFFZOHO_REFRESH_TOKEN=old.synthetic-token${suffix}`;
  assert.equal(withRefreshToken(source, refreshToken), `\uFEFFZOHO_REFRESH_TOKEN=${refreshToken}${suffix}`);
});

test("refresh token insertion preserves CRLF line endings with or without a final newline", () => {
  const source = "# Synthetic settings\r\nCRM_MYSQL_DATABASE=synthetic_crm\r\nZOHO_ENABLED=false";
  const expected = `${source}\r\nZOHO_REFRESH_TOKEN=${refreshToken}\r\n`;
  assert.equal(withRefreshToken(source, refreshToken), expected);
  assert.equal(withRefreshToken(`${source}\r\n`, refreshToken), expected);
});

test("refresh token replacement rejects newline injection and ambiguous duplicate settings", () => {
  const source = "ZOHO_REFRESH_TOKEN=old.synthetic-token\nZOHO_ENABLED=false\n";
  assert.throws(() => withRefreshToken(source, `${refreshToken}\nZOHO_ENABLED=true`),
    redactedError(/Invalid refresh token response/));
  assert.throws(() => withRefreshToken(`${source}ZOHO_REFRESH_TOKEN=second.synthetic-token\n`, refreshToken));
});

test("saving refuses a concurrently changed synthetic file before any ACL check or write", () => {
  const directory = mkdtempSync(join(tmpdir(), "crm-zoho-synthetic-test-"));
  const file = join(directory, "synthetic.env");
  const original = "ZOHO_REFRESH_TOKEN=old.synthetic-token\nCRM_MYSQL_DATABASE=synthetic_crm\n";
  const changed = `${original}# User edit during consent\n`;
  try {
    writeFileSync(file, changed);
    assert.throws(() => saveRefreshToken(file, original, refreshToken), redactedError(/changed during setup/));
    assert.equal(readFileSync(file, "utf8"), changed);
  } finally {
    unlinkSync(file);
    rmdirSync(directory);
  }
});

/** Called only for the synthetic file created by the successful-save test. */
function syntheticFileAccess(file: string, initialize = false): string {
  if (process.platform !== "win32") {
    if (initialize) chmodSync(file, 0o600);
    const stat = lstatSync(file);
    return `${stat.mode & 0o777}:${stat.uid}:${stat.gid}`;
  }
  const script = `$ErrorActionPreference='Stop'; $target=[Console]::In.ReadToEnd();
    ${initialize ? `
      $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
      $acl=[Security.AccessControl.FileSecurity]::new();
      $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false);
      $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow');
      $acl.AddAccessRule($rule); Set-Acl -LiteralPath $target -AclObject $acl;
    ` : ""}
    [Console]::Out.Write((Get-Acl -LiteralPath $target).Sddl);`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], {
    input: file, encoding: "utf8", timeout: 10_000, windowsHide: true,
  });
  assert.equal(result.error, undefined, "Synthetic ACL helper must start successfully");
  assert.equal(result.status, 0, "Synthetic ACL helper must complete successfully");
  assert.ok(result.stdout.length > 0);
  return result.stdout;
}

test("successful shorter and longer saves preserve synthetic file contents, inode and private ACL", () => {
  const directory = mkdtempSync(join(tmpdir(), "crm-zoho-private-synthetic-test-"));
  const file = join(directory, "synthetic.env");
  const prefix = "\uFEFF# Synthetic settings\r\nCRM_MYSQL_DATABASE=synthetic_crm\r\nCRM_MYSQL_PASSWORD='synthetic-mysql-marker'\r\n";
  const suffix = "\r\nZOHO_ENABLED=false\r\n# Preserve trailing comment\r\n";
  let source = `${prefix}ZOHO_REFRESH_TOKEN=1000.original-synthetic-token${suffix}`;
  try {
    writeFileSync(file, source, { mode: 0o600 });
    const access = syntheticFileAccess(file, true);
    const initial = lstatSync(file);
    assertPrivateAccess(file);
    for (const replacement of ["1000.short", `1000.${"synthetic-long-".repeat(40)}`]) {
      saveRefreshToken(file, source, replacement);
      source = `${prefix}ZOHO_REFRESH_TOKEN=${replacement}${suffix}`;
      assert.equal(readFileSync(file, "utf8"), source);
      const after = lstatSync(file);
      assert.equal(after.size, Buffer.byteLength(source));
      assert.equal(after.dev, initial.dev);
      assert.equal(after.ino, initial.ino);
      assert.equal(after.nlink, 1);
      assert.equal(syntheticFileAccess(file), access);
      assertPrivateAccess(file);
    }
  } finally {
    unlinkSync(file);
    rmdirSync(directory);
  }
});
