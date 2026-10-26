import assert from "node:assert/strict";
import test from "node:test";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { preservedPath } from "../../tools/preservation-paths.mjs";
import { amountInWords, QuotationPdfError, renderQuotationPdf } from "../src/crm/quotation-pdf/render.js";
import { createQuotationPdfService } from "../src/crm/quotation-pdf/service.js";
import { calculateLocalQuotation, calculateQuotation, calculateSavedQuotation, parseSavedQuotationInput } from "../src/crm/commercial/quotations.js";



async function inspect(bytes: Buffer) {
  const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
  const pdf = await loading.promise;
  const pageText: string[] = [], sizes: number[][] = [];
  const boxes: { page: number; text: string; x: number; y: number; width: number; height: number; fontName: string }[] = [];
  const fills: unknown[] = [], strokeWidths: number[] = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    // Keep compatibility characters (micro sign, superscript units) distinct.
    const page = await pdf.getPage(number), content = await page.getTextContent({ disableNormalization: true });
    pageText.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
    const viewport = page.getViewport({ scale: 1 }); sizes.push([viewport.width, viewport.height]);
    const operators = await page.getOperatorList();
    operators.fnArray.forEach((operation, index) => {
      if (operation === OPS.setFillRGBColor) fills.push(operators.argsArray[index]);
      if (operation === OPS.setLineWidth) strokeWidths.push(Number(operators.argsArray[index]?.[0]));
    });
    assert.deepEqual(await page.getAnnotations(), []);
    const top = viewport.height > 830 ? 100 : 120;
    const bottom = viewport.height > 830 ? viewport.height - 44 : 580;
    for (const item of content.items) if ("str" in item && item.str.trim()) {
      const fromTop = viewport.height - item.transform[5]!;
      boxes.push({ page: number, text: item.str, x: item.transform[4]!, y: fromTop, width: item.width, height: item.height, fontName: item.fontName });
      assert.ok(fromTop >= top && fromTop <= bottom, `text stays within protected content area: ${fromTop}`);
      assert.ok(item.transform[4]! >= 20 && item.transform[4]! + item.width <= viewport.width - 20, "text stays inside page width");
    }
  }
  assert.equal(await pdf.getAttachments(), null);
  assert.equal(await pdf.getJSActions(), null);
  const metadata = await pdf.getMetadata();
  const result = { pages: pdf.numPages, text: pageText.join("\n"), pageText, sizes, boxes, fills, strokeWidths, info: metadata.info as Record<string, unknown> };
  await loading.destroy(); return result;
}
test("Contracting PDF preserves canonical exact discounted totals, recorded fields and literal text", async () => {
  const fixture = quotationPdfFixture(), result = await renderQuotationPdf(fixture), parsed = await inspect(result.bytes);
  assert.equal(result.bytes.subarray(0, 8).toString(), "%PDF-1.7");
  assert.ok(result.bytes.length > 100_000);
  assert.deepEqual(parsed.sizes[0], [595.28, 841.89]);
  assert.match(parsed.text, /QUOTATION/); assert.match(parsed.text, /Synthetic sales agent/);
  assert.match(parsed.text, /2\.5/); assert.match(parsed.text, /225\.23/); assert.match(parsed.text, /Grand Total:\s+AED 224\.16/);
  assert.match(parsed.text, /Adjustment:\s+AED -0\.50/); assert.match(parsed.text, /<script>alert\('test'\)<\/script>/);
  assert.match(parsed.text, /https:\/\/invalid.example\/image.png/);
  assert.match(parsed.text, /Marieswaran/); assert.match(parsed.text, /No exclusions|Civil works excluded/);
  assert.equal(result.filename, "quotation_SYNTHETIC-QUOTE-001.pdf");
});
test("Switchgear uses source paper size, quote-deal reference and amount-in-words with canonical totals", async () => {
  const fixture = quotationPdfFixture("VOLTRONIX SWITCHGEAR LLC");
  fixture.task.taxTotal = "9999"; // Legacy arbitrary tax_total is not the certified new-record policy.
  const result = await renderQuotationPdf(fixture), parsed = await inspect(result.bytes);
  assert.ok(Math.abs(parsed.sizes[0]![0]! - 609.448819) < 0.001);
  assert.match(parsed.text, /SALES QUOTATION/); assert.match(parsed.text, /Quote Ref: QUOTE-001/);
  assert.match(parsed.text, /104900827700003/); assert.match(parsed.text, /DIRHAMS TWO HUNDRED AND TWENTY-FOUR POINT SIXTEEN FILS ONLY/);
  assert.match(parsed.text, /IP54 test specification/); assert.match(parsed.text, /VAT \(5%\):\s+AED 10\.70/);
  assert.doesNotMatch(parsed.text, /9999/);
});

