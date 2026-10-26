import { preservedSource } from "./helpers/preserved-source";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { chromium, type Route } from "playwright";
import { loadCatalogGroups } from "../src/components/settings/catalog-manager";

const groups = Array.from({ length: 101 }, (_, index) => ({ id: String(index + 1), key: `synthetic_group_${index + 1}`,
  label: `Synthetic Group ${index + 1}`, sortOrder: index, version: 3 }));
const permission = { id: "991", key: "synthetic.permission", label: "Synthetic permission", groupId: "101", groupLabel: "Synthetic Group 101", version: 7 };
const firstPage = { items: groups.slice(0, 100), total: 101, page: 1, pageSize: 100 };
const lastPage = { items: groups.slice(100), total: 101, page: 2, pageSize: 100 };
const origin = "http://127.0.0.1:39991";

test("catalog native group choices require complete, consistent, unique authorized pages", async () => {
  const paths: string[] = [];
  assert.deepEqual(await loadCatalogGroups(async path => { paths.push(path); return paths.length === 1 ? firstPage : lastPage; }), groups);
  assert.deepEqual(paths, ["/api/settings/permission-groups?page=1&pageSize=100", "/api/settings/permission-groups?page=2&pageSize=100"]);
  for (const broken of [{ ...lastPage, total: 102 }, { ...lastPage, items: [] }, { ...lastPage, page: 1 },
    { ...lastPage, pageSize: 25 }, { ...lastPage, items: [groups[0]] }, { ...lastPage, items: [{ ...groups[100], id: "-1" }] }]) {
    let calls = 0;
    await assert.rejects(loadCatalogGroups(async () => ++calls === 1 ? firstPage : broken), /complete permission group list/);
  }
  await assert.rejects(loadCatalogGroups(async () => ({ ...firstPage, total: 10_001 })), /complete permission group list/);
  await assert.rejects(loadCatalogGroups(async () => { throw new Error("Access denied."); }), /Access denied/);
  const controller = new AbortController();
  await assert.rejects(loadCatalogGroups(async () => { controller.abort(); return firstPage; }, controller.signal), { name: "AbortError" });
  assert.deepEqual(await loadCatalogGroups(async () => ({ items: [], total: 0, page: 1, pageSize: 100 })), []);
});

async function fixture(kind: "groups" | "permissions", override?: (route: Route, url: URL) => Promise<boolean>) {
  const directory = resolve(".local-data", "reports", `catalog-source-${kind}-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const bundle = await build({ stdin: { contents: `import{createRoot}from'react-dom/client';import{SettingsEditTarget}from'./src/components/settings/edit-target';createRoot(document.getElementById('root')).render(<div className="crm-app"><main className="crm-page"><SettingsEditTarget kind="${kind}" editId={new URLSearchParams(location.search).get('editId') ?? ''}/></main></div>);`,
    loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, jsx: "automatic", format: "iife", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "next-link-stub", setup(builder) {
      builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "import React from'react';export default function Link(props){return React.createElement('a',props)}", loader: "js", resolveDir: process.cwd() }));
    } }] });
  const css = (await Promise.all(["src/app/globals.css", "public/legacy/assets/css/hrms.css", "public/legacy/assets/css/style.css"].map(path => readFile(path, "utf8"))))
    .join("\n").replace(/@font-face\s*\{[^}]*\}/g, "").replace(/@import[^;]+;/g, "");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  page.setDefaultTimeout(10_000);
  const requests: string[] = [], failures: string[] = [], writes: { path: string; method: string; body: unknown; csrf: string | undefined }[] = [];
  page.on("pageerror", error => failures.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push(request.method() + " " + url.pathname + url.search);
    if (url.origin !== origin) { failures.push("Unexpected network origin"); return route.abort(); }
    if (override && await override(route, url)) return;
    if (url.pathname === "/" || url.pathname === "/settings/" + (kind === "groups" ? "permission-groups" : kind)) return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><style>${css}</style></head><body data-pc-preset="preset-1" data-pc-theme="light"><div id="root"></div><script src="/fixture.js"></script></body></html>` });
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
    if (url.pathname === "/api/auth/csrf") return route.fulfill({ json: { csrfToken: "synthetic-fixture-token" } });
    if (request.method() !== "GET") {
      writes.push({ path: url.pathname, method: request.method(), body: request.postDataJSON(), csrf: request.headers()["x-csrf-token"] });
      return route.fulfill({ json: kind === "groups" ? groups[0] : permission });
    }
    if (/^\/api\/settings\/(permission-groups|permissions)$/.test(url.pathname)) {
      const items = url.pathname.endsWith("permission-groups") ? groups : [permission];
      const current = Number(url.searchParams.get("page")), size = Number(url.searchParams.get("pageSize"));
      return route.fulfill({ json: { items: items.slice((current - 1) * size, current * size), total: items.length, page: current, pageSize: size } });
    }
    const record = kind === "groups" ? groups.find(group => url.pathname === "/api/settings/permission-groups/" + group.id)
      : url.pathname === "/api/settings/permissions/" + permission.id ? permission : undefined;
    if (record) return route.fulfill({ json: record });
    failures.push("Unexpected fixture request " + request.method() + " " + url.pathname); return route.abort();
  });
  return { page, directory, requests, writes, failures,
    async capture(name: string) { await page.screenshot({ path: join(directory, name), fullPage: true, animations: "disabled" }); },
    async close(passed: boolean) {
      await browser.close();
      await writeFile(join(directory, "receipt.json"), JSON.stringify({ status: passed ? "PASS" : "FAIL", scope: "All requests intercepted against synthetic fixtures; no credentials, live server or database access.", requests, writes, failures }, null, 2), { flag: "wx" });
    } };
}

