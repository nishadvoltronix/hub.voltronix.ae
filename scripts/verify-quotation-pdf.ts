import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { renderQuotationPdf } from "../src/server/quotation-pdf/render";
import { quotationPdfFixture } from "../tests/helpers/quotation-pdf-fixture";
import { calculateQuotation } from "../src/server/commercial/quotations";
import { pdfGlyphSamples } from "../tests/helpers/pdf-glyph-samples";

async function main() {
  const reports = join(process.cwd(), ".local-data", "reports"); mkdirSync(reports, { recursive: true });
  const directory = mkdtempSync(join(reports, "quotation-pdf-"));
  for (const [name, company] of [["contracting", "VOLTRONIX CONTRACTING LLC"], ["switchgear", "VOLTRONIX SWITCHGEAR LLC"]] as const) {
    const fixture = quotationPdfFixture(company);
    fixture.quotation.items[0]!.description = Object.values(pdfGlyphSamples).join("\n");
    if (name === "switchgear") {
      fixture.quotation.items[0]!.description += "\n" + Array.from({ length: 75 }, (_, index) => `Synthetic continuation line ${index + 1}: supply, installation and testing.`).join("\n");
    }
    fixture.totals = calculateQuotation(fixture.quotation, "percentage");
    const result = await renderQuotationPdf(fixture);
    writeFileSync(join(directory, `${name}.pdf`), result.bytes, { flag: "wx" });
    const loading = getDocument({ data: new Uint8Array(result.bytes), useSystemFonts: false });
    const document = await loading.promise;
    for (const number of [...new Set([1, document.numPages])]) {
      const page = await document.getPage(number), viewport = page.getViewport({ scale: 1.5 });
      const surface = (document.canvasFactory as { create(width: number, height: number): {
        canvas: HTMLCanvasElement & { toBuffer(type: "image/png"): Buffer }; context: CanvasRenderingContext2D;
      } }).create(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvas: surface.canvas, canvasContext: surface.context, viewport }).promise;
      writeFileSync(join(directory, `${name}-page-${number}.png`), surface.canvas.toBuffer("image/png"), { flag: "wx" });
    }
    await loading.destroy();
    console.log(`${name}: ${result.pages} page(s), valid PDF and independently rendered first/last pages.`);
  }
  console.log(`Synthetic PDF evidence only: ${directory}`);
}
main().catch(() => { console.error("Quotation PDF verification failed."); process.exitCode = 1; });