test("saved legacy PDF preserves amount headers above 100 and rejects a relabelled percentage policy", async () => {
  const fixture = quotationPdfFixture(), { discountType, ...saved } = fixture.quotation;
  void discountType;
  fixture.calculationPolicy = "percentage-create-v1";
  fixture.quotation = parseSavedQuotationInput({ ...saved, discount: "150" }, fixture.calculationPolicy);
  fixture.totals = calculateSavedQuotation(fixture.quotation, fixture.calculationPolicy);
  fixture.subtotal = fixture.totals.subtotal; fixture.grandTotal = fixture.totals.grandTotal;
  const before = JSON.stringify(fixture), parsed = await inspect((await renderQuotationPdf(fixture)).bytes);
  assert.match(parsed.text, /Discount \(saved amount\):\s+AED 150\.00/);
  assert.match(parsed.text, /Grand Total:\s+AED 78\.49/);
  assert.doesNotMatch(parsed.text, /150%/);
  assert.equal(JSON.stringify(fixture), before);
  fixture.quotation = { ...fixture.quotation, discountType: "percentage" };
  await assert.rejects(renderQuotationPdf(fixture), error => error instanceof QuotationPdfError && error.status === 409);
});

test("fractional header PDF renders exact percentage deduction without rounding the calculation early", async () => {
  const fixture = quotationPdfFixture();
  fixture.quotation = { ...fixture.quotation, discount: "33.333333333333333333", adjustment: "0",
    items: ["90001", "90002"].map(productId => ({ ...fixture.quotation.items[0]!, productId, quantity: "0.5", unitPrice: "0.01", itemDiscount: "0" })) };
  fixture.totals = calculateQuotation(fixture.quotation);
  fixture.subtotal = fixture.totals.subtotal; fixture.grandTotal = fixture.totals.grandTotal;
  assert.equal(fixture.totals.headerDiscount, "0.0033333333333333333333");
  assert.equal(fixture.totals.headerDiscountAmount, "0.00");
  const parsed = await inspect((await renderQuotationPdf(fixture)).bytes);
  assert.match(parsed.text.replaceAll(" ", ""), /Discount\(33\.333333333333333333%\):AED0\.00/);
  assert.match(parsed.text, /Grand Total:\s+AED 0\.01/);
});