for (const kind of ["groups", "permissions"] as const) test(`source ${kind} labels, native choices, responsive table and edit/cancel preserve local drafts only`, { timeout: 90_000 }, async t => {
  const f = await fixture(kind), { page } = f; let passed = false;
  try {
    await page.goto(origin);
    const editor = page.getByRole("region", { name: "Definition editor", exact: true });
    const list = page.getByRole("region", { name: "Definition list", exact: true });
    await list.locator("tbody tr").first().waitFor();
    assert.equal(await editor.getByRole("heading", { name: kind === "groups" ? "Create Permission Group" : "Create Permission", exact: true }).count(), 1);
    assert.deepEqual(await list.locator("th").allTextContents(), ["Key", "Label", kind === "groups" ? "Order" : "Group", "Action"]);
    assert.equal(await editor.locator("#catalog-key").getAttribute("placeholder"), kind === "groups" ? "e.g. employees" : "e.g. employees.read");
    assert.equal(await editor.getByText("Cannot be changed later", { exact: true }).count(), 1);
    if (kind === "permissions") {
      await page.waitForFunction(() => document.querySelectorAll("#catalog-group option").length === 102);
      assert.equal(await editor.locator("#catalog-group option").first().textContent(), "-- Select Group --");
      assert.equal(await editor.getByLabel("Find permission group", { exact: true }).count(), 0);
    }
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      const box = await editor.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= width);
      const table = list.getByRole("region"), action = list.locator("tbody tr").first().getByRole("button", { name: "Edit", exact: true });
      await action.scrollIntoViewIfNeeded();
      const tableBounds = await table.boundingBox(), actionBounds = await action.boundingBox();
      // Chromium rounds scrollLeft to device pixels while button bounds retain fractions.
      assert.ok(tableBounds && actionBounds && actionBounds.x >= tableBounds.x - 1 && actionBounds.x + actionBounds.width <= tableBounds.x + tableBounds.width + 1,
        JSON.stringify({ width, tableBounds, actionBounds, scroll: await table.evaluate(element => ({ left: element.scrollLeft, width: element.clientWidth, total: element.scrollWidth })) }));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await f.capture(`${kind}-${width}.png`);
    }
    await list.locator("tbody tr").first().getByRole("button", { name: "Edit", exact: true }).click();
    assert.equal(await editor.locator("#catalog-key").getAttribute("readonly"), "");
    assert.equal(await editor.locator("#catalog-key").inputValue(), kind === "groups" ? groups[0]!.key : permission.key);
    if (kind === "permissions") {
      assert.equal(await editor.getByLabel("Permission group", { exact: true }).inputValue(), "101");
      await editor.getByLabel("Permission group", { exact: true }).selectOption("2");
    }
    await editor.getByLabel("Label", { exact: true }).fill("Unsaved local draft");
    await editor.getByRole("button", { name: "Cancel editing", exact: true }).click();
    assert.equal(await editor.getByLabel("Label", { exact: true }).inputValue(), "");
    if (kind === "permissions") assert.equal(await editor.getByLabel("Permission group", { exact: true }).inputValue(), "");
    assert.deepEqual(f.writes, []); assert.deepEqual(f.failures, []);
    passed = true;
  } finally { await f.close(passed); t.diagnostic("Catalog source fixture evidence: " + f.directory); }
});

