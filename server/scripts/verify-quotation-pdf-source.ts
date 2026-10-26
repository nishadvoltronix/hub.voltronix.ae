import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { renderQuotationPdf } from "../src/crm/quotation-pdf/render.js";
import { calculateSavedQuotation, parseSavedQuotationInput } from "../src/crm/commercial/quotations.js";
import { quotationPdfFixture } from "../tests/helpers/quotation-pdf-fixture.js";

// This script constructs synthetic objects only. It has no database, credentials or HTTP client.
const directory = resolve(".local-data/reports", `quotation-pdf-source-${randomUUID()}`);
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
await mkdir(directory, { recursive: true });
const records: unknown[] = [];
let success = false;
try {
  for (const [brand, company] of [["contracting", "VOLTRONIX CONTRACTING LLC"], ["switchgear", "VOLTRONIX SWITCHGEAR LLC"]] as const) {
    for (const policy of ["percentage-only-v2", "percentage-create-v1"] as const) {
      const fixture = quotationPdfFixture(company), name = `${brand}-${policy}`;
      fixture.createdAt = "2026-09-01T01:00:00.000Z"; fixture.updatedAt = "2026-10-03T20:05:00.000Z"; fixture.quotation.validUntil = "2026-11-03";
      if (policy === "percentage-create-v1") {
        const { discountType, ...saved } = fixture.quotation; void discountType;
        fixture.calculationPolicy = policy;
        fixture.quotation = parseSavedQuotationInput({ ...saved, discount: "150", items: Array.from({ length: 12 }, (_, index) => ({ ...saved.items[0]!, productId: String(90000 + index), productName: `SYNTHETIC ROW ${index + 1}`, description: Array.from({ length: 7 }, (_value, line) => `Recorded fixture row ${index + 1}, description ${line + 1}.`).join("\n") })) }, policy);
      }
      fixture.totals = calculateSavedQuotation(fixture.quotation, policy); fixture.subtotal = fixture.totals.subtotal; fixture.grandTotal = fixture.totals.grandTotal;
      const before = JSON.stringify(fixture), result = await renderQuotationPdf(fixture);
      assert.equal(JSON.stringify(fixture), before, "renderer leaves complete input unchanged");
      await writeFile(join(directory, `${name}.pdf`), result.bytes, { flag: "wx" });
      const loading = getDocument({ data: new Uint8Array(result.bytes), useSystemFonts: false });
      const pdf = await loading.promise, images: { filename: string; sha256: string }[] = [];
      try {
        assert.equal(pdf.numPages, result.pages);
        assert.equal(await pdf.getAttachments(), null); assert.equal(await pdf.getJSActions(), null);
        for (const number of [...new Set([1, 2, pdf.numPages].filter(number => number <= pdf.numPages))]) {
          const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1.5 });
          const surface = (pdf.canvasFactory as { create(width: number, height: number): { canvas: HTMLCanvasElement & { toBuffer(type: "image/png"): Buffer }; context: CanvasRenderingContext2D } }).create(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await page.render({ canvas: surface.canvas, canvasContext: surface.context, viewport }).promise;
          const png = surface.canvas.toBuffer("image/png"), filename = `${name}-page-${number}.png`;
          await writeFile(join(directory, filename), png, { flag: "wx" }); images.push({ filename, sha256: sha256(png) });
        }
        records.push({ fixture: name, pages: result.pages, pdfSha256: sha256(result.bytes), inputSha256Before: sha256(before), inputSha256After: sha256(JSON.stringify(fixture)), metadata: (await pdf.getMetadata()).info, images });
      } finally { await loading.destroy(); }
    }
  }
  success = true;
} finally {
  await writeFile(join(directory, "receipt.json"), JSON.stringify({ status: success ? "PASS" : "FAIL", scope: "Synthetic company PDFs only; no CRM records, existing PDF files, credentials, sessions, database writes or external requests.", records }, null, 2), { flag: "wx" });
  console.log(`Synthetic PDF source evidence: ${directory}`);
}
