import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import { allowedCrmBrowserRequest, createCrmChromiumRunner, crmBrowserProcessEnvironment, crmChromiumLaunchOptions,
  crmNextChildBootstrap, crmNextProcessEnvironment, crmDemoInstanceId, expectedCrmDemoChromiumChecks, type CrmChromiumEffects } from "../scripts/crm-demo/chromium.js";
import type { CrmDemoCaseOptions } from "../scripts/crm-demo/cases.js";
import { CrmDemoCaseError, verifyCrmDemoFixture } from "../scripts/crm-demo/fixture.js";

// Pure doubles: no database statements, listeners, children, browser or private file is created.
const origin = "http://127.0.0.1:43001", api = "http://127.0.0.1:43002";
const options = { fixture: {}, fixtureConnection: {}, createRuntime: () => assert.fail("No real runtime in offline harness tests"), record: () => {} } as unknown as CrmDemoCaseOptions;
function fake(changes: Partial<CrmChromiumEffects> = {}) {
  const events: string[] = [];
  const effects: CrmChromiumEffects = {
    verify: async () => { events.push("verify"); }, consume: () => { events.push("consume"); },
    open: async () => { events.push("open"); return { origin, close: async () => { events.push("close"); } }; },
    check: async () => { events.push("check"); return expectedCrmDemoChromiumChecks; }, ...changes,
  };
  return { events, run: createCrmChromiumRunner(effects) };
}