test("recorded quotation dates preserve creation and latest save across Dubai midnight for both saved policies", async () => {
  for (const company of ["VOLTRONIX CONTRACTING LLC", "VOLTRONIX SWITCHGEAR LLC"]) {
    for (const policy of ["percentage-create-v1", "percentage-only-v2"] as const) {
      const fixture = quotationPdfFixture(company);
      fixture.createdAt = "2026-10-12T20:15:00.000Z";
      fixture.updatedAt = "2026-10-13T20:30:00.000Z";
      fixture.quotation.validUntil = "2026-10-31";
      if (policy === "percentage-create-v1") {
        const { discountType, ...saved } = fixture.quotation; void discountType;
        fixture.calculationPolicy = policy; fixture.quotation = parseSavedQuotationInput(saved, policy);
        fixture.totals = calculateSavedQuotation(fixture.quotation, policy);
        fixture.subtotal = fixture.totals.subtotal; fixture.grandTotal = fixture.totals.grandTotal;
      }
      const before = JSON.stringify(fixture), parsed = await inspect((await renderQuotationPdf(fixture)).bytes);
      assert.equal(parsed.info.CreationDate, "D:20261012201500Z");
      assert.equal(parsed.info.ModDate, "D:20261013203000Z");
      assert.match(parsed.text, company.includes("CONTRACTING") ? /Date:\s+Oct 14, 2026 12:30 AM/ : /Date:\s+14-10-2026/);
      assert.equal(JSON.stringify(fixture), before, "rendering never rewrites the historical quote or its timestamps");
    }
  }
  for (const createdAt of ["", "unknown", "2026-02-30T08:30:00.000Z"]) {
    const fixture = quotationPdfFixture(); fixture.createdAt = createdAt;
    await assert.rejects(renderQuotationPdf(fixture), error => error instanceof QuotationPdfError && error.status === 409);
  }
});
test("contracting PDF uses source two-column metadata, red six-column table and right-hand totals", async () => {
  const fixture = quotationPdfFixture(), parsed = await inspect((await renderQuotationPdf(fixture)).bytes);
  const find = (text: string) => {
    const box = parsed.boxes.find(box => box.page === 1 && box.text === text);
    assert.ok(box, `rendered text exists: ${text}`); return box;
  };
  const attn = find("Attn: Synthetic customer"), reference = find("Quote Ref: SYNTHETIC-QUOTE-001");
  assert.ok(Math.abs(attn.y - reference.y) < 0.01);
  assert.ok(attn.x < 100 && reference.x > parsed.sizes[0]![0]! / 2);
  assert.ok(Math.abs(find("QUOTATION").height - 17.25) < 0.01);
  const headers = ["S.No", "Item & Description", "Qty.", "U.O.M", "Unit Price", "Amount"].map(find);
  headers.forEach((box, index) => {
    assert.ok(Math.abs(box.y - headers[0]!.y) < 0.01);
    if (index) assert.ok(box.x > headers[index - 1]!.x);
  });
  assert.doesNotMatch(parsed.text, /Disc\.%|Tax%/);
  assert.match(parsed.text, /Line discount: 10%/);
  for (const label of ["Sub Total:", "Discount (5%):", "VAT (5%):", "Adjustment:", "Grand Total:"]) {
    assert.ok(find(label).x > 24 + (595.28 - 48) * 0.6, "summary labels stay in source right-hand 40% area");
  }
  assert.ok(JSON.stringify(parsed.fills).toLowerCase().includes("#ee473f"), "source red table header is painted");
});
test("switchgear PDF uses bordered customer grid and its quantity, tax and discount columns", async () => {
  const parsed = await inspect((await renderQuotationPdf(quotationPdfFixture("VOLTRONIX SWITCHGEAR LLC"))).bytes);
  const find = (text: string) => {
    const box = parsed.boxes.find(box => box.page === 1 && box.text === text);
    assert.ok(box, `rendered text exists: ${text}`); return box;
  };
  const customer = find("To: Synthetic customer"), reference = find("Quote Ref: QUOTE-001"), date = find("Date: 10-10-2026");
  assert.ok(Math.abs(customer.y - reference.y) < 0.01 && Math.abs(reference.y - date.y) < 0.01);
  assert.ok(reference.x >= 24 + (parsed.sizes[0]![0]! - 48) * 0.5);
  assert.ok(date.x >= 24 + (parsed.sizes[0]![0]! - 48) * 0.75);
  const headers = ["S.No.", "Description", "Quantity", "Rate", "Tax%", "Disc.%", "Amount"].map(find);
  headers.forEach((box, index) => {
    assert.ok(Math.abs(box.y - headers[0]!.y) < 0.01);
    if (index) assert.ok(box.x > headers[index - 1]!.x);
  });
  assert.ok(find("2.5 NOS").x > headers[1]!.x);
  assert.ok(find("5%").x > headers[3]!.x && find("5%").x < headers[5]!.x);
  assert.doesNotMatch(parsed.text, /U\.O\.M|Line discount:/);
  assert.match(parsed.text, /Received By:/); assert.match(parsed.text, /Authorized Signatory/);
  assert.ok(parsed.strokeWidths.includes(0.225), "source 0.3px borders are preserved in PDF points");
  assert.ok(!JSON.stringify(parsed.fills).toLowerCase().includes("#ee473f"), "contracting red is not applied to switchgear");
});
for (const company of ["VOLTRONIX CONTRACTING LLC", "VOLTRONIX SWITCHGEAR LLC"]) {
  test(`${company}: source item names are emphasized without changing literal description text`, async () => {
    const fixture = quotationPdfFixture(company), before = JSON.stringify(fixture);
    const parsed = await inspect((await renderQuotationPdf(fixture)).bytes);
    const name = parsed.boxes.find(box => box.text === "TEST ONLY panel"), description = parsed.boxes.find(box => box.text === "Line one");
    const heading = parsed.boxes.find(box => box.text === (company.includes("CONTRACTING") ? "QUOTATION" : "SALES QUOTATION"));
    assert.ok(name && description && heading);
    assert.equal(name.fontName, heading.fontName, "source product name uses the bold face");
    assert.notEqual(name.fontName, description.fontName, "description retains the regular face");
    assert.equal(JSON.stringify(fixture), before);
  });
  test(`${company}: item rows fitting a fresh page stay together with a repeated heading`, async () => {
    const fixture = quotationPdfFixture(company);
    fixture.quotation.items = Array.from({ length: 18 }, (_, index) => ({ ...fixture.quotation.items[0]!, productId: String(90000 + index), productName: `Row marker ${index}`, description: Array.from({ length: 7 }, (_value, line) => `Unique row ${index} detail ${line}`).join("\n") }));
    fixture.totals = calculateQuotation(fixture.quotation); fixture.subtotal = fixture.totals.subtotal; fixture.grandTotal = fixture.totals.grandTotal;
    const before = JSON.stringify(fixture), parsed = await inspect((await renderQuotationPdf(fixture)).bytes);
    assert.ok(parsed.pages > 2);
    for (let index = 0; index < 18; index++) {
      const texts = [`Row marker ${index}`, ...Array.from({ length: 7 }, (_value, line) => `Unique row ${index} detail ${line}`)];
      const pages = texts.map(text => { const found = parsed.boxes.filter(box => box.text === text); assert.equal(found.length, 1); return found[0]!.page; });
      assert.equal(new Set(pages).size, 1, `row ${index} remains on one page`);
      assert.match(parsed.pageText[pages[0]! - 1]!, /S\.No/);
    }
    assert.equal(JSON.stringify(fixture), before);
  });
}