for (const scenario of ["incomplete", "unavailable"] as const) test(`${scenario} native permission groups block saves without inventing an authorized option`, { timeout: 90_000 }, async t => {
  const f = await fixture("permissions", async (route, url) => {
    if (url.pathname !== "/api/settings/permission-groups") return false;
    await route.fulfill({ json: scenario === "incomplete" ? { ...firstPage, items: firstPage.items.slice(0, 1) }
      : { ...firstPage, total: 100 } }); return true;
  }); let passed = false;
  try {
    await f.page.goto(origin);
    const editor = f.page.getByRole("region", { name: "Definition editor", exact: true });
    if (scenario === "incomplete") await editor.getByRole("alert").waitFor();
    else await f.page.waitForFunction(() => document.querySelectorAll("#catalog-group option").length === 101);
    assert.equal(await editor.locator("#catalog-group").isDisabled(), scenario === "incomplete");
    assert.equal(await editor.getByRole("button", { name: "Create permission", exact: true }).isDisabled(), true);
    assert.equal(await editor.locator("#catalog-group option").count(), scenario === "incomplete" ? 1 : 101);
    await f.page.getByRole("region", { name: "Definition list", exact: true }).getByRole("button", { name: "Edit", exact: true }).click();
    assert.equal(await editor.getByRole("button", { name: "Save permission", exact: true }).isDisabled(), true);
    assert.equal(await editor.locator('#catalog-group option[value="101"]').isDisabled(), true);
    await editor.locator("form").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    assert.deepEqual(f.writes, []); assert.ok(!f.requests.some(path => path.includes("/api/auth/csrf"))); assert.deepEqual(f.failures, []);
    passed = true;
  } finally { await f.close(passed); t.diagnostic("Catalog unavailable fixture evidence: " + f.directory); }
});

test("permission create/edit requests retain normal CSRF, selected group and current version without editing keys", { timeout: 90_000 }, async t => {
  const f = await fixture("permissions"); let passed = false;
  try {
    await f.page.goto(origin);
    const editor = f.page.getByRole("region", { name: "Definition editor", exact: true });
    await f.page.waitForFunction(() => document.querySelectorAll("#catalog-group option").length === 102);
    await editor.getByLabel("Key", { exact: true }).fill("synthetic.new_permission");
    await editor.getByLabel("Label", { exact: true }).fill("New synthetic permission");
    await editor.getByLabel("Permission group", { exact: true }).selectOption("101");
    await editor.getByRole("button", { name: "Create permission", exact: true }).click();
    await f.page.getByText("Permission saved.", { exact: true }).waitFor();
    await f.page.getByRole("region", { name: "Definition list", exact: true }).getByRole("button", { name: "Edit", exact: true }).click();
    await editor.getByLabel("Label", { exact: true }).fill("Edited synthetic permission");
    await editor.getByLabel("Permission group", { exact: true }).selectOption("2");
    await editor.getByRole("button", { name: "Save permission", exact: true }).click();
    await editor.getByRole("heading", { name: "Create Permission", exact: true }).waitFor();
    assert.equal(new URL(f.page.url()).search, "");
    assert.deepEqual(f.writes, [
      { path: "/api/settings/permissions", method: "POST", body: { label: "New synthetic permission", groupId: "101", key: "synthetic.new_permission" }, csrf: "synthetic-fixture-token" },
      { path: "/api/settings/permissions/991", method: "PATCH", body: { label: "Edited synthetic permission", groupId: "2", version: 7 }, csrf: "synthetic-fixture-token" },
    ]);
    assert.deepEqual(f.failures, []); passed = true;
  } finally { await f.close(passed); t.diagnostic("Catalog request fixture evidence: " + f.directory); }
});