test("OFFLINE Chromium runner proves ownership and one-use capability before effects then rechecks and closes", async () => {
  const f = fake(); assert.equal(await f.run(options), 6);
  assert.deepEqual(f.events, ["verify", "consume", "open", "check", "verify", "close"]);
});
test("OFFLINE missing ownership or consumed capability refuses before child/browser/runtime creation", async () => {
  const invalid = fake({ verify: value => verifyCrmDemoFixture(value.fixtureConnection, value.fixture) });
  await assert.rejects(invalid.run(options), CrmDemoCaseError); assert.deepEqual(invalid.events, []);
  const consumed = fake({ consume: () => { throw new Error("Synthetic private failure"); } });
  await assert.rejects(consumed.run(options), CrmDemoCaseError); assert.deepEqual(consumed.events, ["verify"]);
});
test("OFFLINE browser or ownership-after-use failures retain target data and close only owned processes", async () => {
  const failed = fake({ check: async () => { throw new Error("Synthetic credential marker"); } });
  await assert.rejects(failed.run(options), error => error instanceof CrmDemoCaseError && !error.message.includes("credential"));
  assert.deepEqual(failed.events, ["verify", "consume", "open", "close"]);
  let verifies = 0;
  const drift = fake({ verify: async () => { if (++verifies === 2) throw new Error(); } });
  await assert.rejects(drift.run(options), CrmDemoCaseError); assert.deepEqual(drift.events, ["consume", "open", "check", "close"]);
});
test("OFFLINE wrong browser origin, partial check counts and shutdown failures cannot report success", async () => {
  let checks = 0, closes = 0;
  const wrong = fake({ open: async () => ({ origin: "http://localhost:43001", close: async () => { closes++; } }),
    check: async () => { checks++; return 6; } });
  await assert.rejects(wrong.run(options), CrmDemoCaseError); assert.equal(checks, 0); assert.equal(closes, 1);
  for (const count of [0, 5, 7, Number.NaN]) await assert.rejects(fake({ check: async () => count }).run(options), CrmDemoCaseError);
  const shutdown = fake({ open: async () => ({ origin, close: async () => { throw new Error("Synthetic shutdown detail"); } }) });
  await assert.rejects(shutdown.run(options), CrmDemoCaseError);
});
test("OFFLINE child/browser environments do not inherit database, auth, telemetry or inspector configuration", () => {
  const source = { SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", PATH: "C:\\Windows", MYSQL_PASSWORD: "synthetic marker",
    CRM_MYSQL_PROFILE: "private marker", NODE_OPTIONS: "--inspect", DEBUG: "*", PWDEBUG: "1", NODE_DEBUG: "http", ZOHO_TOKEN: "synthetic marker",
    APP_ORIGIN: "https://unapproved.invalid", CRM_EXPRESS_ORIGIN: "https://unapproved.invalid" };
  assert.deepEqual(crmBrowserProcessEnvironment(source), { SystemRoot: source.SystemRoot, TEMP: source.TEMP, PATH: source.PATH });
  const child = crmNextProcessEnvironment(source, origin, api);
  assert.equal(child.APP_ORIGIN, origin); assert.equal(child.CRM_EXPRESS_ORIGIN, api);
  assert.equal(child.CRM_FRONTEND_BACKEND, "express"); assert.equal(child.CRM_MYSQL_NETWORK_DISABLED, "1");
  assert.equal(child.NEXT_TELEMETRY_DISABLED, "1"); assert.equal(child.NODE_ENV, "production");
  assert.equal(child.CRM_API_INSTANCE_ID, crmDemoInstanceId);
  for (const key of ["CRM_MYSQL_PASSWORD", "CRM_MYSQL_HOST", "CRM_RUNTIME_ENABLE", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN"]) assert.equal(child[key], "");
  for (const name of ["MYSQL_PASSWORD", "CRM_MYSQL_PROFILE", "NODE_OPTIONS", "DEBUG", "PWDEBUG", "NODE_DEBUG", "ZOHO_TOKEN"]) assert.equal(child[name], undefined);
  const launch = crmChromiumLaunchOptions(source);
  assert.equal(launch.headless, true); assert.deepEqual(launch.env, crmBrowserProcessEnvironment(source));
  assert.ok(launch.args?.includes("--disable-background-networking")); assert.equal(launch.executablePath, undefined);
});
test("OFFLINE child configuration refuses external origin, self-proxy and ambiguous origin syntax", () => {
  for (const value of ["https://unapproved.invalid", "http://localhost:43001", "http://127.0.0.1:80", "http://127.0.0.1:43001/",
    "http://synthetic:marker@127.0.0.1:43001", "http://127.0.0.1:43001/path"]) {
    assert.throws(() => crmNextProcessEnvironment({}, value, api), CrmDemoCaseError);
    assert.throws(() => crmNextProcessEnvironment({}, origin, value), CrmDemoCaseError);
  }
  assert.throws(() => crmNextProcessEnvironment({}, origin, origin), CrmDemoCaseError);
});
test("OFFLINE browser allowlist covers frontend prefetch and APIs while rejecting external, PHP and optimizer egress", () => {
  for (const path of ["/", "/login", "/account", "/dashboard", "/jobs/1", "/quotations/2", "/quotations/2/edit", "/items/new", "/pipeline",
    "/legacy/assets/css/plugins/phosphor-icons.css", "/legacy/assets/css/plugins/Phosphor.woff2", "/legacy/assets/images/voltronix_logo.png",
    "/departments/Electrical/jobs/1", "/settings/permissions/assign", "/settings/users/departments", "/reports/employee-performance",
    "/api/auth/login", "/api/leads/1/attachments", "/api/attachments/550e8400-e29b-41d4-a716-446655440000", "/_next/static/chunks/main.js", "/account?_rsc=synthetic"]) {
    assert.equal(allowedCrmBrowserRequest(origin, origin + path), true, path);
  }
  for (const value of [api + "/api/auth/me", "https://unapproved.invalid", origin + "/index.php", origin + "/.env.local",
    origin + "/_next/image?url=https://unapproved.invalid/image", origin + "/legacy/assets/images/unreviewed.php", origin + "/legacy/assets/js/unreviewed.js",
    origin + "/api/%2f/private", "data:text/html,test", "file:///private",
    "ws://127.0.0.1:43001", "http://synthetic:marker@127.0.0.1:43001/account"]) assert.equal(allowedCrmBrowserRequest(origin, value), false);
});

test("OFFLINE production child bootstrap emits readiness only after owned startup completes", async () => {
  const messages: unknown[] = [], starts: unknown[] = [], receipt = "550e8400-e29b-41d4-a716-446655440000";
  let complete: (() => void) | undefined;
  const ready = new Promise<void>(resolve => { complete = resolve; });
  const requireStub = Object.assign((name: string) => {
    assert.equal(name, "resolved-next-start");
    return { startServer: (value: unknown) => { starts.push(value); return ready; } };
  }, { resolve: (name: string, value: { paths: string[] }) => {
    assert.equal(name, "next/dist/server/lib/start-server"); assert.deepEqual(Array.from(value.paths), ["owned-next-root"]); return "resolved-next-start";
  } });
  new Script(crmNextChildBootstrap).runInNewContext({ require: requireStub, process: {
    argv: ["node", "owned-next-root", "43001", receipt], pid: 1234, on: () => {}, send: (message: unknown) => messages.push(message),
    exit: () => assert.fail("Unexpected child failure"),
  } });
  assert.equal(starts.length, 1); assert.equal(messages.length, 0);
  const config = starts[0] as Record<string, unknown>;
  assert.equal(config.hostname, "127.0.0.1"); assert.equal(config.port, 43001); assert.equal(config.isDev, false); assert.equal(config.allowRetry, false);
  complete!(); await ready; await Promise.resolve();
  assert.equal(messages.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0])), { type: "crm-demo-ready", receipt, pid: 1234, port: 43001 });
});
test("OFFLINE production child rejects malformed startup before importing Next and redacts failures", () => {
  for (const [port, receipt] of [["80", "550e8400-e29b-41d4-a716-446655440000"], ["43001", "invalid"]]) {
    const messages: unknown[] = [];
    const stopped = new Error("Synthetic stop");
    assert.throws(() => new Script(crmNextChildBootstrap).runInNewContext({ require: () => assert.fail("Unexpected import"), process: {
      argv: ["node", "owned-next-root", port, receipt], on: () => {}, send: (message: unknown) => messages.push(message), exit: () => { throw stopped; },
    } }), error => error === stopped);
    assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: "crm-demo-failed" }]);
  }
});
test("OFFLINE prepared UI harness has source-backed locators and no secret recording or deployment hooks", () => {
  const source = readFileSync(new URL("../scripts/crm-demo/chromium.ts", import.meta.url), "utf8");
  assert.match(source, /stdio: \["ignore", "ignore", "ignore", "ipc"\]/);
  assert.match(source, /windowsHide: true/); assert.match(source, /serviceWorkers: "block"/);
  assert.match(source, /consumeCrmDemo\(value\.fixture, "chromium"\)/);
  assert.equal(/\.screenshot\(|\.storageState\(|\.saveAs\(|\.tracing\.|\.install\(|console\.(?:log|error)|["']taskkill["']|DROP DATABASE|TRUNCATE/.test(source), false);
  const ui = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");
  assert.ok(ui("components/login-form.tsx").includes("Email address"));
  assert.match(ui("components/login-form.tsx"), /["'](?:Login|Sign in)["']/);
  for (const text of ["Administrator remarks", "Save remarks", "Job saved."]) assert.ok(ui("components/crm/job-details.tsx").includes(text));
  for (const text of ["Attachment file", "Upload attachment", "Attachment saved."]) assert.ok(ui("components/crm/attachments.tsx").includes(text));
  assert.ok(ui("components/crm/quotations.tsx").includes("Download quotation PDF"));
  assert.ok(ui("components/crm/chrome.tsx").includes('aria-label="User menu"'));
  assert.ok(ui("components/crm/navigation.tsx").includes('label: "Jobs Departments"'));
  assert.ok(ui("app/page.tsx").includes('hasDashboardAccess(user.permissions) ? "/dashboard" : "/account"'));
});
