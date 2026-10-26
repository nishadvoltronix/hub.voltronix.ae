import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";
import { PIPELINE_STAGES, type PipelineResult } from "../src/server/leads/contracts";

test("OFFLINE source pipeline retains readable columns, keyboard scrolling and original phone stacking", { timeout: 90_000 }, async t => {
  const origin = "http://127.0.0.1:39991";
  const directory = resolve(".local-data", "reports", `pipeline-layout-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const actor = { localUserId: "999", username: "Synthetic restrictive account", email: "layout@example.invalid", permissions: ["leads.view"] };
  const data: PipelineResult = { scope: "own", total: 5, page: 1, pageSize: 25,
    counts: { qualification: 1, siteVisit: 1, proposal: 1, won: 1, lost: 1, other: 0 },
    items: PIPELINE_STAGES.map((stage, index) => ({ id: String(990 + index), dealName: "Synthetic pipeline deal " + index,
      stage: stage.key, status: stage.statuses[stage.statuses.length - 1]!, accountName: "Synthetic customer", assignedName: "Synthetic agent",
      assignedExternalId: "synthetic-agent", serviceCharge: "1200.00", displayNumber: "SYNTHETIC-" + index, createdAt: "2026-10-13T06:00:00Z", updatedAt: "2026-10-13T06:00:00Z" })) };
  const sources = ["src/app/globals.css", "public/legacy/assets/css/hrms.css", "public/legacy/assets/css/style.css", "src/components/crm/pipeline.tsx", "tests/pipeline-layout.test.ts"];
  const hashes = Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash("sha256").update(await readFile(file)).digest("hex")])));
  const bundle = await build({ stdin: { contents: `import {createRoot} from 'react-dom/client';import {CrmChrome} from './src/components/crm/chrome';import {Pipeline} from './src/components/crm/pipeline';createRoot(document.getElementById('root')).render(<CrmChrome user={${JSON.stringify(actor)}}><Pipeline forcedOwn={true}/></CrmChrome>);`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "next-component-stubs", setup(api) {
      api.onResolve({ filter: /^next\/(image|link|navigation)$/ }, args => ({ path: args.path, namespace: "fixture" }));
      api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path.endsWith("navigation")
        ? "export function useRouter(){return{refresh(){},replace(){}}};export function usePathname(){return '/pipeline'};export function useSearchParams(){return new URLSearchParams()}"
        : args.path.endsWith("image") ? "import React from'react';export default function Image({unoptimized,priority,...props}){return React.createElement('img',props)}"
          : "import React from'react';export default function Link(props){return React.createElement('a',props)}", loader: "js", resolveDir: process.cwd() }));
    } }] });
  // Production cascade order: compatibility styles precede the copied PHP theme.
  const css = (await Promise.all(sources.slice(0, 3).map(file => readFile(file, "utf8")))).join("\n").replace(/@font-face\s*\{[^}]*\}/g, "").replace(/@import[^;]+;/g, "");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  page.setDefaultTimeout(10_000);
  const checks: string[] = [], failures: string[] = [], screenshots: string[] = [], queries: string[] = [], measurements: object[] = [];
  let passed = false;
  page.on("pageerror", () => failures.push("pageerror"));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") { failures.push("Unexpected request"); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!DOCTYPE html><html><head><style>${css}</style></head><body data-pc-theme="light" data-pc-direction="ltr" data-pc-preset="preset-1" data-pc-sidebar-caption="true"><div id="root"></div><script src="/component.js"></script></body></html>` });
    if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
    if (url.pathname === "/api/pipeline") { queries.push(url.search); return route.fulfill({ json: data }); }
    if (url.pathname === "/api/pipeline/agents") return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25 } });
    if (url.pathname === "/legacy/assets/images/logo-voltronix.png") return route.fulfill({ contentType: "image/png", body: await readFile("public" + url.pathname) });
    failures.push("Unexpected route " + url.pathname); return route.abort();
  });
  const check = async (label: string, run: () => Promise<void>) => { await run(); checks.push(label); };
  try {
    await page.goto(origin); await page.locator(".pipeline-column").first().waitFor();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const geometry = await page.locator(".pipeline-board").evaluate(board => ({ documentWidth: document.documentElement.scrollWidth, width: board.clientWidth, scrollWidth: board.scrollWidth,
        columns: [...board.querySelectorAll<HTMLElement>(".pipeline-column")].map(column => {
          const rect = column.getBoundingClientRect();
          const heading = column.querySelector("h2")!, range = document.createRange(); range.selectNodeContents(heading);
          const badge = column.querySelector<HTMLElement>(".lead-meta .badge")!, card = column.querySelector(".lead-card")!;
          const body = column.querySelector<HTMLElement>(".pipeline-body")!;
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, headingLines: new Set([...range.getClientRects()].map(line => Math.round(line.top))).size,
            badgeLeft: badge.getBoundingClientRect().left, badgeRight: badge.getBoundingClientRect().right, cardLeft: card.getBoundingClientRect().left, cardRight: card.getBoundingClientRect().right,
            badgeWidth: badge.clientWidth, badgeScrollWidth: badge.scrollWidth, bodyHeight: body.clientHeight, bodyScrollHeight: body.scrollHeight,
            cardBottom: card.getBoundingClientRect().bottom, columnBottom: rect.bottom };
        }) }));
      measurements.push({ viewportWidth: width, ...geometry });
      await check(`${width}px headers and full status badges remain legible without document overflow`, async () => {
        assert.equal(geometry.documentWidth, width); assert.equal(geometry.columns.length, 5);
        for (const column of geometry.columns) {
          assert.equal(column.headingLines, 1); assert.ok(column.badgeLeft >= column.cardLeft && column.badgeRight <= column.cardRight);
          assert.ok(column.badgeScrollWidth <= column.badgeWidth + 1);
          if (width >= 768) assert.equal(column.height, 800, "desktop and tablet retain 80vh column height");
          else {
            assert.ok(column.height < 800, "stacked phone stages shrink to their content");
            assert.ok(column.bodyScrollHeight <= column.bodyHeight + 1, "phone stage content needs no nested vertical scrolling");
            assert.ok(column.cardBottom <= column.columnBottom + 1, "phone card and detail action fit inside their stage");
          }
        }
        if (width >= 768) { assert.ok(geometry.columns.every(column => column.width >= 220)); assert.equal(new Set(geometry.columns.map(column => column.y)).size, 1); }
        else { assert.equal(geometry.scrollWidth, geometry.width); assert.ok(geometry.columns.every((column, index) => index === 0 || column.y > geometry.columns[index - 1]!.y)); }
      });
      const filename = `pipeline-${width}.png`; await page.screenshot({ path: join(directory, filename), fullPage: true, animations: "disabled" }); screenshots.push(filename);
      if (width === 768) await check("Tablet board supports keyboard horizontal scroll to the final stage without moving the document", async () => {
        const board = page.getByRole("region", { name: "Lead pipeline board", exact: true });
        assert.ok(geometry.scrollWidth > geometry.width); await board.evaluate(element => (element as HTMLElement).focus({ preventScroll: true })); await page.keyboard.press("ArrowRight");
        await page.waitForFunction(() => document.querySelector(".pipeline-board")!.scrollLeft > 0);
        // Let Chromium's keyboard scroll finish before setting and capturing the
        // final position; its pending animation can otherwise undo scrollLeft.
        await board.evaluate(async element => {
          let previous = element.scrollLeft, stable = 0;
          for (let frames = 0; frames < 120 && stable < 4; frames++) {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            const current = element.scrollLeft; stable = current === previous ? stable + 1 : 0; previous = current;
          }
        });
        await board.evaluate(element => { element.scrollTo({ left: element.scrollWidth, behavior: "instant" }); });
        const final = await page.locator(".pipeline-column").last().boundingBox(), bounds = await board.boundingBox();
        assert.ok(final && bounds && final.x >= bounds.x && final.x + final.width <= bounds.x + bounds.width + 1);
        assert.equal(await page.evaluate(() => window.scrollX), 0);
        // Keep the viewport fixed here: full-page capture can reset a nested
        // scroller during Chromium's temporary viewport resize.
        await page.screenshot({ path: join(directory, "pipeline-768-final-stage.png") }); screenshots.push("pipeline-768-final-stage.png");
        await board.evaluate(element => { element.scrollLeft = 0; });
      });
    }
    await check("Responsive rendering preserves forced own scope and all existing detail links", async () => {
      assert.ok(queries.length > 0 && queries.every(query => new URLSearchParams(query).get("scope") === "own"));
      assert.deepEqual(await page.locator(".lead-meta a").evaluateAll(links => links.map(link => link.getAttribute("href"))), data.items.map(item => "/leads/" + item.id));
    });
    assert.deepEqual(failures, []); passed = true;
  } finally {
    await browser.close();
    await writeFile(join(directory, "receipt.json"), JSON.stringify({ status: passed ? "PASS" : "FAIL", scope: "Isolated React fixture with the copied PHP theme. All requests intercepted; no credentials, running demo, database or business writes. This does not establish authenticated acceptance.", checks, checkCount: checks.length, failures, screenshots, measurements, sources: hashes }, null, 2), { flag: "wx" });
    t.diagnostic("Pipeline layout evidence: " + directory);
  }
});
