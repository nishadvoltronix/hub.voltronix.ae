import assert from "node:assert/strict";
import test from "node:test";
import { crc32 } from "node:zlib";
import { zipSync } from "fflate";
import { validateContent as retained, AttachmentError } from "../src/server/attachments/service";
import { validateContent as sqlite, AttachmentError as SqliteAttachmentError } from "./sqlite-reference/attachments/service";
import { webp, bmp, compoundOffice, officeZip, rar4, sevenZip } from "./helpers/attachment-format-fixtures";
import { LARGE_LOG_ATTACHMENT_LIMIT, TASK_ATTACHMENT_LIMIT } from "@voltronix/crm-contracts";

for (const [runtime, validate, ErrorType] of [["retained", retained, AttachmentError], ["SQLite", sqlite, SqliteAttachmentError]] as const) {
  test(`${runtime} source task Office/archive/BMP types accept bounded containers and retain exact bytes`, () => {
    for (const [name, bytes] of [["fixture.doc", compoundOffice("doc")], ["fixture.xls", compoundOffice("xls", true)], ["fixture.ppt", compoundOffice("ppt")], ["fixture.docx", officeZip("docx")], ["fixture.xlsx", officeZip("xlsx")], ["fixture.pptx", officeZip("pptx")], ["fixture.zip", Buffer.from(zipSync({ "notes.txt": Buffer.from("Synthetic") }))], ["fixture.rar", rar4()], ["fixture.7z", sevenZip()], ["fixture.bmp", bmp()], ["fixture.webp", webp()]] as const) {
      const before = Buffer.from(bytes); assert.ok(validate(name, "application/octet-stream", bytes)); assert.deepEqual(bytes, before);
      assert.throws(() => validate(name, "application/octet-stream", bytes.subarray(0, bytes.length - 1)), error => error instanceof ErrorType && error.status === 415, name);
    }
  });
  test(`${runtime} rejects wrong Office kind, active OOXML, unsafe archives, compound aliases/cycles and invalid mini streams`, () => {
    const sameChain = compoundOffice("doc"); sameChain.copy(sameChain, 1280, 1152, 1280); sameChain.write("Another\0", 1280, "utf16le"); sameChain.writeUInt16LE(16, 1344);
    const cycle = compoundOffice("xls", true); cycle.writeUInt32LE(0, 1536);
    const outside = compoundOffice("xls", true); outside.writeUInt32LE(1000, 1152 + 116);
    const fatAlias = compoundOffice("doc"); fatAlias.writeUInt32LE(0, 1152 + 116);
    for (const [name, bytes] of [["bad.doc", sameChain], ["bad.xls", cycle], ["bad.xls", outside], ["bad.doc", fatAlias], ["bad.xls", compoundOffice("doc")], ["bad.docx", officeZip("xlsx")], ["bad.xlsx", officeZip("xlsx", { "xl/vbaProject.bin": Buffer.from("bad") })], ["bad.docx", officeZip("docx", { "word/external.rels": Buffer.from('<Relationship TargetMode="External" Target="https://invalid/"/>') })], ["bad.zip", Buffer.from(zipSync({ "../escape.txt": Buffer.from("bad") }))], ["bad.zip", Buffer.from(zipSync({ "bomb.txt": Buffer.alloc(2_000_000) }))], ["bad.bmp", Buffer.alloc(54)]] as const) assert.throws(() => validate(name, "application/octet-stream", bytes), error => error instanceof ErrorType && error.status === 415, name);
    const badCrc = sevenZip(); badCrc[33] = 1; assert.throws(() => validate("bad.7z", "application/octet-stream", badCrc));
    const encrypted = rar4(); encrypted.writeUInt16LE(0x80, 10); encrypted.writeUInt16LE(crc32(encrypted.subarray(9, 20)) & 0xffff, 7); assert.throws(() => validate("bad.rar", "application/octet-stream", encrypted));
    for (const target of ["External", "&#69;xternal", "&#x45;xternal"]) assert.throws(() => validate("external.docx", "application/octet-stream", officeZip("docx", { "word/_rels/document.xml.rels": Buffer.from(`<Relationship TargetMode="${target}" Target="https://invalid/"/>`) })), error => error instanceof ErrorType && error.status === 415);
    for (const xml of [Buffer.from('<?xml version="1.0" encoding="UTF-16LE"?><Relationships><Relationship TargetMode="External" Target="https://invalid/"/></Relationships>', "utf16le"), Buffer.from('<?xml version="1.0" encoding="UTF-7"?><Relationships/>')]) assert.throws(() => validate("encoding.docx", "application/octet-stream", officeZip("docx", { "word/_rels/document.xml.rels": xml })), error => error instanceof ErrorType && error.status === 415);
  });
  test(`${runtime} exact task and source large-log byte limits retain +1 refusal`, () => {
    const text = Buffer.alloc(TASK_ATTACHMENT_LIMIT, 65); assert.equal(validate("limit.txt", "text/plain", text), "text/plain");
    assert.throws(() => validate("limit.txt", "text/plain", Buffer.alloc(TASK_ATTACHMENT_LIMIT + 1)), error => error instanceof ErrorType && error.status === 413);
    const csv = Buffer.alloc(LARGE_LOG_ATTACHMENT_LIMIT, 65); assert.equal(validate("limit.csv", "text/csv", csv, LARGE_LOG_ATTACHMENT_LIMIT), "text/csv");
    assert.throws(() => validate("limit.csv", "text/csv", Buffer.alloc(LARGE_LOG_ATTACHMENT_LIMIT + 1), LARGE_LOG_ATTACHMENT_LIMIT), error => error instanceof ErrorType && error.status === 413);
  });
  test(`${runtime} large whitespace CSV has bounded linear validation and formula prefixes still refuse`, { timeout: 10_000 }, () => {
    const whitespace = Buffer.alloc(LARGE_LOG_ATTACHMENT_LIMIT, 32);
    assert.equal(validate("safe.csv", "text/csv", whitespace, LARGE_LOG_ATTACHMENT_LIMIT), "text/csv");
    for (const prefix of ["", ",", ";", "\t", "\r\n", "\u00a0", "\u2003", ' " ', ',  "\t']) for (const operator of ["=", "+", "@", "-"])
      assert.throws(() => validate("bad.csv", "text/csv", Buffer.from(prefix + operator + "fixture")), error => error instanceof ErrorType && error.status === 415);
    assert.equal(validate("safe.csv", "text/csv", Buffer.from('"quoted name",ordinary-value\nName,123')), "text/csv");
    const animated = webp(); animated[20] = animated[20]! | 2; assert.throws(() => validate("animated.webp", "image/webp", animated));
    const hugeCanvas = webp(); hugeCanvas.fill(255, 24, 30); assert.throws(() => validate("huge.webp", "image/webp", hugeCanvas));
  });
}