test("Contracting source no-break terms and signature stay together when their complete section fits a page", async () => {
  const fixture = quotationPdfFixture(); fixture.quotation.items[0]!.description = Object.values(pdfGlyphSamples).join("\n");
  const before = JSON.stringify(fixture), parsed = await inspect((await renderQuotationPdf(fixture)).bytes);
  const pages = ["2. PAYMENT TERMS", "4. GENERAL EXCLUSIONS", "Yours faithfully,", "Marieswaran", "Mobile: 0502420957"].map(text => {
    const found = parsed.boxes.filter(box => box.text === text); assert.equal(found.length, 1); return found[0]!.page;
  });
  assert.equal(new Set(pages).size, 1, "source closing section is not orphaned across pages");
  assert.equal(JSON.stringify(fixture), before);
});

test("Switchgear continuation pages repeat the source customer header without changing either saved policy", async () => {
  for (const policy of ["percentage-create-v1", "percentage-only-v2"] as const) {
    const fixture = quotationPdfFixture("VOLTRONIX SWITCHGEAR LLC");
    fixture.quotation.items = Array.from({ length: 12 }, (_, index) => ({ ...fixture.quotation.items[0]!, productId: String(91000 + index), productName: `Preserved row ${index}`, description: Array.from({ length: 7 }, (_value, line) => `Preserved item ${index} line ${line}`).join("\n") }));
    if (policy === "percentage-create-v1") {
      const { discountType, ...saved } = fixture.quotation; void discountType;
      fixture.calculationPolicy = policy; fixture.quotation = parseSavedQuotationInput({ ...saved, discount: "150" }, policy);
    }
    fixture.totals = calculateSavedQuotation(fixture.quotation, policy); fixture.subtotal = fixture.totals.subtotal; fixture.grandTotal = fixture.totals.grandTotal;
    const before = JSON.stringify(fixture), parsed = await inspect((await renderQuotationPdf(fixture)).bytes);
    assert.ok(parsed.pages > 2);
    for (const [index, page] of parsed.pageText.entries()) {
      for (const expected of ["To: Synthetic customer", "Quote Ref: QUOTE-001", "Date: 10-10-2026", "Customer:", "Validity:", "Currency: AED", "Payment:", "Sales By: Synthetic sales agent", "Company TRN: 104900827700003", "Delivery Terms:"]) {
        assert.ok(page.includes(expected), `page ${index + 1} repeats original metadata ${expected}`);
      }
      assert.ok(page.includes(`Page ${index + 1} of ${parsed.pages}`), "actual page count is retained");
    }
    for (let index = 0; index < 12; index++) {
      const name = parsed.boxes.filter(box => box.text === `Preserved row ${index}`);
      assert.equal(name.length, 1, "rows are neither lost nor duplicated");
    }
    assert.equal(JSON.stringify(fixture), before);
    assert.match(parsed.pageText.at(-1)!, new RegExp(`Grand Total:\\s+AED ${fixture.totals.grandTotal.replace(".", "\\.")}`));
  }
});

