import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { chromium, type Route } from "playwright";
import type { ZohoDirectoryUser } from "@voltronix/crm-contracts";

// These fixtures never connect to the demo, use credentials, or mutate application data.
const origin = "http://127.0.0.1:39994";
const actor = { localUserId: "999", username: "Synthetic admin", email: "layout@example.invalid",
  permissions: ["dashboard.view", "leads.view", "leads.manage", "deals.view", "deals.manage", "items.view", "users.write", "permissions.manage"] };
const grantUsers = Array.from({ length: 101 }, (_, index) => ({ id: String(index + 101),
  name: `Synthetic Admin ${String(index + 1).padStart(3, "0")}`, email: `admin${index + 1}@example.invalid` }));
const users = grantUsers.slice(0, 26).map((user, index) => ({ ...user, status: index % 2 ? "inactive" : "active",
  externalUserId: null, departmentRole: null, departmentAssignedBy: null, departmentAssignedAt: null, version: 1 }));
const groups = [{ id: "1", key: "workflow", label: "Workflow", sortOrder: 1, version: 1 },
  { id: "2", key: "reports", label: "Reports", sortOrder: 2, version: 1 }];
const permissions = [
  { id: "1", key: "dashboard.view", label: "View dashboard", groupId: "1", groupLabel: "Workflow", version: 1 },
  { id: "2", key: "leads.manage", label: "Manage leads", groupId: "1", groupLabel: "Workflow", version: 1 },
  { id: "3", key: "reports.view", label: "View reports", groupId: "2", groupLabel: "Reports", version: 1 },
  { id: "4", key: "items.view", label: "View items", groupId: "2", groupLabel: "Reports", version: 1 },
];

