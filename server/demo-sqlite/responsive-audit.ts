import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Page } from "playwright";

/** Test artifacts only. No demo handoff, stored credentials or database is read. */
export const RESPONSIVE_VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 360, height: 800 },
] as const;
export type ResponsiveViewport = typeof RESPONSIVE_VIEWPORTS[number];
export interface AuditBox { x: number; y: number; width: number; height: number }
export interface ResponsiveMetrics {
  viewportWidth: number;
  documentWidth: number;
  main: AuditBox | null;
  header: AuditBox | null;
  sidebar: AuditBox | null;
  controls: { target: string; box: AuditBox; scrollContainer: AuditBox | null; clipped: boolean }[];
  tables: { target: string; box: AuditBox; scrollContainer: AuditBox | null }[];
  overlappingContainers: string[];
}
export interface ResponsiveIssue { kind: string; target: string }
export interface ResponsiveSample {
  screen: string; role: "manager" | "worker"; viewport: ResponsiveViewport["name"];
  screenshot: string; metrics: ResponsiveMetrics; issues: ResponsiveIssue[];
}
export interface ResponsiveAuditReceipt {
  scope: "synthetic-in-memory-only";
  status: "IN_PROGRESS" | "PASS" | "FAIL";
  directory: string;
  samples: ResponsiveSample[];
  navigation: { role: "manager" | "worker"; viewport: ResponsiveViewport["name"]; status: "PASS" }[];
}
const ownedReceipts = new WeakSet<ResponsiveAuditReceipt>();
const outside = (box: AuditBox, width: number) => box.x < -2 || box.x + box.width > width + 2;
export function boxesOverlap(left: AuditBox, right: AuditBox): boolean {
  return Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x) > 2
    && Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y) > 2;
}
/** Horizontal scrolling inside a bounded table is intentional, document overflow is not. */
export function responsiveIssues(metrics: ResponsiveMetrics): ResponsiveIssue[] {
  const issues: ResponsiveIssue[] = [];
  if (metrics.documentWidth > metrics.viewportWidth + 2) issues.push({ kind: "document-overflow", target: "document" });
  if (!metrics.main || metrics.main.width < 1) issues.push({ kind: "missing-content", target: "main" });
  for (const [target, box] of [["main", metrics.main], ["header", metrics.header]] as const)
    if (box && outside(box, metrics.viewportWidth)) issues.push({ kind: "container-outside-viewport", target });
  if (metrics.main && metrics.header && boxesOverlap(metrics.main, metrics.header)) issues.push({ kind: "shell-overlap", target: "header/main" });
  if (metrics.sidebar && metrics.main && boxesOverlap(metrics.sidebar, metrics.main)) issues.push({ kind: "shell-overlap", target: "sidebar/main" });
  for (const control of metrics.controls) {
    if (control.clipped) issues.push({ kind: "clipped-control", target: control.target });
    if (outside(control.box, metrics.viewportWidth) && (!control.scrollContainer || outside(control.scrollContainer, metrics.viewportWidth)))
      issues.push({ kind: "unreachable-control", target: control.target });
    if (control.scrollContainer && control.box.width > control.scrollContainer.width + 2)
      issues.push({ kind: "control-wider-than-scroll-region", target: control.target });
  }
  for (const table of metrics.tables) {
    if (outside(table.box, metrics.viewportWidth) && (!table.scrollContainer || outside(table.scrollContainer, metrics.viewportWidth)))
      issues.push({ kind: "uncontained-table", target: table.target });
  }
  for (const target of metrics.overlappingContainers) issues.push({ kind: "sibling-container-overlap", target });
  return issues;
}

export function createResponsiveAudit(): ResponsiveAuditReceipt {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "crm-synthetic-responsive-"));
  const receipt: ResponsiveAuditReceipt = { scope: "synthetic-in-memory-only", status: "IN_PROGRESS", directory, samples: [], navigation: [] };
  ownedReceipts.add(receipt);
  return receipt;
}
function assertOwned(receipt: ResponsiveAuditReceipt) {
  assert.ok(ownedReceipts.has(receipt), "Only an artifact directory allocated by this audit can be written.");
  assert.equal(resolve(receipt.directory), realpathSync(receipt.directory));
  assert.equal(resolve(receipt.directory, ".."), realpathSync(tmpdir()));
  assert.match(basename(receipt.directory), /^crm-synthetic-responsive-[A-Za-z0-9]+$/);
}
export function finishResponsiveAudit(receipt: ResponsiveAuditReceipt, completed: boolean) {
  assertOwned(receipt);
  receipt.status = completed && receipt.samples.length > 0 && receipt.samples.every(sample => sample.issues.length === 0) ? "PASS" : "FAIL";
  writeFileSync(join(receipt.directory, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
export async function settleResponsivePage(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter(animation => {
      const end = animation.effect?.getComputedTiming().endTime;
      return animation.playState === "running" && typeof end === "number" && Number.isFinite(end) && end <= 5000;
    }).map(animation => animation.finished.catch(() => undefined)));
  });
}