test("both brands use the preserved PHP mPDF font and keep existing glyph fallback", async () => {
  for (const company of ["VOLTRONIX CONTRACTING LLC", "VOLTRONIX SWITCHGEAR LLC"]) {
  const fixture = quotationPdfFixture(company);
  const result = await renderQuotationPdf(fixture);
  assert.ok(/\/BaseFont\s*\/[A-Z]+\+DejaVuSansCondensed\b/.test(result.bytes.toString("latin1")), "original regular font is embedded");
  assert.ok(/\/BaseFont\s*\/[A-Z]+\+DejaVuSansCondensed-Bold\b/.test(result.bytes.toString("latin1")), "original bold font is embedded");
  fixture.quotation.items[0]!.description = "Preserved manat currency \u20bc";
  const before = JSON.stringify(fixture), fallback = await renderQuotationPdf(fixture), parsed = await inspect(fallback.bytes);
  assert.match(parsed.text, /Preserved manat currency \u20bc/);
  assert.ok(/\/BaseFont\s*\/[A-Z]+\+Roboto-Regular\b/.test(fallback.bytes.toString("latin1")), "existing glyph coverage keeps the verified fallback");
  assert.equal(JSON.stringify(fixture), before);
  }
});

test("source date punctuation and single-digit Contracting dates preserve Dubai values and metadata", async () => {
  for (const company of ["VOLTRONIX CONTRACTING LLC", "VOLTRONIX SWITCHGEAR LLC"]) {
    const fixture = quotationPdfFixture(company); fixture.createdAt = "2026-09-01T01:00:00.000Z"; fixture.updatedAt = "2026-10-03T20:05:00.000Z"; fixture.quotation.validUntil = "2026-11-03";
    const before = JSON.stringify(fixture), parsed = await inspect((await renderQuotationPdf(fixture)).bytes);
    assert.match(parsed.text, company.includes("CONTRACTING") ? /Date:\s+Oct 4, 2026 12:05 AM/ : /Date:\s+04-10-2026/);
    assert.match(parsed.text, company.includes("CONTRACTING") ? /Valid Till:\s+Nov 3, 2026/ : /Validity:\s+03-11-2026/);
    assert.equal(parsed.info.CreationDate, "D:20260901010000Z"); assert.equal(parsed.info.ModDate, "D:20261003200500Z");
    assert.equal(JSON.stringify(fixture), before);
  }
});

test("long single rows and multiline terms span pages without lost lines or clipped content", async () => {
  const fixture = quotationPdfFixture("VOLTRONIX SWITCHGEAR LLC");
  fixture.quotation.items[0]!.description = Array.from({ length: 120 }, (_, index) => `Unique description line ${String(index).padStart(3, "0")}`).join("\n");
  fixture.quotation.specification = Array.from({ length: 80 }, (_, index) => `Unique term line ${String(index).padStart(3, "0")}`).join("\n");
  fixture.totals = calculateQuotation(fixture.quotation, "percentage");
  const result = await renderQuotationPdf(fixture), parsed = await inspect(result.bytes);
  assert.ok(parsed.pages >= 6); assert.equal(result.pages, parsed.pages);
  for (let index = 0; index < 120; index++) assert.equal(parsed.text.split(`Unique description line ${String(index).padStart(3, "0")}`).length - 1, 1);
  for (let index = 0; index < 80; index++) assert.equal(parsed.text.split(`Unique term line ${String(index).padStart(3, "0")}`).length - 1, 1);
  for (let page = 0; page < parsed.pages; page++) assert.match(parsed.pageText[page]!, new RegExp(`Page ${page + 1} of ${parsed.pages}`));
});
test("missing company, sales person, account or Switchgear quote reference fail without fabricated metadata", async () => {
  for (const field of ["assignedCompany", "assignedSaleName", "assignedExternalId", "accountName", "quoteDealNumber"] as const) {
    const fixture = quotationPdfFixture("VOLTRONIX SWITCHGEAR LLC"); fixture.task[field] = null;
    await assert.rejects(renderQuotationPdf(fixture), (error) => error instanceof QuotationPdfError && error.status === 409);
  }
  await assert.rejects(renderQuotationPdf(quotationPdfFixture("Unverified company")), QuotationPdfError);
});
test("unknown calculation policy, corrupt totals and bad dates fail closed", async () => {
  const policy = quotationPdfFixture(); Object.assign(policy, { calculationPolicy: "unverified-import" });
  const totals = quotationPdfFixture(); totals.totals.grandTotal = "0.00";
  const date = quotationPdfFixture(); date.updatedAt = "not a date";
  const normalizedInvalidDate = quotationPdfFixture(); normalizedInvalidDate.updatedAt = "2026-02-30T08:30:00.000Z";
  for (const fixture of [policy, totals, date, normalizedInvalidDate]) await assert.rejects(renderQuotationPdf(fixture), QuotationPdfError);
});
test("unbroken text wraps by measured glyph width and unsafe filename characters never enter headers", async () => {
  const fixture = quotationPdfFixture();
  fixture.quoteNumber = 'QUOTE/\\:"<>|TEST';
  fixture.quotation.items[0]!.description = "W".repeat(800);
  fixture.totals = calculateQuotation(fixture.quotation, "percentage");
  const result = await renderQuotationPdf(fixture), parsed = await inspect(result.bytes);
  assert.match(result.filename, /^quotation_[A-Za-z0-9_-]+\.pdf$/);
  assert.equal((parsed.text.match(/W{2,}/g) ?? []).reduce((sum, run) => sum + run.length, 0), 800);
});
test("font limitations and control characters are explicit; Latin diacritics remain extractable", async () => {
  for (const value of ["Unsupported 🙂", "Unsupported مرحبا", "Bad\u202Espoof", "Bad\u0000control"]) {
    const fixture = quotationPdfFixture(); fixture.task.accountName = value;
    await assert.rejects(renderQuotationPdf(fixture), QuotationPdfError);
  }
  const fixture = quotationPdfFixture(); fixture.task.accountName = "Café Société — Łódź";
  assert.match((await inspect((await renderQuotationPdf(fixture)).bytes)).text, /Café Société — Łódź/);
});

