import PDFDocument from "pdfkit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { QuotationDetail } from "../commercial/persistence-contracts";
import { calculateQuotation, parseQuotationInput } from "../commercial/quotations";
import { decimal, exact, money } from "../commercial/decimal";
import coverage from "./font-coverage.json";

export class QuotationPdfError extends Error {
  constructor(readonly status: number, message = "The quotation cannot be rendered from the available verified information.") { super(message); }
}
const companies = ["VOLTRONIX CONTRACTING LLC", "VOLTRONIX SWITCHGEAR LLC"] as const;
const supported = new Set(coverage);
const maxCharacters = 250_000;
const maxPages = 100;
const maxBytes = 16 * 1024 * 1024;
// This test/demo-only renderer is imported from both root and server commands.
const assetRoot = fileURLToPath(new URL("../../../resources/quotation-pdf/", import.meta.url));
const asset = (name: string) => readFileSync(join(assetRoot, name));
const zero = (value: string) => decimal(value).coefficient === 0n;

function printable(value: string) {
  const normalized = value.normalize("NFC").replaceAll("\r\n", "\n").replaceAll("\t", "    ");
  for (const character of normalized) {
    const point = character.codePointAt(0)!;
    if (character === "\n") continue;
    if (point < 32 || point === 127 || /[\u200B-\u200F\u202A-\u202E\u2060-\u206F]/u.test(character) || !supported.has(point)) {
      throw new QuotationPdfError(409, "The quotation contains text unsupported by the available PDF fonts.");
    }
  }
  return normalized;
}
function required(value: string | null | undefined) {
  if (typeof value !== "string" || !value.trim()) throw new QuotationPdfError(409);
  return printable(value);
}
function safeDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) throw new QuotationPdfError(409);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== value.slice(0, 19)) throw new QuotationPdfError(409);
  return date;
}
function dateLabel(date: Date, contracting: boolean, time = false) {
  const parts = new Intl.DateTimeFormat(contracting ? "en-US" : "en-GB", {
    timeZone: "Asia/Dubai", day: "2-digit", month: contracting ? "short" : "2-digit", year: "numeric",
    ...(time ? { hour: "2-digit", minute: "2-digit", hour12: true } : {}),
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)!.value;
  // Preserve PHP M j, Y h:i A / d-m-Y presentation, with the established Dubai timezone.
  if (!contracting) return `${value("day")}-${value("month")}-${value("year")}`;
  return `${value("month")} ${Number(value("day"))}, ${value("year")}${time ? ` ${value("hour")}:${value("minute")} ${value("dayPeriod")}` : ""}`;
}

const small = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
function integerWords(value: bigint): string {
  if (value < 20n) return small[Number(value)]!;
  if (value < 100n) return `${tens[Number(value / 10n)]}${value % 10n ? `-${small[Number(value % 10n)]}` : ""}`;
  const units: [bigint, string][] = [[10n ** 18n, "quintillion"], [10n ** 15n, "quadrillion"], [10n ** 12n, "trillion"], [10n ** 9n, "billion"], [10n ** 6n, "million"], [1000n, "thousand"], [100n, "hundred"]];
  const [base, word] = units.find(([base]) => value >= base)!;
  const remainder = value % base;
  return `${integerWords(value / base)} ${word}${remainder ? `${remainder < 100n ? " and " : ", "}${integerWords(remainder)}` : ""}`;
}
/** Source numbertowords_helper wording, using rounded decimal strings instead of floating point. */
export function amountInWords(amount: string) {
  if (!/^-?\d+\.\d{2}$/.test(amount)) throw new QuotationPdfError(409);
  const negative = amount.startsWith("-");
  const [integer, fraction] = (negative ? amount.slice(1) : amount).split(".");
  return `${negative ? "NEGATIVE " : ""}DIRHAMS ${integerWords(BigInt(integer!))}${BigInt(fraction!) ? ` point ${integerWords(BigInt(fraction!))} FILS` : ""} ONLY`.toUpperCase();
}

export async function renderQuotationPdf(detail: QuotationDetail): Promise<{ bytes: Buffer; filename: string; pages: number }> {
  // Only the explicit new-record calculation policy is certified; inferred historical
  // task rows and contradictory legacy template arithmetic cannot become a PDF.
  if (detail.calculationPolicy !== "percentage-create-v1") throw new QuotationPdfError(409);
  let quote: ReturnType<typeof parseQuotationInput>;
  try { quote = parseQuotationInput(detail.quotation); } catch { throw new QuotationPdfError(409); }
  const expected = calculateQuotation(quote, "percentage");
  if (JSON.stringify(detail.totals) !== JSON.stringify(expected) || detail.subtotal !== expected.subtotal || detail.grandTotal !== expected.grandTotal) throw new QuotationPdfError(409);
  const company = required(detail.task.assignedCompany);
  if (!(companies as readonly string[]).includes(company)) throw new QuotationPdfError(409);
  const contracting = company === companies[0];
  const salesPerson = required(detail.task.assignedSaleName);
  required(detail.task.assignedExternalId);
  const customer = required(detail.task.accountName);
  const quoteNumber = required(detail.quoteNumber);
  const reference = contracting ? quoteNumber : required(detail.task.quoteDealNumber);
  const updated = safeDate(detail.updatedAt), created = safeDate(detail.createdAt);
  const content = [quote.subject, quote.kindAttention, quote.project, quote.termsOfPayment, quote.specification,
    quote.generalExclusion, quote.brand, quote.warranty, quote.delivery, quote.notes,
    company, salesPerson, customer, reference, quoteNumber, detail.task.address, detail.task.customerEmail,
    detail.task.customerContact, detail.task.pBox, detail.task.trn,
    ...quote.items.flatMap((item) => [item.productName, item.description, item.uom])].filter((value): value is string => value !== null);
  if (content.reduce((sum, value) => sum + value.length, 0) > maxCharacters) throw new QuotationPdfError(413, "The quotation is too large to render as a PDF.");
  content.forEach(printable);
  // Bundled mPDF maps Arial and unregistered Roboto/sans-serif to DejaVu Sans Condensed. Keep the
  // existing Roboto profile for the few accepted glyphs absent in that face.
  const sourceFontGaps = new Set([2, 8380, 60929, 60930, 63171, 65535]);
  const originalSourceFont = content.every(value => [...printable(value)].every(character => !sourceFontGaps.has(character.codePointAt(0)!)));
  const regularName = originalSourceFont ? "DejaVuSansCondensed.ttf" : "Roboto-Regular.ttf";
  const boldName = originalSourceFont ? "DejaVuSansCondensed-Bold.ttf" : "Roboto-Bold.ttf";
  const regular = asset(regularName), bold = asset(boldName);
  const background = asset(contracting ? "databg.png" : "switchgear_bg4.png");
  const signature = contracting ? asset("sign.jpg") : null;
  const stamp = contracting ? asset("stamp.jpg") : null;
  const width = contracting ? 595.28 : 215 * 72 / 25.4;
  const height = contracting ? 841.89 : 280 * 72 / 25.4;
  const left = 24, right = width - 24, bodyWidth = right - left;
  const top = contracting ? 105 : 124, bottom = contracting ? height - 66 : 550;
  const doc = new PDFDocument({ autoFirstPage: false, bufferPages: true, size: [width, height], margin: 0,
    font: join(assetRoot, regularName), pdfVersion: "1.7", info: { Title: `Quotation - ${quoteNumber} - ${company}`,
      Author: company, Subject: quote.subject, Creator: "Voltronix CRM", CreationDate: created, ModDate: updated } });
  doc.registerFont("Regular", regular).registerFont("Bold", bold);
  const chunks: Buffer[] = [];
  let bytes = 0;
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { doc.destroy(new QuotationPdfError(413, "The quotation is too large to render as a PDF.")); return; }
      chunks.push(chunk);
    });
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  let y = top, pages = 0;
  const font = (bold = false, size = 9) => doc.font(bold ? "Bold" : "Regular").fontSize(size).fillColor("#000000");
  function lines(value: string, availableWidth: number, bold = false, size = 9) {
    doc.font(bold ? "Bold" : "Regular").fontSize(size);
    const result: string[] = [];
    for (const paragraph of printable(value).split("\n")) {
      let line = "";
      for (const word of paragraph.split(/ +/)) {
        const candidate = line ? `${line} ${word}` : word;
        if (doc.widthOfString(candidate) <= availableWidth) { line = candidate; continue; }
        if (line) { result.push(line); line = ""; }
        // Long unbroken descriptions/identifiers are split by actual glyph width.
        for (const character of word) {
          if (line && doc.widthOfString(line + character) > availableWidth) { result.push(line); line = ""; }
          line += character;
        }
      }
      result.push(line);
    }
    return result;
  }
  function newPage() {
    if (++pages > maxPages) throw new QuotationPdfError(413, "The quotation is too large to render as a PDF.");
    doc.addPage();
    doc.image(background, 0, 0, { width, height });
    // Source CSS sizes are pixels; PDF coordinates use points (72 / 96).
    font(true, contracting ? 17.25 : 16.5).text(contracting ? "QUOTATION" : "SALES QUOTATION", left, top, { width: bodyWidth, lineBreak: false, align: "center" });
    y = top + 27;
    if (contracting && pages > 1) for (const line of lines(`Quote Ref: ${reference} (continued)`, bodyWidth, false, 8)) {
      font(false, 8).text(line, left, y, { lineBreak: false }); y += 11;
    }
    y += 6;
    if (!contracting) switchgearHeader();
  }
  function space(needed: number) { if (y + needed > bottom) newPage(); }
  function block(value: string, bold = false, size = 9, gap = 5) {
    for (const line of lines(value, bodyWidth, bold, size)) {
      space(size + 4); font(bold, size).text(line, left, y, { lineBreak: false }); y += size + 4;
    }
    y += gap;
  }
  const field = (label: string, value: string | null) => `${label}: ${value === null || value === "" ? "Not recorded" : value}`;
  // Preserve the original column proportions, normalized because the source
  // percentages total 102 / 101. No financial value is derived from layout.
  const ratios = contracting ? [7, 45, 10, 10, 15, 15] : [5, 44, 12, 11, 6, 7, 16];
  const ratioTotal = ratios.reduce((sum, value) => sum + value, 0);
  const columnWidths = ratios.map(value => bodyWidth * value / ratioTotal);
  type Align = "left" | "center" | "right";
  function grid(values: string[], widths: number[], options: {
    x?: number; heading?: boolean; itemTable?: boolean; border?: boolean; bold?: boolean; size?: number; align?: Align[]; emphasis?: Record<number, string>;
  } = {}) {
    const { heading = false, itemTable = false, border = false, bold = heading && contracting, size = 8.25 } = options;
    const padding = 3, lineHeight = size + 3;
    const wrapped = values.map((value, index) => {
      const prefix = options.emphasis?.[index], available = widths[index]! - padding * 2;
      if (prefix === undefined) return lines(value, available, bold, size).map(text => ({ text, bold }));
      const remainder = value.slice(prefix.length).replace(/^\n/, "");
      return [...lines(prefix, available, true, size).map(text => ({ text, bold: true })),
        ...(remainder ? lines(remainder, available, false, size).map(text => ({ text, bold: false })) : [])];
    });
    let offset = 0;
    const count = Math.max(...wrapped.map((value) => value.length));
    if (itemTable && !heading) {
      const fullRowHeight = count * lineHeight + padding * 2;
      const continuationTop = contracting
        ? top + 33 + lines(`Quote Ref: ${reference} (continued)`, bodyWidth, false, 8).length * 11
        : top + 33 + switchgearHeaderHeight;
      const headerHeight = Math.max(...tableHeaders.map((value, index) => lines(value, columnWidths[index]! - padding * 2, contracting, 8.25).length)) * 11.25 + padding * 2;
      // PHP asks rows to avoid page breaks. Split only a row too tall for a fresh body.
      if (y + fullRowHeight > bottom && fullRowHeight <= bottom - continuationTop - headerHeight) { newPage(); tableHeading(); }
    }
    while (offset < count) {
      if (y + lineHeight + padding * 2 > bottom) { newPage(); if (itemTable && !heading) tableHeading(); }
      const take = Math.min(count - offset, Math.max(1, Math.floor((bottom - y - padding * 2) / lineHeight)));
      const rowHeight = take * lineHeight + padding * 2;
      let x = options.x ?? left;
      wrapped.forEach((value, index) => {
        const cellWidth = widths[index]!;
        if (border) doc.save().lineWidth(contracting ? 0.75 : 0.225).rect(x, y, cellWidth, rowHeight)
          .fillAndStroke(heading && contracting ? "#EE473F" : "#FFFFFF", contracting ? "#E3DFCB" : "#000000").restore();
        font(bold, size);
        if (heading && contracting) doc.fillColor("#FFFFFF");
        for (let line = 0; line < take; line++) {
          const segment = value[offset + line];
          if (segment !== undefined) {
            const text = segment.text; font(segment.bold, size);
            if (heading && contracting) doc.fillColor("#FFFFFF");
            const align = options.align?.[index] ?? "left";
            const textWidth = doc.widthOfString(text);
            const textX = align === "right" ? x + cellWidth - padding - textWidth : align === "center" ? x + (cellWidth - textWidth) / 2 : x + padding;
            doc.text(text, textX, y + padding + line * lineHeight, { lineBreak: false });
          }
        }
        x += cellWidth;
      });
      y += rowHeight; offset += take;
    }
  }
  const tableHeaders = contracting ? ["S.No", "Item & Description", "Qty.", "U.O.M", "Unit Price", "Amount"]
    : ["S.No.", "Description", "Quantity", "Rate", "Tax%", "Disc.%", "Amount"];
  function tableHeading() {
    grid(tableHeaders, columnWidths,
    { heading: true, itemTable: true, border: true, align: columnWidths.map(() => "center") });
  }
  function total(label: string, value: string, bold = false) {
    const amountWidth = contracting ? bodyWidth * 0.2 : columnWidths.at(-1)!;
    const totalWidth = contracting ? bodyWidth * 0.4 : bodyWidth;
    grid([`${label}:`, `AED ${value}`], [totalWidth - amountWidth, amountWidth],
      { x: right - totalWidth, border: !contracting, bold, size: bold ? 9.75 : 9, align: ["right", "right"] });
  }
  const validUntil = quote.validUntil ? dateLabel(new Date(`${quote.validUntil}T00:00:00Z`), contracting) : null;
  const switchgearRows = [
    { values: [field("To", quote.kindAttention), field("Quote Ref", reference), field("Date", dateLabel(updated, false))], widths: [bodyWidth * 0.5, bodyWidth * 0.25, bodyWidth * 0.25] },
    { values: [field("Customer", customer), field("Validity", validUntil), field("Currency", "AED")], widths: [bodyWidth * 0.5, bodyWidth * 0.25, bodyWidth * 0.25] },
    { values: [field("Address", detail.task.address), field("Payment", quote.termsOfPayment), field("Sales By", salesPerson)], widths: [bodyWidth * 0.5, bodyWidth * 0.25, bodyWidth * 0.25] },
    { values: [[field("P.O Box", detail.task.pBox), field("TEL", detail.task.customerContact)].join("\n"), [field("TRN", detail.task.trn), field("Email", detail.task.customerEmail)].join("\n"), field("Company TRN", "104900827700003"), field("Delivery Terms", quote.delivery)], widths: [bodyWidth * 0.2, bodyWidth * 0.3, bodyWidth * 0.25, bodyWidth * 0.25] },
  ];
  const switchgearHeaderHeight = contracting ? 0 : switchgearRows.reduce((total, row) => total + Math.max(...row.values.map((value, index) => lines(value, row.widths[index]! - 6, false, 8.25).length)) * 11.25 + 6, 0);
  function switchgearHeader() {
    // Source $header repeats the complete customer grid on each page. Measure
    // once so a very large header cannot recursively create blank pages.
    if (switchgearHeaderHeight + 45 > bottom - top - 33) throw new QuotationPdfError(413, "The quotation header is too large to repeat safely on a PDF page.");
    for (const row of switchgearRows) grid(row.values, row.widths, { border: true });
  }
  try {
    newPage();
    if (contracting) {
      const widths = [bodyWidth / 2, bodyWidth / 2];
      for (const row of [
        [field("Attn", quote.kindAttention), field("Quote Ref", reference)],
        [field("Company", customer), field("Date", dateLabel(updated, true, true))],
        [field("Subject", quote.subject), field("Valid Till", validUntil)],
        [field("Project", quote.project), field("Sales Person", salesPerson)],
      ]) grid(row, widths, { bold: true, align: ["left", "right"] });
      doc.save().strokeColor("#D9D9D9").lineWidth(1.5).dash(1.5, { space: 2 }).moveTo(left, y + 4).lineTo(right, y + 4).stroke().restore();
      y += 14;
      block("We thank you for inviting us to quote for the subject and are pleased to submit our proposal in the following:");
      block("1. SCOPE OF WORK", true);
    }
    space(45); tableHeading();
    quote.items.forEach((item, index) => {
      let description = `${item.productName}${item.description ? `\n${item.description}` : ""}`;
      // The source contracting table has no discount column. Retain certified
      // nonzero line discounts visibly without copying its conflicting arithmetic.
      if (contracting && !zero(item.itemDiscount)) description += `\nLine discount: ${exact(decimal(item.itemDiscount))}%`;
      const values = contracting
        ? [String(index + 1), description, exact(decimal(item.quantity)), item.uom, `AED ${money(decimal(item.unitPrice))}`, `AED ${expected.lineTotals[index]!}`]
        : [String(index + 1), description, `${exact(decimal(item.quantity))} ${item.uom}`, money(decimal(item.unitPrice)), "5%", exact(decimal(item.itemDiscount)), expected.lineTotals[index]!];
      grid(values, columnWidths, { itemTable: true, border: true, emphasis: { 1: item.productName },
        align: contracting ? ["center", "left", "center", "center", "right", "right"] : ["center", "left", "center", "right", "center", "center", "right"] });
    });
    if (contracting) y += 12;
    space(110);
    total(contracting ? "Sub Total" : "Total Amount", expected.subtotal);
    if (!zero(quote.discount)) total("Discount (saved amount)", money(decimal(quote.discount)));
    total("VAT (5%)", expected.vatAmount);
    if (!zero(quote.adjustment)) total("Adjustment", money(decimal(quote.adjustment)));
    total("Grand Total", expected.grandTotal, true);
    if (contracting) y += 12;
    if (contracting) {
      const heightOfBlock = (value: string, bold = false, gap = 5) => lines(value, bodyWidth, bold, 9).length * 13 + gap;
      const signatureHeight = heightOfBlock("Yours faithfully,") + heightOfBlock(`For ${company},`, true) + 100
        + heightOfBlock("Marieswaran\nManaging Partner\nMobile: 0502420957", true, 0);
      const closingHeight = heightOfBlock("2. PAYMENT TERMS", true) + heightOfBlock(quote.termsOfPayment || "Not recorded")
        + heightOfBlock(`3. PRICE: AED ${expected.grandTotal} (Including VAT)`, true) + heightOfBlock("4. GENERAL EXCLUSIONS", true)
        + heightOfBlock(quote.generalExclusion || "No exclusions specified.")
        + heightOfBlock("We trust the above offer is in line with your requirements and look forward to receiving your valued order.") + signatureHeight;
      const continuationTop = top + 33 + lines(`Quote Ref: ${reference} (continued)`, bodyWidth, false, 8).length * 11;
      // The source no-break-section includes terms through the signatory. Oversized terms still flow safely.
      if (closingHeight <= bottom - continuationTop) space(closingHeight);
      block("2. PAYMENT TERMS", true); block(quote.termsOfPayment || "Not recorded");
      block(`3. PRICE: AED ${expected.grandTotal} (Including VAT)`, true);
      block("4. GENERAL EXCLUSIONS", true); block(quote.generalExclusion || "No exclusions specified.");
      block("We trust the above offer is in line with your requirements and look forward to receiving your valued order.");
      space(signatureHeight); block("Yours faithfully,"); block(`For ${company},`, true);
      if (signature && stamp) { doc.image(signature, left, y, { fit: [75, 75] }); doc.image(stamp, left + 120, y, { fit: [97.5, 97.5] }); }
      y += 100;
      block("Marieswaran\nManaging Partner\nMobile: 0502420957", true, 9, 0);
    } else {
      const amountWidth = columnWidths.at(-1)!;
      grid([amountInWords(expected.grandTotal), "E. & O.E."], [bodyWidth - amountWidth, amountWidth], { border: true, bold: true, align: ["left", "right"] });
      grid(["Amount (In words)", ""], [bodyWidth - amountWidth, amountWidth], { border: true });
      const widths = [bodyWidth * 0.25, bodyWidth * 0.3, bodyWidth * 0.45];
      grid([quote.notes ? field("Note if any", quote.notes) : "", field("Warranty", quote.warranty), `For ${company}`], widths, { border: true, align: ["left", "left", "right"] });
      grid([field("Specification", quote.specification), "", ""], widths, { border: true });
      grid(["", "Received By:", "Authorized Signatory"], widths, { border: true, align: ["left", "left", "right"] });
    }
    for (let page = 0; page < pages; page++) {
      doc.switchToPage(page); font(false, 8).text(`Page ${page + 1} of ${pages}`, left, bottom + 12, { width: bodyWidth, align: "center", lineBreak: false });
    }
    doc.end();
    const bytes = await finished;
    return { bytes, filename: `quotation_${quoteNumber.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100)}.pdf`, pages };
  } catch (error) {
    doc.destroy(); void finished.catch(() => undefined);
    throw error;
  }
}