test("source optional group sort order submits zero when cleared in create and edit without changing the key", { timeout: 90_000 }, async t => {
  const source = await readFile(preservedSource("application/views/Permissions/permission_groups.php"), "utf8");
  const input = source.match(/<input\s+type="number"[\s\S]*?name="sort_order"[\s\S]*?>/)?.[0];
  assert.ok(input); assert.ok(!/\brequired\b/.test(input));
  const controller = await readFile(preservedSource("application/controllers/Permissions.php"), "utf8");
  assert.ok(controller.includes("'sort_order' => (int)$this->input->post('sort_order')"));
  const f = await fixture("groups"); let passed = false;
  try {
    await f.page.goto(origin);
    const editor = f.page.getByRole("region", { name: "Definition editor", exact: true });
    await editor.getByLabel("Key", { exact: true }).fill("synthetic_optional_order");
    await editor.getByLabel("Label", { exact: true }).fill("Synthetic optional order");
    await editor.getByLabel("Display order", { exact: true }).fill("");
    assert.equal(await editor.getByLabel("Display order", { exact: true }).evaluate(element => (element as HTMLInputElement).validity.valueMissing), false);
    await editor.getByRole("button", { name: "Create group", exact: true }).click();
    await f.page.getByText("Permission group saved.", { exact: true }).waitFor();
    await f.page.getByRole("region", { name: "Definition list", exact: true }).getByRole("button", { name: "Edit", exact: true }).nth(1).click();
    assert.equal(await editor.getByLabel("Display order", { exact: true }).inputValue(), "1");
    await editor.getByLabel("Label", { exact: true }).fill("Synthetic cleared order");
    await editor.getByLabel("Display order", { exact: true }).fill("");
    await editor.getByRole("button", { name: "Save group", exact: true }).click();
    await editor.getByRole("heading", { name: "Create Permission Group", exact: true }).waitFor();
    assert.equal(new URL(f.page.url()).search, "");
    assert.deepEqual(f.writes, [
      { path: "/api/settings/permission-groups", method: "POST", body: { label: "Synthetic optional order", sortOrder: 0, key: "synthetic_optional_order" }, csrf: "synthetic-fixture-token" },
      { path: "/api/settings/permission-groups/2", method: "PATCH", body: { label: "Synthetic cleared order", sortOrder: 0, version: 3 }, csrf: "synthetic-fixture-token" },
    ]);
    assert.deepEqual(f.failures, []); passed = true;
  } finally { await f.close(passed); t.diagnostic("Optional source sort order fixture evidence: " + f.directory); }
});

for (const kind of ["groups", "permissions"] as const) test(`${kind} edit target survives reload and history while cancel clears only its unsaved draft`, { timeout: 90_000 }, async t => {
  const f = await fixture(kind), { page } = f; let passed = false;
  const path = "/settings/" + (kind === "groups" ? "permission-groups" : kind);
  const record = kind === "groups" ? groups[0]! : permission;
  const editor = page.getByRole("region", { name: "Definition editor", exact: true });
  async function assertTarget() {
    await editor.getByRole("heading", { name: kind === "groups" ? "Edit Permission Group" : "Edit Permission", exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("editId"), record.id);
    assert.equal(await editor.locator("#catalog-key").inputValue(), record.key);
    assert.equal(await editor.locator("#catalog-label").inputValue(), record.label);
    assert.equal(await editor.locator("#catalog-key").getAttribute("readonly"), "");
  }
  try {
    await page.goto(origin + path);
    await page.getByRole("region", { name: "Definition list", exact: true }).getByRole("button", { name: "Edit", exact: true }).first().click();
    await assertTarget();
    await editor.locator("#catalog-label").fill("Unsaved synthetic draft");
    await page.reload(); await assertTarget();
    await editor.getByRole("button", { name: "Cancel editing", exact: true }).click();
    await editor.getByRole("heading", { name: kind === "groups" ? "Create Permission Group" : "Create Permission", exact: true }).waitFor();
    assert.equal(new URL(page.url()).search, "");
    assert.equal(await editor.locator("#catalog-label").inputValue(), "");
    await page.goBack(); await assertTarget();
    await page.goForward();
    await editor.getByRole("heading", { name: kind === "groups" ? "Create Permission Group" : "Create Permission", exact: true }).waitFor();
    assert.deepEqual(f.writes, []); assert.deepEqual(f.failures, []);
    assert.ok(f.requests.every(request => request.startsWith("GET ")));
    passed = true;
  } finally { await f.close(passed); t.diagnostic("Catalog edit history evidence: " + f.directory); }
});
