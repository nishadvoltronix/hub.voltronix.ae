import assert from "node:assert/strict";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { boxesOverlap, captureResponsiveScreen, createResponsiveAudit, finishResponsiveAudit, RESPONSIVE_VIEWPORTS, responsiveIssues,
  type ResponsiveAuditReceipt, type ResponsiveMetrics } from "./responsive-audit.js";
import { parseIsolatedBrowserArguments } from "./isolated-browser.js";

function metrics(): ResponsiveMetrics {
  return { viewportWidth: 360, documentWidth: 360, main: { x: 0, y: 74, width: 360, height: 1200 },
    header: { x: 0, y: 0, width: 360, height: 74 }, sidebar: null, controls: [], tables: [], overlappingContainers: [] };
}
test("responsive audit is opt-in while the existing synthetic-only invocation stays accepted", () => {
  assert.deepEqual(parseIsolatedBrowserArguments(["--synthetic-in-memory-only"]), { responsiveAudit: false });
  assert.deepEqual(parseIsolatedBrowserArguments(["--synthetic-in-memory-only", "--responsive-audit"]), { responsiveAudit: true });
  for (const args of [[], ["--responsive-audit"], ["--synthetic-in-memory-only", "--output=../private"],
    ["--synthetic-in-memory-only", "--responsive-audit", "extra"]]) assert.throws(() => parseIsolatedBrowserArguments(args));
  assert.deepEqual(RESPONSIVE_VIEWPORTS.map(viewport => [viewport.width, viewport.height]), [[1440, 1000], [1280, 800], [768, 1024], [360, 800]]);
});
test("wide tables and their controls are reachable inside a bounded horizontal scroller", () => {
  const value = metrics(), scrollContainer = { x: 16, y: 100, width: 328, height: 180 };
  value.tables.push({ target: "table", box: { x: 16, y: 100, width: 1000, height: 180 }, scrollContainer });
  value.controls.push({ target: "quantity", box: { x: 500, y: 140, width: 80, height: 40 }, scrollContainer, clipped: false });
  assert.deepEqual(responsiveIssues(value), []);
  value.tables[0]!.scrollContainer = null;
  assert.deepEqual(responsiveIssues(value), [{ kind: "uncontained-table", target: "table" }]);
});
test("document overflow, clipped inputs and unreachable controls do not pass as responsive", () => {
  const value = metrics(); value.documentWidth = 390;
  value.controls.push({ target: "save", box: { x: 340, y: 200, width: 100, height: 40 }, scrollContainer: null, clipped: true });
  assert.deepEqual(responsiveIssues(value), [
    { kind: "document-overflow", target: "document" }, { kind: "clipped-control", target: "save" }, { kind: "unreachable-control", target: "save" },
  ]);
  value.controls[0]!.scrollContainer = { x: 340, y: 180, width: 150, height: 80 };
  assert.ok(responsiveIssues(value).some(issue => issue.kind === "unreachable-control"));
});
test("a single oversized control is not excused by a narrower scrolling container", () => {
  const value = metrics();
  value.controls.push({ target: "description", box: { x: 16, y: 150, width: 500, height: 60 },
    scrollContainer: { x: 16, y: 120, width: 328, height: 200 }, clipped: false });
  assert.deepEqual(responsiveIssues(value), [{ kind: "control-wider-than-scroll-region", target: "description" }]);
});
test("main/sidebar/header and sibling overlap is rejected without treating touching edges as overlap", () => {
  const value = metrics();
  assert.deepEqual(responsiveIssues(value), []);
  assert.equal(boxesOverlap(value.main!, value.header!), false);
  value.sidebar = { x: 0, y: 0, width: 264, height: 800 };
  value.header!.height = 100;
  value.overlappingContainers.push("settings/editor-list");
  assert.deepEqual(responsiveIssues(value), [{ kind: "shell-overlap", target: "header/main" },
    { kind: "shell-overlap", target: "sidebar/main" }, { kind: "sibling-container-overlap", target: "settings/editor-list" }]);
});
test("artifact writes reject receipts not created by this audit before touching their directory", () => {
  const receipt: ResponsiveAuditReceipt = { scope: "synthetic-in-memory-only", status: "IN_PROGRESS",
    directory: "G:/crm.voltronix.ae", samples: [], navigation: [] };
  assert.throws(() => finishResponsiveAudit(receipt, true), /allocated by this audit/);
});
test("browser geometry executes under tsx and captures only an intercepted synthetic page", async () => {
  // The document is fulfilled in memory: no app listener, private file or HTTP
  // service is contacted, and no browser executable is downloaded.
  const browser = await chromium.launch({ headless: true, args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run"] });
  const receipt = createResponsiveAudit();
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><style>
      body { margin:0 } header { position:fixed; top:0; width:100%; height:74px }
      main { margin-top:74px; padding:16px; box-sizing:border-box } .scroll { width:100%; overflow-x:auto }
      table { width:900px } td:first-child { width:500px } input { width:80px }
      </style><header class="pc-header"></header><main class="pc-container"><div class="scroll"><table><tr>
      <td>Synthetic table</td><td><label>Fixture title<input value="Synthetic"></label></td></tr></table></div>
      <details><summary>Closed filters</summary><input style="position:absolute;left:999px;width:500px" aria-label="Hidden filter"></details></main>` }));
    await page.goto("http://127.0.0.1:3101/synthetic-audit-fixture");
    await captureResponsiveScreen(page, "manager", "fixture", RESPONSIVE_VIEWPORTS[3], receipt, ["Fixture title"]);
    assert.equal(receipt.samples.length, 1);
    assert.equal(receipt.samples[0]!.metrics.tables.length, 1);
    assert.equal(receipt.samples[0]!.metrics.controls.length, 1);
    assert.deepEqual(receipt.samples[0]!.issues, []);
    assert.ok(existsSync(join(receipt.directory, "mobile-manager-fixture.png")));
    finishResponsiveAudit(receipt, true); assert.equal(receipt.status, "PASS");
    assert.ok(existsSync(join(receipt.directory, "receipt.json")));
  } finally {
    await browser.close();
    const target = realpathSync(receipt.directory);
    assert.equal(resolve(target, ".."), realpathSync(tmpdir()));
    assert.match(basename(target), /^crm-synthetic-responsive-[A-Za-z0-9]+$/);
    rmSync(target, { recursive: true, force: true });
  }
});