/** These interactions only alter presentation; they never submit a form. */
export async function auditResponsiveNavigation(page: Page, role: "manager" | "worker", viewport: ResponsiveViewport,
  receipt: ResponsiveAuditReceipt) {
  assertOwned(receipt);
  assert.equal(new URL(page.url()).origin, "http://127.0.0.1:3101");
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await settleResponsivePage(page);
  if (viewport.width > 1024) {
    await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
    await settleResponsivePage(page);
    assert.equal(await page.getByRole("navigation", { name: "CRM navigation" }).isVisible(), false);
    await page.getByRole("button", { name: "Expand navigation", exact: true }).click();
    await settleResponsivePage(page);
    assert.equal(await page.getByRole("navigation", { name: "CRM navigation" }).isVisible(), true);
  } else {
    const toggle = page.getByRole("button", { name: "Open navigation", exact: true });
    await toggle.click(); await settleResponsivePage(page);
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator("main").getAttribute("inert"), "");
    await page.keyboard.press("Escape"); await settleResponsivePage(page);
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    await toggle.click(); await settleResponsivePage(page);
    await page.getByRole("navigation", { name: "CRM navigation" }).getByRole("link", { name: "Your account", exact: true }).click();
    await settleResponsivePage(page);
    assert.equal(new URL(page.url()).pathname, "/account");
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  }
  const menu = page.getByRole("button", { name: "User menu", exact: true });
  await menu.click(); assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).isVisible(), true);
  await page.keyboard.press("Escape"); assert.equal(await menu.getAttribute("aria-expanded"), "false");
  receipt.navigation.push({ role, viewport: viewport.name, status: "PASS" });
}

export async function captureResponsiveScreen(page: Page, role: "manager" | "worker", screen: string,
  viewport: ResponsiveViewport, receipt: ResponsiveAuditReceipt, requiredLabels: readonly string[] = []) {
  assertOwned(receipt);
  assert.match(screen, /^[a-z][a-z0-9-]{0,50}$/);
  assert.equal(new URL(page.url()).origin, "http://127.0.0.1:3101");
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await settleResponsivePage(page);
  const missing: ResponsiveIssue[] = [];
  for (const label of requiredLabels) {
    const field = page.getByLabel(label, { exact: true });
    if (await field.count() !== 1 || !await field.isVisible()) missing.push({ kind: "missing-form-control", target: label });
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  // Keep browser helpers as browser JavaScript: tsx otherwise injects its
  // Node-side __name helper into serialized nested functions.
  const metrics = await page.evaluate<ResponsiveMetrics>(`(() => {
    const visible = element => {
      // Chromium can retain nonzero layout boxes for content of a closed
      // details element; those controls are not actually painted/reachable.
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === "DETAILS" && !parent.hasAttribute("open")) {
          const summary = parent.querySelector(":scope > summary");
          if (!summary || !summary.contains(element)) return false;
        }
      }
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none"
        && element.getClientRects().length > 0;
    };
    const box = element => {
      const value = element.getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height };
    };
    const selected = selector => { const element = document.querySelector(selector); return element && visible(element) ? box(element) : null; };
    const scrollingAncestor = element => {
      let parent = element.parentElement;
      while (parent && parent !== document.body) {
        if (/^(auto|scroll)$/.test(getComputedStyle(parent).overflowX) && parent.scrollWidth > parent.clientWidth + 1) return parent;
        parent = parent.parentElement;
      }
      return null;
    };
    const label = (element, index) => element.tagName.toLowerCase() + (element.id ? "#" + element.id : "[" + index + "]");
    const controls = [...document.querySelectorAll("main input:not([type=hidden]),main select,main textarea,main button")].filter(visible).map((element, index) => {
      const bounds = box(element), scroll = scrollingAncestor(element);
      let clipped = false, parent = element.parentElement;
      while (parent && parent !== scroll && parent !== document.body) {
        const style = getComputedStyle(parent), boundary = box(parent);
        if (/^(hidden|clip)$/.test(style.overflowX) && (bounds.x < boundary.x - 2 || bounds.x + bounds.width > boundary.x + boundary.width + 2)) clipped = true;
        parent = parent.parentElement;
      }
      return { target: label(element, index), box: bounds, scrollContainer: scroll ? box(scroll) : null, clipped };
    });
    const tables = [...document.querySelectorAll("main table")].filter(visible).map((element, index) => {
      const scroll = scrollingAncestor(element); return { target: label(element, index), box: box(element), scrollContainer: scroll ? box(scroll) : null };
    });
    const overlappingContainers = [];
    for (const [groupIndex, parent] of [...document.querySelectorAll("main .settings-grid,main .metric-grid,main .crm-deal-fields,main .quotation-header-fields,main .quotation-term-fields,main .crm-assignment-cards,main .row")].entries()) {
      const children = [...parent.children].filter(visible);
      for (let first = 0; first < children.length; first++) for (let second = first + 1; second < children.length; second++) {
        const a = box(children[first]), b = box(children[second]);
        if (Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 2
          && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 2)
          overlappingContainers.push("layout-group[" + groupIndex + "]/children[" + first + "," + second + "]");
      }
    }
    return { viewportWidth: innerWidth, documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      main: selected("main.pc-container"), header: selected(".pc-header"), sidebar: selected(".pc-sidebar"), controls, tables, overlappingContainers };
  })()`);
  const filename = `${viewport.name}-${role}-${screen}.png`;
  const bytes = await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide",
    mask: [page.locator('input[type="password"]')], maskColor: "#d5d9df" });
  assert.ok(bytes.length <= 20 * 1024 * 1024, "Synthetic screenshot exceeded its artifact bound.");
  writeFileSync(join(receipt.directory, filename), bytes, { flag: "wx", mode: 0o600 });
  receipt.samples.push({ screen, role, viewport: viewport.name, screenshot: filename, metrics, issues: [...responsiveIssues(metrics), ...missing] });
}