for (const company of ["VOLTRONIX CONTRACTING LLC", "VOLTRONIX SWITCHGEAR LLC"]) {
  test(`${company}: supported script and engineering glyphs survive both fonts and PDF extraction`, async () => {
    const fixture = quotationPdfFixture(company);
    // The quotation reference is bold; line descriptions use the regular font.
    const labels = Object.values(pdfGlyphSamples).map((value) => value.normalize("NFC"));
    fixture.quoteNumber = `${pdfGlyphSamples.greek} ${pdfGlyphSamples.cyrillic}`;
    fixture.task.quoteDealNumber = fixture.quoteNumber;
    fixture.quotation.items[0]!.description = Object.values(pdfGlyphSamples).join("\n");
    fixture.totals = calculateQuotation(fixture.quotation, "percentage");
    const parsed = await inspect((await renderQuotationPdf(fixture)).bytes);
    for (const [index, expected] of labels.entries()) assert.ok(parsed.text.includes(expected), `supported sample ${Object.keys(pdfGlyphSamples)[index]} is preserved without replacement glyphs`);
    assert.ok(!parsed.text.includes("\uFFFD"));
    assert.ok(parsed.text.split(pdfGlyphSamples.greek).length >= 3, "Greek sample occurs in the bold reference and regular description");
    assert.ok(parsed.text.split(pdfGlyphSamples.cyrillic).length >= 3, "Cyrillic sample occurs in both font faces");
  });

  test(`${company}: unsupported scripts and directional controls fail safely in headers and item text`, async () => {
    for (const value of Object.values(unsupportedPdfGlyphSamples)) {
      const header = quotationPdfFixture(company); header.task.accountName = value;
      await assert.rejects(renderQuotationPdf(header), (error) => error instanceof QuotationPdfError && error.status === 409);
      const line = quotationPdfFixture(company); line.quotation.items[0]!.description = value;
      line.totals = calculateQuotation(line.quotation, "percentage");
      await assert.rejects(renderQuotationPdf(line), (error) => error instanceof QuotationPdfError && error.status === 409);
    }
  });
}
test("amount in words uses decimal carry and negative values without floating-point drift", () => {
  assert.equal(amountInWords("0.00"), "DIRHAMS ZERO ONLY");
  assert.equal(amountInWords("1001.01"), "DIRHAMS ONE THOUSAND AND ONE POINT ONE FILS ONLY");
  assert.equal(amountInWords("-0.50"), "NEGATIVE DIRHAMS ZERO POINT FIFTY FILS ONLY");
  assert.equal(amountInWords("1000000000000000001.99"), "DIRHAMS ONE QUINTILLION AND ONE POINT NINETY-NINE FILS ONLY");
});
test("renderer rejects oversized quotations instead of silently truncating", async () => {
  const fixture = quotationPdfFixture(); fixture.quotation.items = Array.from({ length: 30 }, () => ({ ...fixture.quotation.items[0]!, description: "A".repeat(10_000) }));
  fixture.totals = calculateQuotation(fixture.quotation, "percentage"); fixture.subtotal = fixture.totals.subtotal; fixture.grandTotal = fixture.totals.grandTotal;
  await assert.rejects(renderQuotationPdf(fixture), (error) => error instanceof QuotationPdfError && error.status === 413);
});
test("download authorizes before rendering and rechecks revocation and changed snapshots", async () => {
  let rendered = false;
  const denied = new Error("Access denied");
  const service = createQuotationPdfService({ getQuotation() { throw denied; } }, async () => { rendered = true; return { bytes: Buffer.from("x"), filename: "x", pages: 1 }; });
  await assert.rejects(service.download("token", "1"), (error) => error === denied); assert.equal(rendered, false);
  let reads = 0;
  const revoked = createQuotationPdfService({ getQuotation() { if (++reads > 1) throw denied; return quotationPdfFixture(); } }, async () => ({ bytes: Buffer.from("x"), filename: "x", pages: 1 }));
  await assert.rejects(revoked.download("token", "1"), (error) => error === denied);
  reads = 0;
  const changed = createQuotationPdfService({ getQuotation() { const value = quotationPdfFixture(); value.version += reads++; return value; } }, async () => ({ bytes: Buffer.from("x"), filename: "x", pages: 1 }));
  await assert.rejects(changed.download("token", "1"), (error) => error instanceof QuotationPdfError && error.status === 409);
});
test("explicit local issuer and owner provenance render without creating a remote salesperson identity", async () => {
  const fixture = quotationPdfFixture();
  fixture.id = "local-1"; fixture.persistence = "local-demo"; fixture.localOwnerId = "15";
  fixture.externalId = null; fixture.remoteModifiedAt = null; fixture.quoteNumber = "LOCAL-QUOTE-1";
  fixture.task.assignedExternalId = null; fixture.task.assignedLocalId = "15"; fixture.task.assignedSaleName = "nishad";
  const parsed = await inspect((await renderQuotationPdf(fixture)).bytes);
  assert.match(parsed.text, /Sales Person: nishad/); assert.match(parsed.text, /LOCAL-QUOTE-1/);
  assert.match(parsed.text, /Grand Total:\s+AED 224\.16/);
  for (const mutate of [
    (value: QuotationDetail) => { value.task.assignedLocalId = "16"; },
    (value: QuotationDetail) => { delete value.localOwnerId; },
    (value: QuotationDetail) => { value.externalId = "90011"; },
    (value: QuotationDetail) => { value.task.assignedExternalId = "90000"; },
    (value: QuotationDetail) => { value.id = "1"; },
  ]) {
    const invalid = structuredClone(fixture); mutate(invalid);
    await assert.rejects(renderQuotationPdf(invalid), error => error instanceof QuotationPdfError && error.status === 409 && /provenance/.test(error.message));
  }
  const missingCompany = structuredClone(fixture); missingCompany.task.assignedCompany = null;
  await assert.rejects(renderQuotationPdf(missingCompany), /issuing company/);
  const missingSeller = structuredClone(fixture); missingSeller.task.assignedSaleName = null;
  await assert.rejects(renderQuotationPdf(missingSeller), /salesperson display name/);
  const missingCustomer = structuredClone(fixture); missingCustomer.task.accountName = null;
  await assert.rejects(renderQuotationPdf(missingCustomer), /customer company.*Correct/);
  const missingNumber = structuredClone(fixture); missingNumber.quoteNumber = "";
  await assert.rejects(renderQuotationPdf(missingNumber), /quotation number.*Correct/);
  const invalidDate = structuredClone(fixture); invalidDate.updatedAt = "invalid";
  await assert.rejects(renderQuotationPdf(invalidDate), /quotation date.*Correct/);
  const missingReference = structuredClone(fixture); missingReference.task.assignedCompany = "VOLTRONIX SWITCHGEAR LLC"; missingReference.task.quoteDealNumber = null;
  await assert.rejects(renderQuotationPdf(missingReference), /quotation reference.*Correct/);
});
test("historical PDF identity requirements never fall back to local owner fields", async () => {
  const historical = quotationPdfFixture();
  historical.task.assignedExternalId = null; historical.task.assignedLocalId = "15"; historical.localOwnerId = "15";
  await assert.rejects(renderQuotationPdf(historical), error => error instanceof QuotationPdfError && error.status === 409);
  const unmarked = quotationPdfFixture(); unmarked.externalId = null; unmarked.remoteModifiedAt = null;
  unmarked.task.assignedExternalId = null; unmarked.task.assignedLocalId = "15";
  await assert.rejects(renderQuotationPdf(unmarked), error => error instanceof QuotationPdfError && error.status === 409);
  const preserved = quotationPdfFixture();
  const parsed = await inspect((await renderQuotationPdf(preserved)).bytes);
  assert.match(parsed.text, /Synthetic sales agent/); assert.doesNotMatch(parsed.text, /nishad/);
});
test("blank attention renders only for proven local quotes without a fabricated contact", async () => {
  const fixture = quotationPdfFixture();
  fixture.id = "local-1"; fixture.persistence = "local-demo"; fixture.localOwnerId = "15";
  fixture.externalId = null; fixture.remoteModifiedAt = null; fixture.quoteNumber = "LOCAL-QUOTE-1";
  fixture.task.assignedExternalId = null; fixture.task.assignedLocalId = "15";
  fixture.quotation.kindAttention = ""; fixture.totals = calculateLocalQuotation(fixture.quotation);
  const parsed = await inspect((await renderQuotationPdf(fixture)).bytes);
  assert.match(parsed.text, /Attn: Not recorded/); assert.doesNotMatch(parsed.text, /Default Last Name/);
  assert.match(parsed.text, /Grand Total:\s+AED 224\.16/);
  const invalidOwner = structuredClone(fixture); invalidOwner.task.assignedLocalId = "16";
  await assert.rejects(renderQuotationPdf(invalidOwner), error => error instanceof QuotationPdfError && error.status === 409);
  const remote = quotationPdfFixture(); remote.quotation.kindAttention = "";
  await assert.rejects(renderQuotationPdf(remote), error => error instanceof QuotationPdfError && error.status === 409);
});
test("copied brand and font assets remain byte-identical to preserved PHP source", () => {
  for (const [folder, name] of [["photos/logo", "databg.png"], ["photos/logo", "switchgear_bg4.png"], ["photos/logo", "sign.jpg"], ["photos/logo", "stamp.jpg"], ["fonts", "Roboto-Regular.ttf"], ["fonts", "Roboto-Bold.ttf"]]) {
    const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    assert.equal(hash(join(process.cwd(), "assets/quotation-pdf", name!)), hash(join(process.cwd(), "../assets", folder!, name!)));
  }
});

