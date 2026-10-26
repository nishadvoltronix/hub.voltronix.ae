import { strToU8, zipSync } from "fflate";

export const JOB_EXPORT_COLUMNS = ["Created At", "Job Deal Number", "Job Deal Date", "Account Name", "Status",
  "Electrical Status", "Civil Status", "PM Status", "Accounts Status", "Service Charge"] as const;
export const MAX_EXPORT_ROWS = 10_000;
export const MAX_EXPORT_XML_BYTES = 16 * 1024 * 1024;
export class ExportLimitError extends Error {}

function xmlText(value: string) {
  if (value.length > 32_767) throw new ExportLimitError("Export cell limit exceeded.");
  // Preserve literal OOXML escape-like text. Invalid XML characters are represented
  // by OOXML escapes, never interpolated as markup or silently dropped.
  const escaped = value.replace(/_x[0-9a-fA-F]{4}_/g, (match) => `_x005F_${match.slice(1)}`);
  let safe = "";
  for (const character of escaped) {
    const point = character.codePointAt(0)!;
    if ((point < 32 && point !== 9 && point !== 10 && point !== 13) || (point >= 0xd800 && point <= 0xdfff) || point === 0xfffe || point === 0xffff) {
      safe += `_x${point.toString(16).toUpperCase().padStart(4, "0")}_`;
    } else safe += character;
  }
  return safe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;").replace(/\r/g, "&#13;");
}

/** Fixed, single-sheet OOXML workbook. No formulas, hyperlinks, external relationships or file paths. */
export function buildJobsWorkbook(rows: ReadonlyArray<ReadonlyArray<string | null>>): Uint8Array {
  if (rows.length > MAX_EXPORT_ROWS || rows.some((row) => row.length !== JOB_EXPORT_COLUMNS.length)) throw new ExportLimitError("Export row limit exceeded.");
  const worksheetParts: string[] = [];
  let xmlBytes = 0;
  [JOB_EXPORT_COLUMNS, ...rows].forEach((row, rowIndex) => {
    const cells = row.map((value, index) => `<c r="${String.fromCharCode(65 + index)}${rowIndex + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value ?? "")}</t></is></c>`).join("");
    const xml = `<row r="${rowIndex + 1}">${cells}</row>`;
    xmlBytes += Buffer.byteLength(xml, "utf8");
    if (xmlBytes > MAX_EXPORT_XML_BYTES) throw new ExportLimitError("Export byte limit exceeded.");
    worksheetParts.push(xml);
  });
  const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`${declaration}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`),
    "_rels/.rels": strToU8(`${declaration}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`${declaration}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Jobs" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`${declaration}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(`${declaration}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:J${rows.length + 1}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="10" width="24" customWidth="1"/></cols><sheetData>${worksheetParts.join("")}</sheetData><autoFilter ref="A1:J${rows.length + 1}"/></worksheet>`),
  };
  return zipSync(files, { level: 6, mtime: new Date("2026-01-01T00:00:00Z") });
}
