import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// Original uploads are read only. No database, credentials, HTTP client or
// financial replay is involved. Customer text is never printed or persisted by
// this helper; source paths, metadata and selected rasters stay in ignored storage.
const root = resolve(".."), directory = resolve(".local-data/reports", `original-pdf-comparison-${randomUUID()}`);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const records: Record<string, unknown>[] = [], before = new Map<string, string>(), selected = new Set<string>();
await mkdir(directory, { recursive: true });
let success = false, rasterized = 0;
function printedTotals(text: string) {
  const tokens = text.split("\n").map(value => value.trim()).filter(Boolean);
  const amount = (pattern: RegExp) => {
    const at = tokens.findIndex(value => pattern.test(value));
    if (at < 0) return null;
    const value = tokens[at + 1]?.replace(/^AED\s+/, "");
    return value && /^\d[\d,]*\.\d{2}$/.test(value) ? BigInt(value.replaceAll(",", "").replace(".", "")) : null;
  };
  const subtotal = amount(/^(?:Sub Total|Total Amount):?$/i), vat = amount(/^VAT\s*\(?5%\)?:?$/i), grand = amount(/^Grand Total(?: Amount Included VAT)?:?$/i);
  const present = subtotal !== null && vat !== null && grand !== null;
  return { allThreePrintedAmountsHaveTwoDecimals: present,
    printedSubtotalPlusVatEqualsGrand: present ? subtotal + vat === grand : null,
    printedVatEqualsFivePercentOfPrintedSubtotalAtHalfUpCents: present ? (subtotal * 5n + 50n) / 100n === vat : null,
    limit: "Printed-value comparison only; no assertion about missing inputs, original discount intent, database linkage or authoritative reconciliation." };
}
try {
  const files = (await readdir(join(root, "assets/photos"), { withFileTypes: true })).filter(file => file.isFile() && /\.pdf$/i.test(file.name)).sort((a, b) => a.name.localeCompare(b.name));
  for (const file of files) {
    const relativePath = `assets/photos/${file.name}`, bytes = await readFile(join(root, relativePath)), digest = hash(bytes);
    before.set(relativePath, digest);
    assert.ok(bytes.length <= 16 * 1024 * 1024, "original inspection byte budget");
    const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, standardFontDataUrl: resolve(root, "node_modules/pdfjs-dist/standard_fonts") + "/" });
    try {
      const pdf = await loading.promise, info = (await pdf.getMetadata()).info as Record<string, unknown>;
      assert.ok(pdf.numPages <= 100, "original inspection page budget");
      const texts: string[] = [], dimensions: number[][] = [], dates: Record<string, boolean>[] = [];
      const headerLabelsByPage: string[][] = [], fonts = [...new Set([...bytes.toString("latin1").matchAll(/\/(?:BaseFont|FontName)\s*\/([^\s/<>()]+)/g)].map(match => match[1]!))];
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number), content = await page.getTextContent({ disableNormalization: true });
        const text = content.items.filter(item => "str" in item).map(item => "str" in item ? item.str : "").join("\n");
        texts.push(text); dimensions.push(page.view);
        headerLabelsByPage.push(["SALES QUOTATION", "Quote Ref:", "Date:", "Validity:", "Currency:", "Payment:", "Sales By:"].filter(label => text.includes(label)));
        dates.push({ sourceSwitchgearDayMonthYear: /Date:\s*\d{2}-\d{2}-\d{4}/.test(text), sourceContractingMonthDayTime: /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}\s+[AP]M/.test(text), historicalDaysOnlyValidity: /Validity:\s*\d+\s+days/i.test(text) });
      }
      const mpdf = info.Producer === "mPDF 8.1.6" && texts[0]?.includes("SALES QUOTATION");
      const contracting = info.Producer === "PDFium" && texts.some(text => /CONTRACTING/i.test(text)) && texts.some(text => /QUOTATION/.test(text));
      const sample = !selected.has(digest) && (mpdf || contracting && selected.size < 3);
      const images: { file: string; sha256: string }[] = [];
      if (sample) {
        selected.add(digest);
        for (const number of [...new Set([1, pdf.numPages])]) {
          const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1.4 });
          const surface = (pdf.canvasFactory as { create(width: number, height: number): { canvas: HTMLCanvasElement & { toBuffer(type: "image/png"): Buffer }; context: CanvasRenderingContext2D } }).create(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await page.render({ canvas: surface.canvas, canvasContext: surface.context, viewport }).promise;
          const png = surface.canvas.toBuffer("image/png"), name = `original-${digest.slice(0, 12)}-page-${number}.png`;
          await writeFile(join(directory, name), png, { flag: "wx" }); images.push({ file: name, sha256: hash(png) }); rasterized++;
        }
      }
      records.push({ relativePath, sha256: digest, bytes: bytes.length, pages: pdf.numPages, info, dimensions, fonts, dates, headerLabelsByPage,
        provenance: mpdf ? "mPDF producer declaration and source-sized Switchgear layout; original generation not cryptographically attested" : contracting ? "Reprocessed Contracting quotation example; PDFium metadata does not establish original engine/version" : "Other uploaded PDF; no CRM generation claim",
        printedFinalPageTotals: mpdf || contracting ? printedTotals(texts.at(-1) ?? "") : null, images });
    } finally { await loading.destroy(); }
  }
  for (const [path, digest] of before) assert.equal(hash(await readFile(join(root, path))), digest, "every original remains byte identical");
  success = true;
} finally {
  await writeFile(join(directory, "receipt.json"), JSON.stringify({ status: success ? "PASS" : "FAIL", capturedAt: new Date().toISOString(), originalFiles: before.size,
    uniqueOriginalHashes: new Set(before.values()).size, rasterizedPages: rasterized, allOriginalBytesPreserved: success,
    scope: "Local original examples only; no live PHP, database linkage, historical regeneration or financial-policy certification. PDF contents and metadata are untrusted provenance hints.", records }, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ status: success ? "PASS" : "FAIL", originalFiles: before.size, rasterizedPages: rasterized, evidence: directory }));
}