import type { QuotationDetail } from "../src/crm/commercial/persistence-contracts.js";
import { quotationPdfFixture } from "./helpers/quotation-pdf-fixture.js";

/** Synthetic coverage samples, never imported as customer or product data. */
export const pdfGlyphSamples = {
  latin: "Caf\u00e9 Soci\u00e9t\u00e9 \u2014 \u0141\u00f3d\u017a",
  greek: "\u0395\u03bb\u03bb\u03b7\u03bd\u03b9\u03ba\u03ac \u03a9\u03bc\u03ad\u03b3\u03b1",
  cyrillic: "\u041a\u0430\u0431\u0435\u043b\u044c \u041c\u043e\u0441\u043a\u0432\u0430",
  engineering: "230 V \u00b1 5% / 50 Hz / 25 \u00b0C / 10 mm\u00b2 / 2 \u00d7 4 / \u03a9 \u00b5 \u03bc / \u20ac \u00a3 \u20b9",
  decomposed: "Cafe\u0301",
} as const;

export const unsupportedPdfGlyphSamples = {
  arabic: "\u0645\u0631\u062d\u0628\u0627",
  hebrew: "\u05e9\u05dc\u05d5\u05dd",
  devanagari: "\u0928\u092e\u0938\u094d\u0924\u0947",
  chinese: "\u4f60\u597d",
  emoji: "\ud83d\ude42",
  directionOverride: "test\u202Ehidden",
  directionIsolate: "test\u2066hidden\u2069",
  zeroWidthJoiner: "test\u200Dhidden",
} as const;


test("repeated Switchgear headers refuse oversized metadata without recursive pages or lost values", async () => {
  const fixture = quotationPdfFixture("VOLTRONIX SWITCHGEAR LLC");
  fixture.task.address = Array.from({ length: 80 }, (_, index) => `Preserved long address line ${index}`).join("\n");
  const before = JSON.stringify(fixture);
  await assert.rejects(renderQuotationPdf(fixture), error => error instanceof QuotationPdfError && error.status === 413 && /header/.test(error.message));
  assert.equal(JSON.stringify(fixture), before);
});

test("copied Switchgear font and license bytes match the preserved PHP mPDF distribution", () => {
  for (const name of ["DejaVuSansCondensed.ttf", "DejaVuSansCondensed-Bold.ttf", "DejaVuinfo.txt"]) {
    const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    assert.equal(digest(join(process.cwd(), "assets/quotation-pdf", name)), digest(preservedPath(join(process.cwd(), ".."), `vendor/mpdf/mpdf/ttfonts/${name}`)));
  }
});
