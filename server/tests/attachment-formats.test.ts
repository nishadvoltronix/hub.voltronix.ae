import assert from "node:assert/strict";
import test from "node:test";
import { validateContent, AttachmentError } from "../src/crm/attachments/service.js";
import { webp, bmp, compoundOffice, officeZip, rar4, sevenZip } from "./helpers/attachment-format-fixtures.js";
import { hasSpreadsheetFormula } from "../src/crm/attachments/csv.js";
test("OFFLINE backend binary upload validation accepts source containers and rejects malformed/active Office data", () => {
  for (const [name, bytes] of [["fixture.doc", compoundOffice("doc")], ["fixture.xls", compoundOffice("xls", true)], ["fixture.ppt", compoundOffice("ppt")], ["fixture.docx", officeZip("docx")], ["fixture.xlsx", officeZip("xlsx")], ["fixture.pptx", officeZip("pptx")], ["fixture.rar", rar4()], ["fixture.7z", sevenZip()], ["fixture.bmp", bmp()], ["fixture.webp", webp()]] as const) {
    const original = Buffer.from(bytes); assert.ok(validateContent(name, "application/octet-stream", bytes)); assert.deepEqual(bytes, original);
    assert.throws(() => validateContent(name, "application/octet-stream", bytes.subarray(0, bytes.length - 1)), error => error instanceof AttachmentError && error.status === 415);
  }
  assert.throws(() => validateContent("active.docx", "application/octet-stream", officeZip("docx", { "word/vbaProject.bin": Buffer.from("rejected") })), error => error instanceof AttachmentError && error.status === 415);
  for (const target of ["External", "&#69;xternal", "&#x45;xternal"]) assert.throws(() => validateContent("external.docx", "application/octet-stream", officeZip("docx", { "word/_rels/document.xml.rels": Buffer.from(`<Relationship TargetMode="${target}" Target="https://invalid/"/>`) })), error => error instanceof AttachmentError && error.status === 415);
  for (const xml of [Buffer.from('<?xml version="1.0" encoding="UTF-16LE"?><Relationships><Relationship TargetMode="External" Target="https://invalid/"/></Relationships>', "utf16le"), Buffer.from('<?xml version="1.0" encoding="UTF-7"?><Relationships/>')]) assert.throws(() => validateContent("encoding.docx", "application/octet-stream", officeZip("docx", { "word/_rels/document.xml.rels": xml })), error => error instanceof AttachmentError && error.status === 415);
});
test("OFFLINE CSV linear scanner matches the previous conservative policy on bounded combinations", () => {
  const previous = /(?:^|[,;\t\r\n])\s*"?\s*[=+@-]/;
  const parts = [" ", "\t", "\r\n", "\u00a0", "\u2003", '"', ",", ";", "=", "+", "-", "@", "A"];
  for (const a of parts) for (const b of parts) for (const c of parts) assert.equal(hasSpreadsheetFormula(a + b + c), previous.test(a + b + c), JSON.stringify(a + b + c));
});
