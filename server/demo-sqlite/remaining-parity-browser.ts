import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
import { privateAccess } from "../scripts/mysql-auth/files.js";
import { acknowledgement, access, backendRoot, dataRoot, demoConfiguration, openDemo, privateDirectory, readPrivate, writePrivateNew } from "./storage.js";
import { allowedPercentageReadbackRequest } from "./percentage-browser.js";
import { captureChildEnvironment, settleCapturePage } from "./ui-capture.js";
import { preflightDemoSessionPolicy } from "./verification-scope.js";
import { sourceWorkerStatusLabels } from "./source-worker-status-labels.js";

const origin = "http://127.0.0.1:3001";
const flag = "--read-only-account-owner-20261013";
type Json = Record<string, unknown>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function snapshot() {
  const db = openDemo(true);
  try {
    return db.transaction(() => {
      assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
      assert.deepEqual(db.pragma("foreign_key_check"), []);
      const tables: Record<string, { count: number; sha256: string }> = {};
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]) {
        assert.match(name, /^[a-z_]+$/i);
        const rows = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
        tables[name] = { count: rows.length, sha256: hash(rows) };
      }
      return { tables, rows: Object.values(tables).reduce((sum, table) => sum + table.count, 0),
        schema: hash(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()),
        ownerSession: hash(db.prepare("SELECT * FROM crm_sessions WHERE user_id=15 ORDER BY token_hash").all()) };
    })();
  } finally { db.close(); }
}
async function json(page: Page, path: string) {
  assert.match(path, /^\/api\/[a-zA-Z0-9/_?=&.-]+$/);
  return page.evaluate(async target => {
    const response = await fetch(target, { cache: "no-store", credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(15000) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }, path);
}

export async function runRemainingParity(formsOnly = false, quotationsOnly = false, productsOnly = false, sourceOnly = false, sourceRemaining = false) {
  demoConfiguration(process.env);
  preflightDemoSessionPolicy("preserve-existing", { minimumRemainingMs: 120_000 });
  const directory = privateDirectory(["evidence", "remaining-parity-" + randomUUID()], true);
  const before = snapshot();
  const receipt = { status: "FAIL", scope: sourceRemaining ? "Outstanding quotation layout and PM/Switchgear/Maintenance/restrictive source checks; GET/HEAD and normal login/logout only" : sourceOnly ? "PHP-source navigation, lists, permission target and recorded job details; GET/HEAD and normal login/logout only" : productsOnly ? "Outstanding source product selection; GET/HEAD and normal owner login/logout only" : quotationsOnly ? "Historical/current quotation policy, recorded dates, PDF and source product selection; GET/HEAD and normal owner login/logout only" : formsOnly ? "Final restored dialogs/worker forms/pipeline capture; GET/HEAD and normal login/logout only" : "New source-based responsive/navigation/form checks; GET/HEAD and normal login/logout only", startedAt: new Date().toISOString(), finishedAt: "", directory,
    checks: [] as { name: string; status: string }[], images: [] as { filename: string; width: number; documentWidth: number }[],
    pageErrors: 0, blockedRequests: 0, businessWrites: 0, logins: 0, logouts: 0, before, after: undefined as ReturnType<typeof snapshot> | undefined,
    stage: "Preflight", diagnostic: undefined as string | undefined };
  const fixture = access().fixture;
  const owner = readPrivate(join(dataRoot, "browser-login-20261012-8ffdfce6.json")) as Json;
  assert.equal(String(owner.accountId), "15");
  const identities = [ { id: "15", email: String(owner.email), password: String(owner.password), department: "" },
    ...(["Electrical", "Civil", "PM", "Switchgear", "Maintenance"] as const).map(department => ({ ...fixture.identities.workers[department], department })),
    { ...fixture.identities.switchgear, department: "" } ];
  assert.deepEqual(identities.map(identity => identity.id), ["15", "6", "7", "8", "9", "10", "5"]);
  const browser = await chromium.launch({ headless: true, env: captureChildEnvironment() as Record<string, string> });
  async function check(name: string, action: () => Promise<void>) {
    receipt.stage = name;
    try { await action(); receipt.checks.push({ name, status: "PASS" }); }
    catch (error) {
      let detail = error instanceof Error ? error.message : "Unknown failure";
      for (const identity of identities) detail = detail.replaceAll(identity.email, "[redacted-email]").replaceAll(identity.password, "[redacted-password]");
      receipt.diagnostic = detail.slice(0, 2000);
      receipt.checks.push({ name, status: "FAIL" }); throw new Error("Read-only parity check failed: " + name, { cause: error });
    }
  }
  async function goto(page: Page, path: string) {
    assert.equal((await page.goto(origin + path, { waitUntil: "domcontentloaded" }))?.status(), 200);
    await settleCapturePage(page);
    assert.equal(await page.locator('.crm-content-body [role="alert"],.auth-form [role="alert"]').count(), 0, "Unexpected application alert");
  }
  async function capture(page: Page, name: string, width: number) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 1024 }); await settleCapturePage(page);
    await page.evaluate(async () => {
      document.documentElement.style.scrollBehavior = "auto"; document.body.style.scrollBehavior = "auto";
      (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo({ top: 0, left: 0, behavior: "instant" });
      await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    });
    const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth); assert.ok(documentWidth <= width + 1, name + " document overflow");
    assert.equal(await page.locator(".pc-header").evaluate(element => Math.abs(element.getBoundingClientRect().top) < 2), true);
    const filename = `${name}-${width}.png`; await page.screenshot({ path: join(directory, filename), fullPage: true, animations: "disabled" }); privateAccess(join(directory, filename), false);
    receipt.images.push({ filename, width, documentWidth });
  }
  async function widths(page: Page, name: string) { for (const width of [1440, 768, 390]) await capture(page, name, width); }
  async function navigation(page: Page, name: string, allowedHref: string) {
    await page.setViewportSize({ width: 1440, height: 1000 }); await settleCapturePage(page);
    await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
    await page.getByRole("button", { name: "Expand navigation", exact: true }).click();
    for (const width of [768, 390]) {
      await page.setViewportSize({ width, height: 1024 }); await settleCapturePage(page);
      const toggle = page.getByRole("button", { name: "Open navigation", exact: true }); await toggle.click();
      assert.equal(await toggle.getAttribute("aria-expanded"), "true");
      assert.equal(await page.locator("main").getAttribute("inert"), "");
      assert.ok(await page.locator(`nav a[href='${allowedHref}']`).count());
      await capture(page, name + "-navigation", width);
      await page.keyboard.press("Escape"); assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      assert.equal(await toggle.evaluate(element => document.activeElement === element), true);
    }
  }
  try {
    for (const identity of sourceRemaining ? [identities[0]!, ...identities.slice(3)] : quotationsOnly ? identities.slice(0, 1) : identities) {
      const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 } }); context.setDefaultTimeout(20000);
      let signedIn = false; const page = await context.newPage();
      page.on("pageerror", () => { receipt.pageErrors++; });
      await context.route("**/*", route => {
        const request = route.request();
        if (allowedPercentageReadbackRequest(request.url(), request.method())) return route.continue();
        receipt.blockedRequests++; return route.abort("blockedbyclient");
      });
      try {
        await check(`User ${identity.id}: normal unchanged-credential login`, async () => {
          await goto(page, "/login"); await page.getByLabel("Email address", { exact: true }).fill(identity.email);
          await page.getByLabel("Password", { exact: true }).fill(identity.password);
          preflightDemoSessionPolicy("preserve-existing", { minimumRemainingMs: 120_000 });
          const [response] = await Promise.all([page.waitForResponse(value => new URL(value.url()).pathname === "/api/auth/login" && value.request().method() === "POST"), page.getByRole("button", { name: /^(Login|Sign in)$/ }).click()]);
          receipt.logins++; assert.equal(response.status(), 200); signedIn = true; await page.waitForURL(url => url.origin === origin && ["/account", "/dashboard"].includes(url.pathname));
          assert.equal(((await json(page, "/api/auth/me")).body.user as Json).localUserId, identity.id);
        });
        if (sourceOnly && sourceRemaining && identity.id === "15") {
          await check("Owner: corrected source quotation account wrapping and status colours at three widths", async () => {
            await goto(page, "/quotations");
            assert.equal(await page.locator(".crm-quotation-list th").count(), 9);
            const account = page.locator(".crm-quotation-list .crm-cell-scroll").first(); await account.waitFor();
            assert.ok(await account.evaluate(element => element.getBoundingClientRect().width <= 261));
            const status = page.locator(".crm-quotation-list .crm-status-active").first(); await status.waitFor();
            assert.equal(await status.evaluate(element => getComputedStyle(element).backgroundColor), "rgb(233, 247, 239)");
            assert.equal(await status.evaluate(element => getComputedStyle(element).color), "rgb(25, 135, 84)");
            await widths(page, "source-quotation-layout-final");
          });
        } else if (sourceOnly) {
          if (!sourceRemaining || identity.id !== "8") await check(`User ${identity.id}: PHP Home and logo use the authorized landing page`, async () => {
            const current = ((await json(page, "/api/auth/me")).body.user as Json);
            const dashboard = (current.permissions as string[]).some(key => ["dashboard.view", "sales_dashboard.view", "electric_dashboard.view", "civil_dashboard.view", "pm_dashboard.view", "switchgear_dashboard.view", "maintenance_dashboard.view"].includes(key));
            const destination = origin + (dashboard ? "/dashboard" : "/account");
            assert.equal(page.url(), destination);
            await goto(page, "/login"); assert.equal(page.url(), destination);
            assert.equal(await page.locator("a.b-brand").getAttribute("href"), "/");
            const home = page.getByRole("link", { name: "Home", exact: true }); assert.equal(await home.getAttribute("href"), "/");
            await home.click(); await page.waitForURL(destination); await settleCapturePage(page);
          });
          if (identity.id === "15") {
            await check("Owner: source item list and create form retain original labels and read-only drafts", async () => {
              await goto(page, "/items");
              assert.deepEqual(await page.locator(".crm-content-body table th").allTextContents(), ["#", "Item Name", "Modified"]);
              assert.ok(await page.getByLabel("Search Items", { exact: true }).isVisible());
              const [resizedItems] = await Promise.all([page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === "/api/items" && url.searchParams.get("pageSize") === "25"; }), page.getByRole("combobox", { name: "Items per page", exact: true }).selectOption("25")]);
              assert.equal(resizedItems.status(), 200); assert.equal((await resizedItems.json()).pageSize, 25);
              const [sortedItems] = await Promise.all([page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === "/api/items" && url.searchParams.get("sort") === "updatedAt"; }), page.getByRole("button", { name: "Sort by Modified", exact: true }).click()]);
              assert.equal(sortedItems.status(), 200); const itemPage = await sortedItems.json() as Json; await settleCapturePage(page);
              assert.deepEqual(await page.locator(".crm-product-list tbody tr td:nth-child(2)").allTextContents(), (itemPage.items as Json[]).map(item => item.name));
              await widths(page, "source-items");
              await goto(page, "/items/new");
              assert.ok(await page.getByRole("heading", { name: "Add New Item", exact: true }).isVisible());
              await page.getByRole("textbox", { name: "Item Name", exact: true }).fill("Unsubmitted source parity draft");
              await page.getByRole("textbox", { name: "Description (Optional)", exact: true }).fill("This draft is never submitted");
              assert.ok(await page.getByRole("button", { name: "Save Item", exact: true }).isVisible()); await widths(page, "source-item-create");
            });
            await check("Owner: source quotation list columns and actual deal/download links", async () => {
              await goto(page, "/quotations");
              assert.deepEqual(await page.locator(".crm-content-body table th").allTextContents(), ["Quote Created", "Quote Number", "Deal Number", "Account Name", "Deal Status", "Overall Status", "Salesperson", "Amount", "Action"]);
              const [resizedQuotes] = await Promise.all([page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === "/api/quotations" && url.searchParams.get("pageSize") === "25"; }), page.getByRole("combobox", { name: "Quotations per page", exact: true }).selectOption("25")]);
              assert.equal(resizedQuotes.status(), 200); assert.equal((await resizedQuotes.json()).pageSize, 25);
              const [sortedQuotes] = await Promise.all([page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === "/api/quotations" && url.searchParams.get("sort") === "subtotal"; }), page.getByRole("button", { name: "Sort by Amount", exact: true }).click()]);
              assert.equal(sortedQuotes.status(), 200); const quotePage = await sortedQuotes.json() as Json; await settleCapturePage(page);
              assert.deepEqual(await page.locator(".crm-quotation-list tbody tr td:nth-child(2)").allTextContents(), (quotePage.items as Json[]).map(quote => quote.quoteNumber));
              assert.ok(await page.locator('.crm-content-body a[href="/leads/8"]').count());
              assert.ok(await page.locator('.crm-content-body a[href="/api/quotations/8/pdf"]').count()); await widths(page, "source-quotations");
            });
            await check("Owner: selected permission target survives GET Load, reload and Back without saving", async () => {
              const beforeResponse = await json(page, "/api/settings/users/5/permissions"); assert.equal(beforeResponse.status, 200);
              const beforeGrants = beforeResponse.body;
              await goto(page, "/settings/permissions/assign");
              const select = page.getByLabel("Admin user", { exact: true });
              async function assertLoadedTarget() {
                await page.getByText("Editing permissions for " + String((beforeGrants.user as Json).name), { exact: true }).waitFor();
                assert.equal(await select.inputValue(), "5");
                const selected = await page.getByRole("region", { name: "Permission assignment", exact: true })
                  .locator('input[name="permissions[]"]:checked').evaluateAll(elements => elements.map(element => (element as HTMLInputElement).value).sort());
                assert.deepEqual(selected, [...beforeGrants.permissionIds as string[]].sort());
              }
              await select.selectOption("5"); await page.getByRole("button", { name: "Load", exact: true }).click();
              await page.waitForURL(origin + "/settings/permissions/assign?userId=5");
              await page.getByRole("region", { name: "Permission assignment", exact: true }).waitFor();
              await page.reload({ waitUntil: "domcontentloaded" }); await settleCapturePage(page);
              await assertLoadedTarget();
              await widths(page, "source-permission-target");
              await select.selectOption("15"); await page.getByRole("button", { name: "Load", exact: true }).click();
              await page.waitForURL(origin + "/settings/permissions/assign?userId=15"); await page.goBack();
              await page.waitForURL(origin + "/settings/permissions/assign?userId=5"); await settleCapturePage(page);
              await assertLoadedTarget();
              assert.equal(hash((await json(page, "/api/settings/users/5/permissions")).body), hash(beforeGrants));
            });
            await check("Owner: job details show original recorded description/contact/stage fields", async () => {
              await goto(page, "/jobs/7");
              for (const label of ["Description:", "Inquiry Date:", "Quotation Date:", "Customer Email:", "Contact Number:"]) assert.ok(await page.getByText(label, { exact: true }).isVisible(), label);
              await widths(page, "source-job-details");
            });
            await check("Owner: source job status and assignment remarks dialogs cancel without saving", async () => {
              const beforeJob = await json(page, "/api/jobs/7"); assert.equal(beforeJob.status, 200);
              await goto(page, "/jobs");
              await page.getByRole("button", { name: "Update status for " + String(beforeJob.body.dealName), exact: true }).click();
              const status = page.getByRole("dialog", { name: "Are you sure you want to update this project?", exact: true }); await status.waitFor();
              await status.getByLabel("Project Status", { exact: true }).selectOption("Hold");
              await widths(page, "source-job-status-dialog");
              await status.getByRole("button", { name: "Close", exact: true }).click(); assert.equal(await page.locator("dialog[open]").count(), 0);
              await page.getByRole("button", { name: "Assign departments for " + String(beforeJob.body.dealName), exact: true }).click();
              const assignment = page.getByRole("dialog", { name: "Assign Departments", exact: true }); await assignment.waitFor();
              await assignment.getByLabel("Admin Remarks", { exact: true }).fill("Unsubmitted source parity draft");
              assert.ok(await assignment.getByRole("button", { name: "Save Remarks", exact: true }).isVisible());
              await widths(page, "source-assignment-remarks");
              await assignment.getByRole("button", { name: "Close", exact: true }).click(); assert.equal(await page.locator("dialog[open]").count(), 0);
              assert.equal(hash((await json(page, "/api/jobs/7")).body), hash(beforeJob.body));
            });
            await check("Owner: source attachment cards retain existing file identities and protected links", async () => {
              await goto(page, "/jobs/7");
              const files = await json(page, "/api/leads/7/attachments?page=1&pageSize=25"); assert.equal(files.status, 200);
              const region = page.getByRole("region", { name: "Local attachments", exact: true });
              assert.ok(await region.getByRole("heading", { name: "File Upload", exact: true }).isVisible());
              const records = files.body.items as Json[]; assert.ok(records.length > 0);
              for (const file of records) {
                const card = region.getByRole("article", { name: String(file.name), exact: true }); await card.waitFor();
                assert.equal(await card.getByRole("link", { name: "Download " + String(file.name), exact: true }).getAttribute("href"), "/api/attachments/" + String(file.id));
              }
              await widths(page, "source-attachment-cards");
              assert.equal(hash((await json(page, "/api/leads/7/attachments?page=1&pageSize=25")).body), hash(files.body));
            });
            await check("Owner: user/group/permission edit targets survive reload and cancel without saving", async () => {
              for (const path of ["users", "permission-groups", "permissions"]) {
                const listed = await json(page, `/api/settings/${path}?page=1&pageSize=25`); assert.equal(listed.status, 200);
                const first = (listed.body.items as Json[]).find(item => path !== "users" || String(item.id) === "5") ?? (listed.body.items as Json[])[0]!;
                assert.ok(first); const target = String(first.id), field = path === "users" ? "#user-name" : "#catalog-label";
                const original = String(first[path === "users" ? "name" : "label"]);
                await goto(page, `/settings/${path}?editId=${target}`);
                await page.locator(field).waitFor(); assert.equal(await page.locator(field).inputValue(), original);
                await page.locator(field).fill("Unsubmitted source draft");
                await page.reload({ waitUntil: "domcontentloaded" }); await settleCapturePage(page);
                assert.equal(await page.locator(field).inputValue(), original);
                await widths(page, "source-edit-" + path);
                await page.getByRole("button", { name: "Cancel editing", exact: true }).click();
                await page.waitForURL(origin + `/settings/${path}`);
                const after = await json(page, `/api/settings/${path}/${target}`); assert.equal(after.status, 200);
                assert.equal(after.body[path === "users" ? "name" : "label"], original);
              }
            });
          } else if (identity.department) {
            await check(`User ${identity.id}: ${identity.department} recorded details and original status labels`, async () => {
              await goto(page, `/departments/${identity.department}/jobs/7`);
              for (const label of ["Description:", "Inquiry Date:", "Quotation Date:", "Customer Email:", "Contact Number:"]) assert.ok(await page.getByText(label, { exact: true }).isVisible(), label);
              await widths(page, "source-worker-details-" + identity.department.toLowerCase());
              await page.getByRole("tab", { name: identity.department === "PM" ? "Project Manager" : identity.department, exact: true }).click();
              const options = await page.getByLabel("Log status", { exact: true }).locator("option").evaluateAll(elements => elements.map(element => ({ value: (element as HTMLOptionElement).value, label: element.textContent })));
              const labels = sourceWorkerStatusLabels(identity.department);
              for (const option of options) if (labels[option.value]) assert.equal(option.label, labels[option.value]);
              await widths(page, "source-worker-status-" + identity.department.toLowerCase());
            });
          } else {
            await check("User 5: restricted landing and protected job/settings/foreign quotation refusals", async () => {
              assert.equal(page.url(), origin + "/account");
              for (const path of ["/api/jobs/7", "/api/settings/users", "/api/quotations/8"]) assert.ok([403, 404].includes((await json(page, path)).status), path);
              assert.equal((await page.goto(origin + "/settings/users", { waitUntil: "domcontentloaded" }))?.status(), 404);
              await goto(page, "/leads/4");
              const ownFiles = await json(page, "/api/leads/4/attachments?page=1&pageSize=25"); assert.equal(ownFiles.status, 200);
              const ownCards = page.getByRole("region", { name: "Local attachments", exact: true });
              const ownRecords = ownFiles.body.items as Json[]; assert.ok(ownRecords.length > 0);
              for (const file of ownRecords) {
                const card = ownCards.getByRole("article", { name: String(file.name), exact: true }); await card.waitFor();
                assert.equal(await card.getByRole("link", { name: "Download " + String(file.name), exact: true }).getAttribute("href"), "/api/attachments/" + String(file.id));
              }
              await widths(page, "source-restrictive-own-files");
              await goto(page, "/account"); await widths(page, "source-restrictive-account");
            });
          }
        } else if (quotationsOnly && identity.id === "15") {
          const recorded = new Map<string, Json>();
          const dubaiDay = (value: string) => {
            const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
            return ["year", "month", "day"].map(key => parts.find(part => part.type === key)!.value).join("-");
          };
          for (const [taskId, policy] of [["7", "percentage-create-v1"], ["8", "percentage-only-v2"]]) {
            if (productsOnly) {
              const response = await json(page, `/api/quotations/${taskId}`); assert.equal(response.status, 200);
              assert.equal(response.body.calculationPolicy, policy); recorded.set(taskId!, response.body);
              continue;
            }
            await check(`Quotation ${taskId}: saved policy and authorized capabilities`, async () => {
              const response = await json(page, `/api/quotations/${taskId}`); assert.equal(response.status, 200);
              const quote = response.body; assert.equal(quote.calculationPolicy, policy); recorded.set(taskId!, quote);
              const caps = await json(page, `/api/quotations/${taskId}/capabilities`); assert.equal(caps.status, 200);
              assert.equal(caps.body.canEdit, taskId === "8"); assert.equal(caps.body.discountedEditBlocked, taskId === "7");
              assert.equal(caps.body.pdfAvailable, true);
              await goto(page, `/quotations/${taskId}`);
              assert.equal(await page.getByRole("link", { name: "Edit quotation", exact: true }).count(), taskId === "8" ? 1 : 0);
              if (taskId === "7") {
                assert.equal((quote.quotation as Json).discount, "0");
                assert.ok(await page.getByText("Saved header discount (AED)", { exact: true }).isVisible());
                assert.equal(await page.getByText(/has historical discounts/).count(), 0);
              }
            });
            await check(`Quotation ${taskId}: creation metadata, source edit form and saved totals`, async () => {
              const quote = recorded.get(taskId!)!;
              if (taskId === "7") {
                await widths(page, "quotation-7-historical-details");
                assert.equal((await page.goto(origin + "/quotations/7/edit", { waitUntil: "domcontentloaded" }))?.status(), 404);
                assert.equal(await page.getByRole("button", { name: "Save quotation", exact: true }).count(), 0);
                await goto(page, "/quotations/7");
                return;
              }
              await goto(page, `/quotations/${taskId}/edit`);
              const date = page.getByLabel("Recorded creation date (Dubai)", { exact: true });
              assert.equal(await date.inputValue(), dubaiDay(String(quote.createdAt))); assert.equal(await date.getAttribute("readonly"), "");
              assert.equal(await page.getByLabel("Preview grand total (AED)", { exact: true }).inputValue(), (quote.totals as Json).grandTotal);
              assert.equal(await page.getByRole("button", { name: "Save quotation", exact: true }).isDisabled(), false);
              assert.equal(await page.getByLabel("Discount (%)", { exact: true }).inputValue(), "5");
              assert.equal(await page.getByLabel("Item 1 discount (%)", { exact: true }).inputValue(), "20");
              await widths(page, `quotation-${taskId}-metadata`);
            });
            await check(`Quotation ${taskId}: PDF records creation and last modification separately`, async () => {
              const quote = recorded.get(taskId!)!;
              const response = await context.request.get(origin + `/api/quotations/${taskId}/pdf`, { maxRedirects: 0 }); assert.equal(response.status(), 200);
              const bytes = await response.body(); const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
              const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
              try {
                const document = await loading.promise; const metadata = (await document.getMetadata()).info as Json;
                const pdfDate = (value: unknown) => "D:" + new Date(String(value)).toISOString().slice(0, 19).replace(/[-:T]/g, "") + "Z";
                assert.equal(metadata.CreationDate, pdfDate(quote.createdAt)); assert.equal(metadata.ModDate, pdfDate(quote.updatedAt));
                const text = (await (await document.getPage(1)).getTextContent()).items.map(item => "str" in item ? item.str : "").join(" ");
                assert.ok(text.includes(String((quote.totals as Json).grandTotal)));
                if (taskId === "8") assert.ok(text.includes("Discount (5%)"));
                else {
                  // Original zero deductions do not generate a PDF discount row.
                  assert.ok(text.includes(String((quote.totals as Json).subtotal)));
                  assert.equal(text.includes("Discount (0%)"), false);
                }
                writePrivateNew(join(directory, `quotation-${taskId}-pdf.json`), { taskId, policy, sha256: createHash("sha256").update(bytes).digest("hex"), createdAt: quote.createdAt, updatedAt: quote.updatedAt, pdfCreationDate: metadata.CreationDate, pdfModificationDate: metadata.ModDate, pages: document.numPages });
              } finally { await loading.destroy(); }
            });
          }
          const products = await json(page, "/api/items?page=1&pageSize=25"); assert.equal(products.status, 200);
          const product = (products.body.items as Json[])[0]!; assert.ok(product);
          const option = `${String(product.name)} (${String(product.externalId)})`;
          const openSearch = async () => {
            await page.getByRole("button", { name: "Item 1 product", exact: true }).click();
            await page.getByRole("combobox", { name: "Item 1 product search", exact: true }).fill(String(product.name));
            await page.getByRole("option", { name: option, exact: true }).waitFor();
          };
          await check("Edit product search preserves unsaved description and price until explicit selection", async () => {
            await goto(page, "/quotations/8/edit");
            await page.getByRole("textbox", { name: "Item 1 description", exact: true }).fill("Unsubmitted local parity draft");
            await page.getByLabel("Item 1 unit price", { exact: true }).fill("123.45");
            const selected = await page.getByRole("button", { name: "Item 1 product", exact: true }).textContent();
            await openSearch(); await widths(page, "quotation-edit-product-search");
            await page.getByRole("combobox", { name: "Item 1 product search", exact: true }).focus();
            await page.keyboard.press("Escape");
            assert.equal(await page.getByRole("button", { name: "Item 1 product", exact: true }).textContent(), selected);
            assert.equal(await page.getByRole("textbox", { name: "Item 1 description", exact: true }).inputValue(), "Unsubmitted local parity draft");
            assert.equal(await page.getByLabel("Item 1 unit price", { exact: true }).inputValue(), "123.45");
            await openSearch(); await page.getByRole("option", { name: option, exact: true }).click();
            assert.equal(await page.getByRole("textbox", { name: "Item 1 description", exact: true }).inputValue(), product.description ?? "");
            assert.equal(await page.getByLabel("Item 1 unit price", { exact: true }).inputValue(), product.unitPrice ?? "0");
          });
          await check("Create product search supports source selection, cancellation and explicit clear without submission", async () => {
            await goto(page, "/quotations/new"); await openSearch(); await widths(page, "quotation-create-product-search");
            await page.getByRole("option", { name: option, exact: true }).click();
            assert.equal(await page.getByRole("textbox", { name: "Item 1 description", exact: true }).inputValue(), product.description ?? "");
            assert.equal(await page.getByLabel("Item 1 price", { exact: true }).inputValue(), product.unitPrice ?? "0");
            await page.getByRole("button", { name: "Clear item 1 product", exact: true }).click();
            assert.equal(await page.getByRole("textbox", { name: "Item 1 description", exact: true }).inputValue(), "");
            assert.equal(await page.getByLabel("Item 1 price", { exact: true }).inputValue(), "0");
            assert.equal(await page.getByRole("button", { name: "Save Proposal", exact: true }).isDisabled(), true);
          });
          await check("Both historical and current quotations remain byte-identical after all unsaved drafts", async () => {
            for (const [taskId, saved] of recorded) assert.equal(hash((await json(page, `/api/quotations/${taskId}`)).body), hash(saved));
          });
        } else if (formsOnly && identity.id === "15") {
          await check("Owner: final source stage dialog opens and cancels", async () => {
            await goto(page, "/leads/8"); await page.getByRole("button", { name: "Update Status", exact: true }).click();
            assert.ok(await page.getByRole("dialog", { name: "Update Status", exact: true }).isVisible());
            await widths(page, "final-lead-status-dialog"); await page.keyboard.press("Escape");
            assert.equal(await page.locator("dialog[open]").count(), 0);
          });
          await check("Owner: Add Notes dialog draft and cancel without saving", async () => {
            await page.getByRole("button", { name: "Add Note", exact: true }).click();
            assert.ok(await page.getByRole("dialog", { name: "Add Notes", exact: true }).isVisible());
            await page.getByLabel("New note title", { exact: true }).fill("Unsubmitted parity draft");
            await page.getByLabel("New note content", { exact: true }).fill("Read-only browser draft. This note is not saved.");
            await widths(page, "lead-add-notes-dialog"); await page.keyboard.press("Escape");
            assert.equal(await page.locator("dialog[open]").count(), 0);
          });
          await check("Owner: existing note content editor preserves recorded title and cancels", async () => {
            const response = await json(page, "/api/leads/7/notes?page=1&pageSize=25"); assert.equal(response.status, 200);
            const notes = response.body.items as Json[]; assert.ok(notes.length > 0); const note = notes[0]!;
            await goto(page, "/leads/7"); await page.getByRole("button", { name: `Edit note: ${String(note.title)}`, exact: true }).click();
            assert.ok(await page.getByRole("dialog", { name: "Edit Your Notes", exact: true }).isVisible());
            assert.equal(await page.getByLabel("Edit note title", { exact: true }).inputValue(), note.title);
            assert.equal(await page.getByLabel("Edit note title", { exact: true }).getAttribute("readonly"), "");
            assert.equal(await page.getByLabel("Edit note content", { exact: true }).inputValue(), note.content);
            await widths(page, "lead-edit-notes-dialog"); await page.keyboard.press("Escape");
            assert.equal(await page.locator("dialog[open]").count(), 0);
          });
          for (const [path, label] of [["/settings/permission-groups", "groups"], ["/settings/permissions", "permissions"]]) {
            await check(`Owner: final source ${label} form and unchanged edit/cancel`, async () => {
              await goto(page, path!); await widths(page, "final-create-" + label!);
              await page.getByRole("button", { name: "Edit", exact: true }).first().click();
              assert.equal(await page.getByLabel("Key", { exact: true }).getAttribute("readonly"), "");
              await widths(page, "final-edit-" + label!);
              await page.getByRole("button", { name: "Cancel editing", exact: true }).click();
              assert.equal(await page.getByLabel("Key", { exact: true }).inputValue(), "");
            });
          }
        } else if (identity.id === "15") {
          await check("Owner: department assignment modal/options/close at three widths without saving", async () => {
            await goto(page, "/settings/users/departments"); assert.equal(await page.locator("thead th").count(), 4);
            await page.getByRole("button", { name: /^Assign department for / }).first().click();
            const select = page.getByRole("combobox", { name: "Select Department", exact: true });
            assert.deepEqual(await select.locator("option").allTextContents(), ["Select department", "Electrical", "Civil", "PM", "Switchgear", "Maintenance", "Accounts", "Operations"]);
            await widths(page, "department-dialog"); await page.keyboard.press("Escape"); assert.equal(await page.locator("dialog[open]").count(), 0);
          });
          for (const [path, label] of [["/settings/permission-groups", "groups"], ["/settings/permissions", "permission-definitions"]]) {
            await check(`Owner: ${label} source editor/read-only edit/cancel at three widths`, async () => {
              await goto(page, path!); await page.getByRole("button", { name: "Edit", exact: true }).first().click();
              assert.equal(await page.getByLabel("Key", { exact: true }).getAttribute("readonly"), "");
              await widths(page, label!); await page.getByRole("button", { name: "Cancel editing", exact: true }).click();
              assert.equal(await page.getByLabel("Key", { exact: true }).inputValue(), "");
            });
          }
          await check("Owner: applied report period and GET-only date filtering at three widths", async () => {
            await goto(page, "/reports/employee-performance");
            const response = await json(page, "/api/reports/employee-performance?page=1&pageSize=25&query="); assert.equal(response.status, 200);
            const dates = response.body;
            assert.equal(await page.getByLabel("From date", { exact: true }).inputValue(), dates.dateFrom);
            assert.equal(await page.getByLabel("To date", { exact: true }).inputValue(), dates.dateTo);
            await page.getByLabel("From date", { exact: true }).fill("2026-10-01"); await page.getByLabel("To date", { exact: true }).fill("2026-10-13");
            const [filtered] = await Promise.all([page.waitForResponse(value => {
              const url = new URL(value.url()); return url.pathname === "/api/reports/employee-performance" && url.searchParams.get("dateFrom") === "2026-10-01" && url.searchParams.get("dateTo") === "2026-10-13";
            }), page.getByRole("button", { name: "Apply dates", exact: true }).click()]);
            assert.equal(filtered.status(), 200); const filteredBody = await filtered.json() as Json;
            assert.equal(filteredBody.dateFrom, "2026-10-01"); assert.equal(filteredBody.dateTo, "2026-10-13"); await settleCapturePage(page);
            assert.ok(await page.getByText("Task creation dates: 2026-10-01 to 2026-10-13, Asia/Dubai.", { exact: false }).isVisible());
            assert.ok(await page.getByRole("region", { name: "Report summary", exact: true }).isVisible());
            await widths(page, "employee-report-filtered");
          });
          await check("Owner: query-only job cohort links keep correct active navigation", async () => {
            await goto(page, "/jobs?cohort=process"); await page.setViewportSize({ width: 1440, height: 1000 }); await settleCapturePage(page);
            for (const cohort of ["completed", "pending", "process"]) {
              const link = page.locator(`nav a[href='/jobs?cohort=${cohort}']`); await link.click(); await settleCapturePage(page);
              assert.equal(await link.getAttribute("aria-current"), "page"); assert.equal(await page.locator("nav a[aria-current]").count(), 1);
            }
            await navigation(page, "owner", "/jobs?cohort=process");
          });
          await check("Owner: source lead status modal opens and cancels without mutation", async () => {
            await goto(page, "/leads/8"); await page.getByRole("button", { name: "Update Status", exact: true }).click();
            assert.ok(await page.getByRole("dialog").isVisible()); await widths(page, "lead-status-dialog");
            await page.keyboard.press("Escape"); assert.equal(await page.locator("dialog[open]").count(), 0);
          });
        } else if (formsOnly && identity.department) {
          await check(`User ${identity.id}: final ${identity.department} source work form and status dialog`, async () => {
            await goto(page, `/departments/${identity.department}/jobs/7`);
            assert.equal(await page.locator("nav a[href^='/settings/']").count(), 0);
            await widths(page, "worker-details-" + identity.department.toLowerCase());
            await page.getByRole("tab", { name: identity.department === "PM" ? "Project Manager" : identity.department, exact: true }).click();
            await widths(page, "final-worker-" + identity.department.toLowerCase());
            await page.getByRole("button", { name: "Update Status", exact: true }).click();
            assert.ok(await page.getByRole("dialog").isVisible());
            await widths(page, "worker-status-" + identity.department.toLowerCase());
            await page.keyboard.press("Escape"); assert.equal(await page.locator("dialog[open]").count(), 0);
          });
        } else if (identity.department) {
          const path = `/departments/${identity.department}/jobs`;
          await check(`User ${identity.id}: ${identity.department} current job and normalized responsive shell`, async () => {
            await goto(page, path + "/7");
            const tab = page.getByRole("tab", { name: identity.department === "PM" ? "Project Manager" : identity.department, exact: true });
            if (await tab.count()) await tab.click();
            assert.ok(await page.getByRole("region", { name: identity.department + " work", exact: true }).isVisible());
            assert.equal(await page.locator("nav a[href^='/settings/']").count(), 0);
            await widths(page, "worker-" + identity.department.toLowerCase()); await navigation(page, "worker-" + identity.department.toLowerCase(), path);
          });
          await check(`User ${identity.id}: ${identity.department} query filter and matching active role navigation`, async () => {
            await goto(page, path + "?status=Process"); await page.setViewportSize({ width: 1440, height: 1000 }); await settleCapturePage(page);
            await page.getByRole("combobox", { name: "Department status filter", exact: true }).selectOption("Completed");
            await page.waitForURL(origin + path + "?status=Completed"); await settleCapturePage(page);
            assert.equal(await page.locator(`nav a[href='${path}?status=Completed']`).getAttribute("aria-current"), "page");
            await page.getByRole("combobox", { name: "Department status filter", exact: true }).selectOption("Process");
            await page.waitForURL(origin + path + "?status=Process"); await settleCapturePage(page);
            assert.ok(await page.locator("a[href='" + path + "/7']").count());
          });
        } else {
          await check("User 5: restrictive navigation and agents pipeline across three widths", async () => {
            assert.equal(identity.id, "5"); await goto(page, "/pipeline");
            assert.equal(await page.locator("nav a[href^='/settings/'],nav a[href^='/departments/'],nav a[href='/jobs']").count(), 0);
            assert.ok(await page.getByRole("link", { name: "Lead pipeline", exact: true }).count());
            await widths(page, "restrictive-pipeline"); await navigation(page, "restrictive", "/pipeline");
          });
        }
      } finally {
        if (signedIn) await check(`User ${identity.id}: normal test-session logout`, async () => {
          await goto(page, "/account"); await page.getByRole("button", { name: "User menu", exact: true }).click();
          await page.getByRole("button", { name: "Sign out", exact: true }).click(); await page.waitForURL(origin + "/login"); receipt.logouts++;
        });
        await context.close();
      }
    }
    assert.equal(receipt.blockedRequests, 0); assert.equal(receipt.pageErrors, 0); receipt.status = "PASS";
  } catch { receipt.diagnostic ??= "Sanitized harness error; inspect named stage and receipt."; }
  finally {
    await browser.close(); receipt.after = snapshot();
    const preserved = receipt.before.schema === receipt.after.schema && receipt.before.ownerSession === receipt.after.ownerSession
      && Object.entries(receipt.before.tables).every(([name, table]) => name === "crm_login_attempts" || hash(table) === hash(receipt.after!.tables[name]));
    receipt.checks.push({ name: "Zero business writes; complete schema/accounts/grants/files/records/owner-session preservation", status: preserved ? "PASS" : "FAIL" });
    if (!preserved || receipt.logins !== receipt.logouts || receipt.blockedRequests || receipt.pageErrors) receipt.status = "FAIL";
    receipt.finishedAt = new Date().toISOString(); writePrivateNew(join(directory, "receipt.json"), receipt);
  }
  return receipt;
}
const currentFile = fileURLToPath(import.meta.url);
if (resolve(process.argv[1] ?? "") === currentFile) {
  if (![3, 4].includes(process.argv.length) || process.argv[2] !== flag || process.argv.length === 4 && !["--forms-only", "--quotations-only", "--quotation-products-only", "--source-parity-only", "--source-remaining"].includes(process.argv[3]!)) { console.error("Explicit read-only Account Owner scope required; no credentials accepted."); process.exitCode = 1; }
  else if (process.env.CRM_SQLITE_DEMO !== acknowledgement) {
    const child = spawn(process.execPath, ["--import", pathToFileURL(join(backendRoot, "../node_modules/tsx/dist/loader.mjs")).href, currentFile, ...process.argv.slice(2)], { cwd: backendRoot, env: captureChildEnvironment(), windowsHide: true, stdio: "inherit" });
    process.exitCode = await new Promise<number>(done => { child.once("error", () => done(1)); child.once("exit", code => done(code ?? 1)); });
  } else {
    try { const result = await runRemainingParity(process.argv[3] === "--forms-only", ["--quotations-only", "--quotation-products-only"].includes(process.argv[3] ?? ""), process.argv[3] === "--quotation-products-only", ["--source-parity-only", "--source-remaining"].includes(process.argv[3] ?? ""), process.argv[3] === "--source-remaining"); console.log(JSON.stringify({ status: result.status, receipt: join(result.directory, "receipt.json"), passed: result.checks.filter(check => check.status === "PASS").length,
      failed: result.checks.filter(check => check.status === "FAIL").length, images: result.images.length, pageErrors: result.pageErrors, blockedRequests: result.blockedRequests, businessWrites: result.businessWrites, beforeRows: result.before.rows, afterRows: result.after?.rows })); process.exitCode = result.status === "PASS" ? 0 : 1; }
    catch { console.error("Read-only parity refused before execution; no private details logged."); process.exitCode = 1; }
  }
}
