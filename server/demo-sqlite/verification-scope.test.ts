import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runBrowserAcceptance, type BrowserAcceptanceOptions } from "./browser-acceptance.js";
import { assertDemoVerificationScope, assertSessionPolicy, parseDemoVerificationArguments,
  preflightDemoSessionPolicy, VerificationScopeError, type DemoSessionPolicy } from "./verification-scope.js";

test("broad SQLite verification requires both exact explicit scopes; safe actions need none", () => {
  for (const args of [["verify"], ["verify", "--mutation-scope=fixture-writes-and-auth"],
    ["verify", "--session-policy=allow-expired-cleanup"], ["verify", "--mutation-scope=read-only", "--session-policy=preserve-existing"],
    ["verify", "--mutation-scope=fixture-writes-and-auth", "--session-policy=preserve-existing", "extra"]]) {
    assert.throws(() => parseDemoVerificationArguments(args), VerificationScopeError);
  }
  for (const policy of ["preserve-existing", "allow-expired-cleanup"] as const) {
    assert.deepEqual(parseDemoVerificationArguments(["verify", "--mutation-scope=fixture-writes-and-auth", `--session-policy=${policy}`]),
      { mutationScope: "fixture-writes-and-auth", sessionPolicy: policy });
  }
  for (const action of ["status", "start", "verify-anonymous"]) assert.equal(parseDemoVerificationArguments([action]), undefined);
  for (const scope of [undefined, {}, { mutationScope: "fixture-writes-and-auth" },
    { mutationScope: "fixture-writes-and-auth", sessionPolicy: "unsafe" }]) assert.throws(() => assertDemoVerificationScope(scope));
});

test("session preservation permits empty/fresh tables and refuses expired or near-expiry rows", () => {
  const now = 1_000_000, fresh = { userId: 2, createdAt: 100_000, expiresAt: now + 120_001 };
  assert.doesNotThrow(() => assertSessionPolicy([], "preserve-existing", now));
  assert.doesNotThrow(() => assertSessionPolicy([fresh], "preserve-existing", now));
  for (const expiresAt of [now - 1, now, now + 120_000]) {
    assert.throws(() => assertSessionPolicy([{ ...fresh, expiresAt }], "preserve-existing", now),
      (error: unknown) => error instanceof VerificationScopeError && error.reason === "session-preservation-at-risk");
    assert.doesNotThrow(() => assertSessionPolicy([{ ...fresh, expiresAt }], "allow-expired-cleanup", now));
  }
  assert.throws(() => preflightDemoSessionPolicy("invalid" as DemoSessionPolicy));
  assert.throws(() => preflightDemoSessionPolicy("preserve-existing", { minimumRemainingMs: 0 }));
  assert.throws(() => assertSessionPolicy([{ ...fresh, userId: 0 }], "allow-expired-cleanup", now));
});

test("direct broad browser entry refuses missing scope before reading credentials or fixtures", async () => {
  const options = { origin: "http://127.0.0.1:3001",
    get accounts() { throw new Error("Synthetic credential getter must not run"); },
    get fixture() { throw new Error("Synthetic fixture getter must not run"); } } as unknown as BrowserAcceptanceOptions;
  const result = await runBrowserAcceptance(options);
  assert.equal(result.status, "FAILED"); assert.equal(result.checks.length, 0);
  assert.equal(result.failedCheck, "Browser configuration and installed executable");
  assert.equal(Object.values(result.observations).every(value => value === 0), true);
});

test("bare verify CLI refuses before child spawn, private-file access or authentication", () => {
  const preload = `import fs from 'node:fs'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    cp.spawn=()=>{throw new Error('forbidden-child-spawn')};
    for(const key of ['openSync','readFileSync','lstatSync']) {const original=fs[key];fs[key]=function(path,...args){
      if(String(path).includes('.local-data'))throw new Error('forbidden-private-access');return original.call(this,path,...args)}}
    syncBuiltinESMExports();`;
  const backend = fileURLToPath(new URL("../", import.meta.url));
  const environment = { ...process.env }; delete environment.CRM_SQLITE_DEMO;
  const run = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`,
    "--import", "tsx", "demo-sqlite/control.ts", "verify"], { cwd: backend, env: environment, encoding: "utf8", windowsHide: true, timeout: 20_000 });
  assert.equal(run.status, 1); assert.equal(run.stdout, "");
  const receipt = JSON.parse(run.stderr.trim()) as { status: string; reason: string; authenticationAttempts: number; applicationWrites: number };
  assert.equal(receipt.status, "SQLITE_DEMO_VERIFICATION_REFUSED"); assert.equal(receipt.reason, "explicit-scope-required");
  assert.equal(receipt.authenticationAttempts, 0); assert.equal(receipt.applicationWrites, 0);
});

test("runtime session preflight precedes private handoff and each broad login; status stays read-only", () => {
  const control = readFileSync(new URL("control.ts", import.meta.url), "utf8");
  const verify = control.slice(control.indexOf("async function verify("), control.indexOf("async function verifyAnonymous("));
  assert.ok(verify.indexOf("preflightDemoSessionPolicy(") < verify.indexOf("access()"));
  const browser = readFileSync(new URL("browser-acceptance.ts", import.meta.url), "utf8");
  assert.match(browser, /assertDemoVerificationScope\(options.verification\);\s+preflightDemoSessionPolicy\(options.verification.sessionPolicy\);\s+validateBrowserOptions\(options\);/);
  assert.match(browser, /pathname === "\/api\/auth\/login" && route.request\(\).method\(\) === "POST"[\s\S]*?preflightDemoSessionPolicy/);
  const status = control.slice(control.lastIndexOf("let running = false;"), control.lastIndexOf("} catch (error)"));
  assert.match(status, /await assertRunning\(\)/); assert.doesNotMatch(status, /access\(|runBrowserAcceptance|login\(/);
});
