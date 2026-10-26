import { preservedSource } from "./helpers/preserved-source";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { chromium, type Route } from "playwright";
import { TASK_ATTACHMENT_EXTENSIONS } from "@voltronix/crm-contracts";

test("OFFLINE original attachment cards preserve private preview/download boundaries, unavailable modal and guarded upload", { timeout: 60_000 }, async t => {
  const origin = "http://127.0.0.1:39991", directory = resolve(".local-data", "reports", `attachments-source-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const original = await readFile(preservedSource("application/views/Leads_Pipeline/Lead_Details.php"), "utf8");
  for (const name of ["attachment-card", "attachment-preview", "attachment-image", "attachment-info", "attachment-actions"]) assert.ok(original.includes(name));
  assert.match(original, /height: 110px/);
  const files = [
    { id: "1", name: "Saved image.gif", mediaType: "image/gif", size: 43, createdAt: "2026-10-13T08:00:00Z" },
    { id: "2", name: "Saved quotation.pdf", mediaType: "application/pdf", size: 1234, createdAt: "2026-10-12T08:00:00Z" },
    { id: "3", name: "Saved work notes.txt", mediaType: "text/plain", size: 100, createdAt: "2026-10-11T08:00:00Z" },
    { id: "4", name: "Saved measurements.csv", mediaType: "text/csv", size: 150, createdAt: "2026-10-10T08:00:00Z" },
    { id: "5", name: "Unavailable image with an unusually long original filename requiring ellipsis.gif", mediaType: "image/gif", size: 43, createdAt: "2026-10-09T08:00:00Z" },
    ...["doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip", "rar", "7z", "bmp", "webp"].map((extension, index) => ({ id: String(index + 6), name: `Saved source file.${extension}`, mediaType: extension === "bmp" || extension === "webp" ? `image/${extension}` : "application/octet-stream", size: 200, createdAt: "2026-10-13T08:00:00Z" })),
  ];
  const bundle = await build({ stdin: { contents: "import {createRoot} from 'react-dom/client';import {CrmChrome} from './src/components/crm/chrome';import {Attachments} from './src/components/crm/attachments';createRoot(document.getElementById('root')).render(<CrmChrome user={{localUserId:'999',username:'Synthetic worker',email:'fixture@example.invalid',permissions:[]}}><Attachments taskId='999'/></CrmChrome>);", loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "next-stubs", setup(api) {
    api.onResolve({ filter: /^next\/(image|link|navigation)$/ }, args => ({ path: args.path, namespace: "fixture" })); api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path.endsWith("navigation") ? "export function useRouter(){return{refresh(){},replace(){}}};export function usePathname(){return '/leads/999'};export function useSearchParams(){return new URLSearchParams()}" : args.path.endsWith("image") ? "import React from'react';export default function Image({unoptimized,priority,...props}){return React.createElement('img',props)}" : "import React from'react';export default function Link(props){return React.createElement('a',props)}", loader: "js", resolveDir: process.cwd() }));
  } }] });
  const styles = ["src/app/globals.css", ...["plugins/phosphor-icons.css", "plugins/tabler-icons.min.css", "hrms.css", "style.css"].map(file => "public/legacy/assets/css/" + file)];
  const css = (await Promise.all(styles.map(file => readFile(file, "utf8")))).join("\n").replace(/@font-face\s*\{[^}]*\}/g, "").replace(/@import[^;]+;/g, "");
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  page.setDefaultTimeout(10_000);
  const checks: string[] = [], requests: string[] = [], failures: string[] = [], screenshots: string[] = [];
  let pending: Route | undefined, uploadCount = 0, canUpload = true, passed = false;
  page.on("pageerror", () => failures.push("pageerror"));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()); requests.push(request.method() + " " + url.pathname);
    if (url.origin !== origin) { failures.push("External request"); return route.abort(); }
    if (request.method() === "POST" && url.pathname === "/api/leads/999/attachments") {
      assert.equal(request.headers()["x-csrf-token"], "synthetic-csrf"); assert.match(request.headers()["content-type"]!, /^multipart\/form-data; boundary=/);
      const body = request.postDataBuffer()!.toString("utf8"); assert.match(body, /name="expectedVersion"\r\n\r\n8\r\n/); assert.match(body, /filename="synthetic-upload.txt"/);
      uploadCount++; pending = route; return;
    }
    if (request.method() !== "GET") { failures.push("Unexpected mutation"); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!DOCTYPE html><html><head><style>${css}</style></head><body data-pc-theme="light" data-pc-direction="ltr" data-pc-preset="preset-1"><div id="root"></div><script src="/component.js"></script></body></html>` });
    if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
    if (url.pathname.startsWith("/legacy/") || url.pathname === "/api/attachments/1/preview") return route.fulfill({ contentType: "image/gif", body: Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64") });
    if (url.pathname === "/api/attachments/5/preview") return route.fulfill({ status: 404, json: { error: "Synthetic unavailable preview" } });
    if (url.pathname === "/api/leads/999/attachments") return route.fulfill({ json: { items: files, total: files.length, page: 1, pageSize: 25, version: 8, canUpload } });
    if (url.pathname === "/api/auth/csrf") return route.fulfill({ json: { csrfToken: "synthetic-csrf" } });
    failures.push("Unexpected path " + url.pathname); return route.abort();
  });
  try {
    await page.goto(origin); await page.getByRole("heading", { name: "Uploaded Attachments", exact: true }).waitFor(); await page.getByRole("article", { name: files[0]!.name, exact: true }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "File Upload", exact: true }).count(), 1); assert.equal(await page.getByText(`${files.length} Files`, { exact: true }).count(), 1);
    assert.equal(await page.getByLabel("Attachment file", { exact: true }).getAttribute("accept"), TASK_ATTACHMENT_EXTENSIONS.map(value => "." + value).join(","));
    for (const file of files.slice(5)) {
      const card = page.getByRole("article", { name: file.name, exact: true }); assert.equal(await card.getByRole("link", { name: /^View / }).count(), 0); assert.equal(await card.getByText("Download only", { exact: true }).count(), 1);
      assert.equal(requests.includes(`GET /api/attachments/${file.id}/preview`), false);
    }
    for (const file of files) {
      const card = page.getByRole("article", { name: file.name, exact: true });
      assert.equal(await card.getByRole("link", { name: file.name, exact: true }).getAttribute("href"), `/api/attachments/${file.id}`);
      assert.equal(await card.getByRole("link", { name: `Download ${file.name}`, exact: true }).getAttribute("href"), `/api/attachments/${file.id}`);
      assert.equal(await card.getByText("Created: " + file.createdAt, { exact: true }).count(), 1);
    }
    const pdf = page.getByRole("article", { name: files[1]!.name, exact: true }); assert.equal(await pdf.getByRole("link", { name: /^View / }).count(), 0); assert.equal(await pdf.getByText("Download only", { exact: true }).count(), 1);
    for (const file of files.slice(2, 4)) assert.equal(await page.getByRole("link", { name: `View ${file.name}`, exact: true }).getAttribute("href"), `/api/attachments/${file.id}/preview`);
    assert.equal(requests.includes("GET /api/attachments/2/preview"), false); checks.push("Original file cards/count/date/actions use private routes; PDF never previews, text/CSV remain inert separate-tab links");
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      const size = await page.locator(".attachment-preview").first().boundingBox(); assert.equal(size?.height, 110);
      const file = `attachment-cards-${width}.png`; await page.screenshot({ path: join(directory, file), fullPage: true }); screenshots.push(file);
      checks.push(`${width}px card grid fits and retains original 110px preview height`);
    }
    const missing = page.getByRole("article", { name: files[4]!.name, exact: true }); await missing.scrollIntoViewIfNeeded(); await missing.getByRole("button", { name: `View ${files[4]!.name}`, exact: true }).click();
    const modal = page.getByRole("dialog", { name: "File unavailable", exact: true }); await modal.waitFor(); await page.screenshot({ path: join(directory, "attachment-unavailable-390.png"), fullPage: true }); screenshots.push("attachment-unavailable-390.png");
    await modal.getByRole("button", { name: "OK", exact: true }).click(); assert.equal(uploadCount, 0); checks.push("Unavailable image retains name/download and opens a closeable explanatory modal without a mutation");
    await page.getByLabel("Attachment file", { exact: true }).setInputFiles({ name: "synthetic-upload.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic intercepted upload only") }); await page.getByRole("button", { name: "Upload attachment", exact: true }).click();
    for (let i = 0; !pending && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(pending);
    assert.equal(await page.getByRole("button", { name: "Upload attachment", exact: true }).isDisabled(), true); assert.equal(await page.getByRole("button", { name: "Refresh attachments", exact: true }).isDisabled(), true);
    await pending.fulfill({ status: 409, json: { error: "Synthetic stale file version" } }); pending = undefined; await page.getByRole("alert").waitFor();
    assert.match(await page.getByLabel("Attachment file", { exact: true }).inputValue(), /synthetic-upload\.txt$/); checks.push("Source Upload Now keeps existing CSRF/version multipart contract and preserves selected file after stale refusal");
    canUpload = false; await page.goto(origin); await page.getByRole("article", { name: files[0]!.name, exact: true }).waitFor(); assert.equal(await page.getByLabel("Attachment file", { exact: true }).count(), 0); assert.equal(await page.getByRole("button", { name: "Upload attachment", exact: true }).count(), 0); checks.push("Readonly attachment capability renders cards without upload controls");
    assert.equal(uploadCount, 1); assert.deepEqual(failures, []); passed = true;
  } finally {
    if (pending) await pending.abort(); await browser.close(); await writeFile(join(directory, "receipt.json"), JSON.stringify({ status: passed ? "PASS" : "FAIL", scope: "Original attachment card styles with synthetic files; private preview GETs and one intercepted refused upload. No authentication or live database/filesystem mutation.", checkCount: checks.length, checks, requests, screenshots, syntheticUploadCount: uploadCount, failures }, null, 2), { flag: "wx" }); t.diagnostic("Attachment source evidence: " + directory);
  }
});