async function browserFixture(kind: "users" | "grants" | "departments", api: (route: Route, url: URL) => Promise<boolean>, initialUserId = "") {
  const directory = resolve(".local-data", "reports", `settings-source-${kind}-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const component = kind === "users" ? "SettingsEditTarget" : kind === "departments" ? "DepartmentManager" : "GrantManager";
  const componentFile = kind === "users" ? "edit-target" : kind === "departments" ? "department-manager" : "grant-manager";
  const pathname = kind === "users" ? "/settings/users" : kind === "departments" ? "/settings/users/departments" : "/settings/permissions/assign";
  const entry = `import {createRoot} from 'react-dom/client';import {CrmChrome} from './src/components/crm/chrome';import {${component}} from './src/components/settings/${componentFile}';createRoot(document.getElementById('root')).render(<CrmChrome user={${JSON.stringify(actor)}}><section><h1>${kind === "users" ? "Users" : kind === "departments" ? "Assign Departments" : "Assign permissions"}</h1><${component}${kind === "grants" ? ` initialUserId={new URLSearchParams(location.search).get('userId') ?? ${JSON.stringify(initialUserId)}}` : kind === "users" ? ` kind="users" editId={new URLSearchParams(location.search).get('editId') ?? ''}` : ""}/></section></CrmChrome>);`;
  const bundle = await build({ stdin: { contents: entry, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false,
    format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "next-component-stubs", setup(buildApi) {
      buildApi.onResolve({ filter: /^next\/(image|link|navigation)$/ }, args => ({ path: args.path, namespace: "fixture" }));
      buildApi.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path.endsWith("navigation")
        ? `export function useRouter(){return{refresh(){},replace(){}}};export function usePathname(){return ${JSON.stringify(pathname)}};export function useSearchParams(){return new URLSearchParams()}`
        : args.path.endsWith("image") ? "import React from'react';export default function Image({unoptimized,priority,...props}){return React.createElement('img',props)}"
          : "import React from'react';export default function Link(props){return React.createElement('a',props)}", loader: "js", resolveDir: process.cwd() }));
    } }] });
  const styles = ["src/app/globals.css", ...["jquery.dataTables.min.css", "plugins/phosphor-icons.css", "plugins/tabler-icons.min.css",
    "hrms.css", "style.css", "select2.min.css"].map(file => "public/legacy/assets/css/" + file)];
  const fonts = await Promise.all([
    ["Phosphor", "public/legacy/assets/css/plugins/Phosphor.woff2"],
    ["tabler-icons", "public/legacy/assets/css/plugins/fonts/tabler-icons.woff2"],
  ].map(async ([family, file]) => `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${(await readFile(file!)).toString("base64")}) format("woff2");font-weight:normal;font-style:normal;}`));
  const css = (await Promise.all(styles.map(file => readFile(file, "utf8"))))
    .join("\n").replace(/@font-face\s*\{[^}]*\}/g, "").replace(/@import[^;]+;/g, "") + fonts.join("\n");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1907, height: 917 }, serviceWorkers: "block" });
  page.setDefaultTimeout(10_000);
  const failures: string[] = [], requests: string[] = [], screenshots: string[] = [], checks: string[] = [];
  page.on("pageerror", () => failures.push("pageerror"));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push(request.method() + " " + url.pathname + url.search);
    if (url.origin !== origin || request.method() !== "GET") {
      failures.push("Unexpected origin or mutation: " + request.method() + " " + url.pathname); return route.abort();
    }
    if (url.pathname === "/" || url.pathname === pathname) return route.fulfill({ contentType: "text/html", body: `<!DOCTYPE html><html><head><style>${css}</style></head><body data-pc-preset="preset-1" data-pc-sidebar-caption="true" data-pc-theme="light" data-pc-direction="ltr"><div id="root"></div><script src="/component.js"></script></body></html>` });
    if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
    if (url.pathname === "/legacy/assets/images/logo-voltronix.png") return route.fulfill({ contentType: "image/png", body: await readFile("public" + url.pathname) });
    if (await api(route, url)) return;
    if (url.pathname === "/api/capabilities") return route.fulfill({ json: { persistence: "local-demo", zohoInbound: false } });
    const editedUser = kind === "users" ? users.find(user => url.pathname === "/api/settings/users/" + user.id) : undefined;
    if (editedUser) return route.fulfill({ json: editedUser });
    failures.push("Unexpected route: " + url.pathname); return route.abort();
  });
  return { page, directory, requests, failures,
    async check(name: string, action: () => void | Promise<void>) { await action(); checks.push(name); },
    async capture(name: string) {
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.evaluate(() => document.fonts.check('14px "Phosphor"') && document.fonts.check('14px "tabler-icons"')), true);
      await page.screenshot({ path: join(directory, name), fullPage: true, animations: "disabled" }); screenshots.push(name);
    },
    async close(passed: boolean) {
      await browser.close();
      await writeFile(join(directory, "receipt.json"), JSON.stringify({ status: passed ? "PASS" : "FAIL",
        scope: "Synthetic settings source-theme browser; all network intercepted; no credentials, database or application writes.",
        checkCount: checks.length, checks, screenshots, requests, failures }, null, 2), { flag: "wx" });
    },
  };
}

test("source department assignments retain original modal, seven choices and visible desktop actions with long identities", { timeout: 90_000 }, async t => {
  const user = { ...users[0]!, name: "Long synthetic identity " + "x".repeat(100), email: "department." + "y".repeat(90) + "@example.invalid", departmentRole: "Civil" };
  const fixture = await browserFixture("departments", async (route, url) => {
    if (url.pathname !== "/api/settings/users") return false;
    await route.fulfill({ json: { items: [user], total: 1, page: 1, pageSize: 25 } }); return true;
  });
  const { page, check } = fixture; let passed = false;
  try {
    await page.goto(origin); const region = page.getByRole("region", { name: "Department assignments", exact: true });
    const row = region.locator("tbody tr"); await row.waitFor();
    for (const width of [1440, 1907]) {
      await page.setViewportSize({ width, height: 1000 });
      await check(`All four source columns and department action visible at ${width}px`, async () => {
        assert.deepEqual(await region.locator("thead th").allTextContents(), ["Name", "Email", "Department", "Actions"]);
        assert.equal(await row.locator("td").nth(0).textContent(), user.name); assert.equal(await row.locator("td").nth(1).textContent(), user.email);
        const table = region.locator(".table-scroll"), bounds = await table.boundingBox();
        assert.equal(await table.evaluate(element => element.scrollWidth <= element.clientWidth), true);
        const action = await row.getByRole("button").boundingBox(); assert.ok(action && bounds && action.x >= bounds.x && action.x + action.width <= bounds.x + bounds.width);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      });
    }
    await fixture.capture("department-assignments-1907.png");
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 }); await row.getByRole("button").click();
      const dialog = page.getByRole("dialog", { name: "Assign Department", exact: true }); await dialog.waitFor();
      await check(`Department modal choices, current selection and cancellation at ${width}px`, async () => {
        const select = dialog.getByLabel("Select Department", { exact: true });
        assert.deepEqual(await select.locator("option").allTextContents(), ["Select department", "Electrical", "Civil", "PM", "Switchgear", "Maintenance", "Accounts", "Operations"]);
        assert.equal(await select.inputValue(), "Civil"); await select.selectOption("Electrical");
        const bounds = await dialog.boundingBox(); assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      });
      await fixture.capture(`department-modal-${width}.png`); await dialog.getByRole("button", { name: "Close", exact: true }).click();
      assert.equal(await row.locator("td").nth(2).textContent(), "Civil");
    }
    await check("No account or department write issued", async () => { assert.ok(fixture.requests.every(request => request.startsWith("GET "))); assert.deepEqual(fixture.failures, []); });
    passed = true;
  } finally { await fixture.close(passed); t.diagnostic("Department source evidence: " + fixture.directory); }
});

test("source Users layout keeps four columns, local edit/cancel and confirmation before any status request", { timeout: 90_000 }, async t => {
  const fixture = await browserFixture("users", async (route, url) => {
    if (url.pathname !== "/api/settings/users") return false;
    const query = (url.searchParams.get("query") ?? "").toLowerCase();
    const page = Number(url.searchParams.get("page")), pageSize = Number(url.searchParams.get("pageSize"));
    const filtered = users.filter(user => (user.name + " " + user.email).toLowerCase().includes(query));
    await route.fulfill({ json: { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize } });
    return true;
  });
  const { page, check } = fixture;
  let passed = false;
  try {
    await page.goto(origin);
    const editor = page.getByRole("region", { name: "User editor" });
    const list = page.getByRole("region", { name: "User list" });
    const first = list.locator("tbody tr").first();
    await first.waitFor();
    await check("Original create/list headings", async () => {
      assert.equal(await editor.getByRole("heading", { name: "Create Admin User", exact: true }).count(), 1);
      assert.equal(await list.getByRole("heading", { name: "Admin Users", exact: true }).count(), 1);
    });
    await check("Original four table columns", async () => assert.deepEqual(await list.locator("thead th").allTextContents(), ["Name", "Email", "Status", "Actions"]));
    await check("Original row action order and permission target", async () => {
      assert.deepEqual(await first.locator("td:last-child button,td:last-child a").allTextContents(), ["Edit", "Permissions", "Deactivate"]);
      assert.equal(await first.getByRole("link", { name: "Permissions" }).getAttribute("href"), "/settings/permissions/assign?userId=101");
      assert.equal(await list.locator("tbody tr").nth(1).getByRole("button", { name: "Activate", exact: true }).count(), 1);
    });
    await check("Active/inactive badges have distinct source colors", async () => {
      const active = first.locator("td").nth(2).locator(".badge"), inactive = list.locator("tbody tr").nth(1).locator("td").nth(2).locator(".badge");
      assert.equal(await active.textContent(), "Active"); assert.equal(await inactive.textContent(), "Inactive");
      assert.notEqual(await active.evaluate(element => getComputedStyle(element).backgroundColor), await inactive.evaluate(element => getComputedStyle(element).backgroundColor));
    });
    await check("Existing password rule is retained", async () => {
      assert.equal(await editor.locator("#user-password").getAttribute("minlength"), "12");
      assert.equal(await editor.locator("#user-password").getAttribute("required"), "");
    });
    await fixture.capture("users-source-1907.png");
    await page.setViewportSize({ width: 390, height: 844 });
    await check("Phone has no document overflow", async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390));
    await fixture.capture("users-source-390.png");
    await page.setViewportSize({ width: 1907, height: 917 });
    await first.getByRole("button", { name: "Edit", exact: true }).click();
    await editor.getByRole("heading", { name: "Edit Admin User", exact: true }).waitFor();
    await check("Edit loads the exact URL target through its protected GET", async () => {
      assert.equal(new URL(page.url()).searchParams.get("editId"), users[0]!.id);
      assert.ok(fixture.requests.includes("GET /api/settings/users/" + users[0]!.id));
      assert.equal(await editor.getByRole("heading", { name: "Edit Admin User", exact: true }).count(), 1);
      assert.equal(await editor.locator("#user-name").inputValue(), users[0]!.name);
      assert.equal(await editor.locator("#user-password").inputValue(), "");
      assert.equal(await editor.locator("#user-password").getAttribute("required"), null);
    });
    await editor.locator("#user-name").fill("Unsaved synthetic change");
    await editor.getByRole("button", { name: "Cancel editing", exact: true }).click();
    await editor.getByRole("heading", { name: "Create Admin User", exact: true }).waitFor();
    await first.waitFor();
    await check("Cancel discards only the local form draft", async () => {
      assert.equal(await editor.locator("#user-name").inputValue(), "");
      assert.equal(await first.locator("td").first().textContent(), users[0]!.name);
    });
    const requestsBeforeCancel = fixture.requests.length;
    const dialog = page.waitForEvent("dialog");
    const click = first.getByRole("button", { name: "Deactivate", exact: true }).click();
    const confirmation = await dialog;
    await check("Status action requires original confirmation", () => {
      assert.equal(confirmation.type(), "confirm"); assert.equal(confirmation.message(), "Change user status?");
    });
    await confirmation.dismiss(); await click;
    await check("Cancel status produces no request and retains current status", async () => {
      assert.equal(fixture.requests.length, requestsBeforeCancel);
      assert.equal(await first.locator("td").nth(2).textContent(), "Active");
    });
    await list.getByRole("button", { name: "Next page", exact: true }).click();
    await list.getByText(users[25]!.name, { exact: true }).waitFor();
    await check("Pagination reaches remaining users", async () => {
      assert.equal(await list.locator("tbody tr").count(), 1);
      assert.equal(await list.getByRole("button", { name: "Next page", exact: true }).isDisabled(), true);
    });
    await list.getByLabel("Search users").fill("Admin 001");
    await list.getByRole("button", { name: "Search", exact: true }).click();
    await list.getByText(users[0]!.name, { exact: true }).waitFor();
    await check("Search resets to first page and filters users", async () => {
      assert.equal(await list.locator("tbody tr").count(), 1);
      assert.equal(await list.getByRole("button", { name: "Previous page", exact: true }).count(), 0);
    });
    await check("All user requests are intercepted GET reads", () => {
      assert.deepEqual(fixture.failures, []);
      assert.equal(fixture.requests.some(request => request.includes("/api/auth/csrf")), false);
      assert.equal(fixture.requests.some(request => request.includes("/api/settings/zoho-users")), false);
    });
    passed = true;
  } finally { await fixture.close(passed); t.diagnostic("Settings users evidence: " + fixture.directory); }
});

test("synced Zoho directory distinguishes linked logins, preserves safe source text, and supports search and pagination", { timeout: 90_000 }, async t => {
  const linked = { ...users[0]!, externalUserId: "5653678000013748025" };
  const directoryUsers: ZohoDirectoryUser[] = Array.from({ length: 27 }, (_, index) => ({
    externalId: index === 0 ? linked.externalUserId : String(7000 + index),
    name: index === 0 ? "Synthetic salesperson <script>alert(1)</script>" : `Synthetic Zoho user ${String(index).padStart(2, "0")}`,
    email: index === 0 ? linked.email : `sales${index}@example.invalid`,
    status: index === 2 ? "inactive" : "active", sourceState: index === 1 ? "conflict" : "active",
    sourceModifiedAt: "2026-10-20T06:00:00Z", lastSyncedAt: "2026-10-21T06:00:00Z",
    linkedUser: index < 2 ? { id: linked.id, name: linked.name, email: linked.email, status: index === 1 ? "inactive" : "active" } : null,
    linkState: index === 0 ? "linked" : index === 1 ? "review-required" : "unlinked",
  }));
  const fixture = await browserFixture("users", async (route, url) => {
    if (url.pathname === "/api/capabilities") { await route.fulfill({ json: { persistence: "local-mysql", zohoInbound: true } }); return true; }
    if (url.pathname === "/api/settings/users/" + linked.id) { await route.fulfill({ json: linked }); return true; }
    if (url.pathname === "/api/settings/users") { await route.fulfill({ json: { items: [linked], total: 1, page: 1, pageSize: 25 } }); return true; }
    if (url.pathname !== "/api/settings/zoho-users") return false;
    const query = (url.searchParams.get("query") ?? "").toLowerCase();
    if (query === "failure") { await route.fulfill({ status: 503, json: { error: "Directory temporarily unavailable." } }); return true; }
    const page = Number(url.searchParams.get("page")), pageSize = Number(url.searchParams.get("pageSize"));
    const filtered = directoryUsers.filter(user => (user.name + " " + user.email).toLowerCase().includes(query));
    await route.fulfill({ json: { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize } }); return true;
  });
  const { page, check } = fixture; let passed = false;
  try {
    await page.goto(origin);
    const directory = page.getByRole("region", { name: "Zoho user directory", exact: true });
    await directory.locator("tbody tr").first().waitFor();
    await check("Directory shows source users without creating local logins", async () => {
      assert.equal(await directory.locator("tbody tr").count(), 25);
      assert.equal(await directory.getByText("Linked", { exact: true }).count(), 1);
      assert.equal(await directory.getByText("Link needs review", { exact: true }).count(), 1);
      assert.equal(await directory.getByText("Inactive login", { exact: true }).count(), 1);
      assert.equal(await directory.getByText("No linked login", { exact: true }).count(), 23);
      assert.equal(await directory.getByRole("button", { name: /create|activate|link/i }).count(), 0);
      assert.equal(await directory.locator("tbody tr").first().getByRole("link").getAttribute("href"), "/settings/users?editId=" + linked.id);
      assert.equal(await directory.locator("time").first().getAttribute("datetime"), directoryUsers[0]!.lastSyncedAt);
    });
    await check("Source names render literally without executable markup", async () => {
      assert.equal(await directory.getByText(directoryUsers[0]!.name!, { exact: true }).count(), 1);
      assert.equal(await directory.locator("script,img").count(), 0);
    });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await check(`Directory stays within the ${width}px document`, async () => {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        const table = await directory.getByRole("region", { name: "Zoho CRM users", exact: true }).boundingBox();
        assert.ok(table && table.x >= 0 && table.x + table.width <= width);
      });
      await fixture.capture(`zoho-users-${width}.png`);
    }
    await directory.getByRole("button", { name: "Next page", exact: true }).click();
    await directory.getByText(directoryUsers[26]!.name!, { exact: true }).waitFor();
    await check("Pagination reaches source users beyond the first page", async () => assert.equal(await directory.locator("tbody tr").count(), 2));
    await directory.getByLabel("Search Zoho users").fill("sales26@");
    await directory.getByRole("button", { name: "Search", exact: true }).click();
    await directory.getByText(directoryUsers[26]!.name!, { exact: true }).waitFor();
    await check("Search resets the directory page and filters email", async () => {
      assert.equal(await directory.locator("tbody tr").count(), 1);
      assert.equal(await directory.getByRole("button", { name: "Previous page", exact: true }).isDisabled(), true);
    });
    await directory.getByLabel("Search Zoho users").fill("no matching user");
    await directory.getByRole("button", { name: "Search", exact: true }).click();
    await directory.getByText("No Zoho users match your search.", { exact: true }).waitFor();
    await directory.getByLabel("Search Zoho users").fill("failure");
    await directory.getByRole("button", { name: "Search", exact: true }).click();
    await directory.getByRole("alert").waitFor();
    await check("A failed read shows an error without stale directory rows", async () => {
      assert.equal(await directory.getByRole("alert").textContent(), "Directory temporarily unavailable.");
      assert.equal(await directory.locator("tbody tr").count(), 0);
    });
    await directory.getByLabel("Search Zoho users").fill("Synthetic salesperson");
    await directory.getByRole("button", { name: "Search", exact: true }).click();
    await directory.getByText(directoryUsers[0]!.name!, { exact: true }).waitFor();
    const before = fixture.requests.filter(request => request.startsWith("GET /api/settings/zoho-users?")).length;
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/settings/zoho-users");
    await directory.getByRole("button", { name: "Refresh Zoho users", exact: true }).click(); await refreshed;
    await directory.getByText(directoryUsers[0]!.name!, { exact: true }).waitFor();
    await check("Refresh reloads saved directory data once", () => assert.equal(fixture.requests.filter(request => request.startsWith("GET /api/settings/zoho-users?")).length, before + 1));
    await directory.locator("tbody tr").first().getByRole("link").click();
    const identity = page.getByRole("group", { name: "Zoho assignment identity", exact: true });
    await identity.waitFor();
    await check("Linked directory account opens the exact editor and preserves its external identity", async () => {
      assert.equal(new URL(page.url()).searchParams.get("editId"), linked.id);
      assert.equal(await identity.locator("strong").textContent(), linked.externalUserId);
    });
    await check("Directory interaction performs GET reads only", () => { assert.deepEqual(fixture.failures, []); assert.ok(fixture.requests.every(request => request.startsWith("GET "))); });
    passed = true;
  } finally { await fixture.close(passed); t.diagnostic("Zoho user directory evidence: " + fixture.directory); }
});

test("source Users long identities retain all four columns and row actions in the desktop viewport", { timeout: 90_000 }, async t => {
  const longUsers = [
    { ...users[0]!, name: "SYNTHETIC DEMO worker-maintenance with an intentionally long display name preserved in full",
      email: "worker-maintenance.0123456789abcdef0123456789abcdef0123456789abcdef@example.invalid" },
    { ...users[1]!, name: "SyntheticUnbrokenIdentity".repeat(5),
      email: "a".repeat(60) + "@" + "longsyntheticdomain".repeat(3) + ".example.invalid" },
  ];
  const fixture = await browserFixture("users", async (route, url) => {
    if (url.pathname !== "/api/settings/users") return false;
    await route.fulfill({ json: { items: longUsers, total: longUsers.length, page: 1, pageSize: 25 } }); return true;
  });
  const { page, check } = fixture;
  let passed = false;
  try {
    await page.goto(origin);
    const region = page.getByRole("region", { name: "Admin Users", exact: true });
    await region.locator("tbody tr").first().waitFor();
    for (const width of [1440, 1907]) {
      await page.setViewportSize({ width, height: 1000 });
      await check(`All four columns and every row action fit at ${width}px without table scrolling`, async () => {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        const geometry = await region.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          const targets = [...element.querySelectorAll("th,td:nth-child(3) .badge,td:last-child button,td:last-child a")];
          return { overflow: element.scrollWidth - element.clientWidth, scrollLeft: element.scrollLeft,
            outside: targets.filter(target => { const rect = target.getBoundingClientRect(); return rect.left < bounds.left - 1 || rect.right > bounds.right + 1; }).map(target => target.textContent) };
        });
        assert.ok(geometry.overflow <= 1, `Desktop user table overflows by ${geometry.overflow}px`);
        assert.equal(geometry.scrollLeft, 0); assert.deepEqual(geometry.outside, []);
        assert.deepEqual(await region.locator("thead th").allTextContents(), ["Name", "Email", "Status", "Actions"]);
        for (let index = 0; index < longUsers.length; index++) {
          const row = region.locator("tbody tr").nth(index);
          assert.equal(await row.locator("td").nth(0).textContent(), longUsers[index]!.name);
          assert.equal(await row.locator("td").nth(1).textContent(), longUsers[index]!.email);
          assert.deepEqual(await row.locator("td:last-child button,td:last-child a").allTextContents(), ["Edit", "Permissions", index ? "Activate" : "Deactivate"]);
          assert.equal(await row.getByRole("link", { name: "Permissions" }).getAttribute("href"), `/settings/permissions/assign?userId=${longUsers[index]!.id}`);
          const wrapped = await row.locator("td:nth-child(-n+2)").evaluateAll(cells => cells.every(cell => {
            const content = cell.firstElementChild!; const style = getComputedStyle(cell);
            return style.whiteSpace === "normal" && style.overflowWrap === "anywhere" && content.scrollWidth <= content.clientWidth + 1;
          }));
          assert.equal(wrapped, true, "Full identity text must wrap inside its original cell, without truncation or overlap");
        }
      });
      await fixture.capture(`users-long-identities-${width}.png`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await check("Phone keeps the wide four-column table inside its own scroll region", async () => {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
      assert.ok(await region.evaluate(element => element.scrollWidth > element.clientWidth));
      await region.evaluate(element => { element.scrollLeft = element.scrollWidth; });
      const visibleActions = await region.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return [...element.querySelectorAll("td:last-child button,td:last-child a")].every(target => {
          const rect = target.getBoundingClientRect(); return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
        });
      });
      assert.equal(visibleActions, true);
    });
    await fixture.capture("users-long-identities-390-actions.png");
    await check("Layout verification performs only intercepted reads", () => {
      assert.deepEqual(fixture.failures, []);
      assert.equal(fixture.requests.some(request => request.startsWith("POST ") || request.startsWith("PATCH ")), false);
    });
    passed = true;
  } finally { await fixture.close(passed); t.diagnostic("Settings long-identity evidence: " + fixture.directory); }
});

test("source permission selector loads complete choices and holds assignment target until explicit Load", { timeout: 90_000 }, async t => {
  let releaseSecond: (() => void) | undefined;
  const heldSecond = new Promise<void>(resolveHeld => { releaseSecond = resolveHeld; });
  const fixture = await browserFixture("grants", async (route, url) => {
    if (url.pathname === "/api/settings/grant-users") {
      const page = Number(url.searchParams.get("page")), pageSize = Number(url.searchParams.get("pageSize"));
      await route.fulfill({ json: { items: grantUsers.slice((page - 1) * pageSize, page * pageSize), total: grantUsers.length, page, pageSize } }); return true;
    }
    if (url.pathname === "/api/settings/permission-groups" || url.pathname === "/api/settings/permissions") {
      const items = url.pathname.endsWith("permission-groups") ? groups : permissions;
      await route.fulfill({ json: { items, total: items.length, page: 1, pageSize: 100 } }); return true;
    }
    if (url.pathname === "/api/settings/users/101/permissions" || url.pathname === "/api/settings/users/201/permissions") {
      const second = url.pathname.includes("/201/");
      if (second) await heldSecond;
      await route.fulfill({ json: { user: grantUsers[second ? 100 : 0], permissionIds: second ? ["2", "4"] : ["1", "3"], version: 1 } }); return true;
    }
    return false;
  });
  const { page, check } = fixture;
  let passed = false;
  try {
    await page.goto(origin);
    const selector = page.getByLabel("Admin user", { exact: true });
    await selector.locator('option[value="201"]').waitFor({ state: "attached" });
    await check("Plain Admin user selector includes all authorized pages", async () => {
      assert.equal(await selector.evaluate(element => element.tagName), "SELECT");
      assert.equal(await selector.locator("option").count(), 102);
      assert.equal(await selector.locator("option").first().textContent(), "Select admin");
      assert.equal(fixture.requests.some(request => request.includes("grant-users?page=2&pageSize=100")), true);
      assert.equal(await page.getByRole("button", { name: "Load", exact: true }).count(), 1);
      assert.ok((await page.getByRole("button", { name: "Load", exact: true }).boundingBox())!.width < (await selector.boundingBox())!.width);
    });
    await check("Initial permissions remain unloaded", async () => {
      assert.equal(await page.getByText("Please select an admin user to assign permissions.", { exact: true }).count(), 1);
      assert.equal(fixture.requests.some(request => /\/users\/\d+\/permissions/.test(request)), false);
    });
    await fixture.capture("permissions-initial-1907.png");
    await page.setViewportSize({ width: 390, height: 844 });
    await check("Initial phone selector has no document overflow", async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390));
    await fixture.capture("permissions-initial-390.png");
    await page.setViewportSize({ width: 1907, height: 917 });
    await selector.selectOption("101");
    await check("Choosing an admin alone does not fetch assignments", () => assert.equal(fixture.requests.some(request => /\/users\/\d+\/permissions/.test(request)), false));
    await page.getByRole("button", { name: "Load", exact: true }).click();
    await page.getByRole("checkbox", { name: "View dashboard", exact: true }).waitFor();
    const assignment = page.getByRole("region", { name: "Permission assignment" });
    await check("Explicit Load initializes the complete current grant set", async () => {
      assert.equal(await assignment.getByRole("heading", { name: "Permissions", exact: true }).count(), 1);
      assert.equal(await page.getByText("Editing permissions for " + grantUsers[0]!.name, { exact: true }).count(), 1);
      assert.equal(await assignment.getByRole("checkbox").count(), 4);
      assert.equal(await assignment.getByRole("checkbox", { name: "View dashboard", exact: true }).isChecked(), true);
      assert.equal(await assignment.getByRole("checkbox", { name: "View reports", exact: true }).isChecked(), true);
      assert.equal(await assignment.getByRole("checkbox", { name: "Manage leads", exact: true }).isChecked(), false);
      assert.deepEqual(await assignment.locator('input[name="permissions[]"]').evaluateAll(elements => elements.map(element => (element as HTMLInputElement).value)), ["1", "2", "3", "4"]);
      assert.equal(await assignment.getByRole("button", { name: "Save", exact: true }).count(), 1);
      assert.equal(await assignment.getByRole("link", { name: "Back", exact: true }).getAttribute("href"), "/settings/users");
    });
    await fixture.capture("permissions-loaded-1907.png");
    await page.setViewportSize({ width: 390, height: 844 });
    await check("Loaded permission phone page has no document overflow", async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390));
    await fixture.capture("permissions-loaded-390.png");
    await page.setViewportSize({ width: 1907, height: 917 });
    await assignment.getByRole("checkbox", { name: "Manage leads", exact: true }).check();
    await selector.selectOption("201");
    await check("Pending admin choice retains the loaded draft and target", async () => {
      assert.equal(await page.getByText("Editing permissions for " + grantUsers[0]!.name, { exact: true }).count(), 1);
      assert.equal(await assignment.getByRole("checkbox", { name: "Manage leads", exact: true }).isChecked(), true);
      assert.equal(fixture.requests.some(request => request.includes("/users/201/permissions")), false);
    });
    await assignment.getByLabel("Find permissions").fill("View reports");
    await assignment.getByRole("button", { name: "Search", exact: true }).click();
    await check("Search filters only display and keeps other draft choices", async () => {
      assert.equal(await assignment.getByRole("checkbox").count(), 1);
      assert.equal(await assignment.getByRole("checkbox", { name: "View reports", exact: true }).isChecked(), true);
    });
    await assignment.getByLabel("Find permissions").fill("");
    await assignment.getByRole("button", { name: "Search", exact: true }).click();
    await check("Clearing search restores the unsaved selection", async () => {
      assert.equal(await assignment.getByRole("checkbox").count(), 4);
      assert.equal(await assignment.getByRole("checkbox", { name: "Manage leads", exact: true }).isChecked(), true);
    });
    await page.getByRole("button", { name: "Load", exact: true }).click();
    await page.getByText("Loading the complete permission catalogue and assignments", { exact: false }).waitFor();
    await check("An incomplete assignment load offers no Save", async () => assert.equal(await assignment.getByRole("button", { name: "Save", exact: true }).count(), 0));
    if (await selector.isEnabled()) await selector.selectOption("101");
    releaseSecond!();
    await page.getByText("Editing permissions for " + grantUsers[100]!.name, { exact: true }).waitFor();
    await check("Delayed response applies only to the explicitly loaded admin", async () => {
      assert.equal(await assignment.getByRole("checkbox", { name: "View dashboard", exact: true }).isChecked(), false);
      assert.equal(await assignment.getByRole("checkbox", { name: "Manage leads", exact: true }).isChecked(), true);
      assert.equal(await assignment.getByRole("checkbox", { name: "View items", exact: true }).isChecked(), true);
      assert.equal(fixture.requests.filter(request => request.includes("/users/101/permissions")).length, 1);
    });
    await check("All permission requests are intercepted GET reads; Save is never submitted", () => {
      assert.deepEqual(fixture.failures, []);
      assert.equal(fixture.requests.some(request => request.includes("/api/auth/csrf")), false);
    });
    passed = true;
  } finally { releaseSecond!(); await fixture.close(passed); t.diagnostic("Settings permissions evidence: " + fixture.directory); }
});

test("a granted deep link outside the selector preserves its exact loaded identity", { timeout: 90_000 }, async t => {
  const linkedUser = { id: "998", name: "Synthetic linked admin", email: "linked@example.invalid" };
  const fixture = await browserFixture("grants", async (route, url) => {
    if (url.pathname === "/api/settings/grant-users") {
      await route.fulfill({ json: { items: [grantUsers[0]], total: 1, page: 1, pageSize: 100 } }); return true;
    }
    if (url.pathname === "/api/settings/permission-groups" || url.pathname === "/api/settings/permissions") {
      const items = url.pathname.endsWith("permission-groups") ? groups : permissions;
      await route.fulfill({ json: { items, total: items.length, page: 1, pageSize: 100 } }); return true;
    }
    if (url.pathname === "/api/settings/users/998/permissions") {
      await route.fulfill({ json: { user: linkedUser, permissionIds: ["3"], version: 2 } }); return true;
    }
    return false;
  }, linkedUser.id);
  let passed = false;
  try {
    const { page, check } = fixture;
    await page.goto(origin);
    await page.getByText("Editing permissions for " + linkedUser.name, { exact: true }).waitFor();
    const selector = page.getByLabel("Admin user", { exact: true });
    await selector.locator('option[value="101"]').waitFor({ state: "attached" });
    await check("Deep link keeps the exact authorized identity outside listed choices", async () => {
      assert.equal(await selector.inputValue(), linkedUser.id);
      assert.equal(await selector.locator('option[value="998"]').textContent(), `${linkedUser.name} (${linkedUser.email})`);
      assert.equal(await page.getByRole("checkbox", { name: "View reports", exact: true }).isChecked(), true);
    });
    const beforeLoad = fixture.requests.length;
    await page.getByRole("button", { name: "Load", exact: true }).click();
    await check("Load cannot silently replace or clear an absent candidate", async () => {
      assert.equal(fixture.requests.length, beforeLoad);
      assert.equal(await selector.inputValue(), linkedUser.id);
      assert.equal(await page.getByText("Editing permissions for " + linkedUser.name, { exact: true }).count(), 1);
    });
    await check("Deep-link fixture never writes or requests another identity", () => {
      assert.deepEqual(fixture.failures, []);
      assert.deepEqual(fixture.requests.filter(request => /\/users\/\d+\/permissions/.test(request)), ["GET /api/settings/users/998/permissions"]);
    });
    passed = true;
  } finally { await fixture.close(passed); t.diagnostic("Settings deep-link evidence: " + fixture.directory); }
});

test("permission Load keeps the URL, reload and browser history bound to the loaded user", { timeout: 90_000 }, async t => {
  const choices = [grantUsers[0]!, grantUsers[1]!];
  const fixture = await browserFixture("grants", async (route, url) => {
    if (url.pathname === "/api/settings/grant-users") {
      await route.fulfill({ json: { items: choices, total: choices.length, page: 1, pageSize: 100 } }); return true;
    }
    if (url.pathname === "/api/settings/permission-groups" || url.pathname === "/api/settings/permissions") {
      const items = url.pathname.endsWith("permission-groups") ? groups : permissions;
      await route.fulfill({ json: { items, total: items.length, page: 1, pageSize: 100 } }); return true;
    }
    const selected = choices.find(user => url.pathname === `/api/settings/users/${user.id}/permissions`);
    if (selected) {
      await route.fulfill({ json: { user: selected, permissionIds: selected.id === choices[0]!.id ? ["1"] : ["2"], version: selected.id === choices[0]!.id ? 7 : 11 } }); return true;
    }
    return false;
  });
  let passed = false;
  try {
    const { page, check } = fixture;
    const selector = page.getByLabel("Admin user", { exact: true });
    async function assertTarget(index: number) {
      const selected = choices[index]!;
      await page.getByText("Editing permissions for " + selected.name, { exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, "/settings/permissions/assign");
      assert.equal(new URL(page.url()).searchParams.get("userId"), selected.id);
      assert.equal(await selector.inputValue(), selected.id);
      assert.equal(await page.getByRole("checkbox", { name: "View dashboard", exact: true }).isChecked(), index === 0);
      assert.equal(await page.getByRole("checkbox", { name: "Manage leads", exact: true }).isChecked(), index === 1);
    }
    await page.goto(origin + "/settings/permissions/assign");
    await selector.locator(`option[value="${choices[1]!.id}"]`).waitFor({ state: "attached" });
    await selector.selectOption(choices[0]!.id);
    await check("Pending selection does not change the URL or load grants", () => {
      assert.equal(new URL(page.url()).search, "");
      assert.equal(fixture.requests.some(request => /\/users\/\d+\/permissions/.test(request)), false);
    });
    await page.getByRole("button", { name: "Load", exact: true }).click();
    await check("Explicit Load records the exact authorized target in the page URL", () => assertTarget(0));
    await page.getByRole("checkbox", { name: "Manage leads", exact: true }).check();
    await selector.selectOption(choices[1]!.id);
    await check("An unsubmitted choice leaves the current loaded target and draft intact", async () => {
      assert.equal(new URL(page.url()).searchParams.get("userId"), choices[0]!.id);
      assert.equal(await page.getByRole("checkbox", { name: "Manage leads", exact: true }).isChecked(), true);
      assert.equal(await page.getByText("Editing permissions for " + choices[0]!.name, { exact: true }).count(), 1);
    });
    await page.getByRole("button", { name: "Load", exact: true }).click();
    await check("Loading another user discards the prior unsaved draft and uses that user's saved grants", () => assertTarget(1));
    await page.reload();
    await check("Reload preserves the URL target and reloads only its own grants", () => assertTarget(1));
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await check(`Loaded target and grant form remain contained at ${width}px`, async () => {
        await assertTarget(1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        const bounds = await selector.boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
      });
      await fixture.capture(`permissions-history-${width}.png`);
    }
    await page.goBack();
    await check("Browser Back restores the prior URL, identity and corresponding saved grants", () => assertTarget(0));
    await page.goForward();
    await check("Browser Forward restores the next URL, identity and corresponding saved grants", () => assertTarget(1));
    await check("Target navigation performs only intercepted GET reads, without CSRF or save", () => {
      assert.deepEqual(fixture.failures, []);
      assert.equal(fixture.requests.some(request => request.includes("/api/auth/csrf") || !request.startsWith("GET ")), false);
    });
    passed = true;
  } finally { await fixture.close(passed); t.diagnostic("Settings target history evidence: " + fixture.directory); }
});

test("department badges preserve PHP trimmed display semantics without normalizing saved roles", { timeout: 90_000 }, async t => {
  const roles = [null, "", "   ", " Civil ", "Unknown department"];
  const rows = roles.map((departmentRole, index) => ({ ...users[index]!, departmentRole }));
  const fixture = await browserFixture("departments", async (route, url) => {
    if (url.pathname !== "/api/settings/users") return false;
    await route.fulfill({ json: { items: rows, total: rows.length, page: 1, pageSize: 25 } }); return true;
  });
  let passed = false;
  try {
    const { page, check } = fixture;
    await page.goto(origin);
    const badges = page.getByRole("region", { name: "Department assignments", exact: true }).locator("tbody td:nth-child(3) .badge");
    await badges.last().waitFor();
    await check("Null, empty and whitespace values use the source Not Assigned label", async () => {
      assert.deepEqual(await badges.allTextContents(), ["Not Assigned", "Not Assigned", "Not Assigned", "Civil", "Unknown department"]);
      assert.deepEqual(await badges.evaluateAll(elements => elements.map(element => element.className)),
        ["badge bg-secondary", "badge bg-secondary", "badge bg-secondary", "badge bg-primary", "badge bg-primary"]);
    });
    await check("Display normalization neither invents a known role nor submits a write", () => {
      assert.deepEqual(rows.map(row => row.departmentRole), roles);
      assert.deepEqual(fixture.failures, []);
      assert.ok(fixture.requests.every(request => request.startsWith("GET ")));
    });
    passed = true;
  } finally { await fixture.close(passed); t.diagnostic("Department empty-role evidence: " + fixture.directory); }
});

test("user edit URLs reload current records and restore the exact target through browser history", { timeout: 90_000 }, async t => {
  const fixture = await browserFixture("users", async (route, url) => {
    if (url.pathname !== "/api/settings/users") return false;
    await route.fulfill({ json: { items: users.slice(0, 2), total: 2, page: 1, pageSize: 25 } }); return true;
  });
  let passed = false;
  try {
    const { page, check } = fixture;
    const editor = page.getByRole("region", { name: "User editor", exact: true });
    async function assertTarget(index: number) {
      await editor.getByRole("heading", { name: "Edit Admin User", exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get("editId"), users[index]!.id);
      assert.equal(await editor.locator("#user-name").inputValue(), users[index]!.name);
      assert.equal(await editor.locator("#user-email").inputValue(), users[index]!.email);
      assert.equal(await editor.locator("#user-password").inputValue(), "");
    }
    await page.goto(origin + "/settings/users");
    await page.getByRole("region", { name: "User list" }).locator("tbody tr").first().getByRole("button", { name: "Edit", exact: true }).click();
    await check("Edit reads the exact URL user", () => assertTarget(0));
    await editor.locator("#user-name").fill("Unsaved synthetic user draft");
    await page.reload();
    await check("Reload restores saved data without persisting the draft", () => assertTarget(0));
    await page.getByRole("region", { name: "User list" }).locator("tbody tr").nth(1).getByRole("button", { name: "Edit", exact: true }).click();
    await check("Second Edit loads another current user", () => assertTarget(1));
    await page.goBack(); await check("Back restores the first URL identity and saved form", () => assertTarget(0));
    await page.goForward(); await check("Forward restores the second URL identity and saved form", () => assertTarget(1));
    await editor.getByRole("button", { name: "Cancel editing", exact: true }).click();
    await editor.getByRole("heading", { name: "Create Admin User", exact: true }).waitFor();
    await check("Cancel returns to the create/list URL without writing", async () => {
      assert.equal(new URL(page.url()).search, "");
      assert.equal(await editor.locator("#user-name").inputValue(), "");
      assert.deepEqual(fixture.failures, []);
      assert.ok(fixture.requests.every(request => request.startsWith("GET ")));
    });
    passed = true;
  } finally { await fixture.close(passed); t.diagnostic("User edit history evidence: " + fixture.directory); }
});

test("invalid, denied and mismatched user edit targets never expose an editor or request a mutation", { timeout: 90_000 }, async t => {
  const fixture = await browserFixture("users", async (route, url) => {
    if (url.pathname === "/api/settings/users/998") { await route.fulfill({ status: 403, json: { error: "Access denied." } }); return true; }
    if (url.pathname === "/api/settings/users/999") { await route.fulfill({ json: users[0] }); return true; }
    return false;
  });
  let passed = false;
  try {
    const { page, check } = fixture;
    for (const [id, error] of [["../101", "Invalid edit target."], ["998", "Access denied."], ["999", "The edit response does not match the selected record."]]) {
      await page.goto(origin + "/settings/users?editId=" + encodeURIComponent(id!));
      await page.getByRole("alert").waitFor();
      await check(`Target ${id} fails closed`, async () => {
        assert.equal(await page.getByRole("alert").textContent(), error);
        assert.equal(await page.getByRole("region", { name: "User editor", exact: true }).count(), 0);
        assert.equal(await page.getByRole("button", { name: "Save user", exact: true }).count(), 0);
      });
    }
    await check("Refused targets never fetch a different ID or submit a write", () => {
      assert.deepEqual(fixture.failures, []);
      assert.deepEqual(fixture.requests.filter(request => request.includes("/api/settings/users")), ["GET /api/settings/users/998", "GET /api/settings/users/999"]);
      assert.ok(fixture.requests.every(request => request.startsWith("GET ")));
    });
    passed = true;
  } finally { await fixture.close(passed); t.diagnostic("User edit refusal evidence: " + fixture.directory); }
});
