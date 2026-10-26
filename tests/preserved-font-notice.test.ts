import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isPreservedFontNotice, preservedFontNoticePath } from "../scripts/preserved-font-notice";
import { preservedPath } from "../tools/preservation-paths.mjs";

test("packaging preserves the exact source font notice but refuses altered bytes and unrelated whitespace exemptions", () => {
  const copy = readFileSync(new URL("../resources/quotation-pdf/DejaVuinfo.txt", import.meta.url));
  const original = readFileSync(preservedPath(fileURLToPath(new URL("..", import.meta.url)), "vendor/mpdf/mpdf/ttfonts/DejaVuinfo.txt"));
  assert.match(copy.toString("utf8"), /[\t ]+\r?$/m);
  assert.equal(isPreservedFontNotice(preservedFontNoticePath, copy, original), true);
  const altered = Buffer.concat([copy, Buffer.from(" ")]);
  assert.equal(isPreservedFontNotice(preservedFontNoticePath, altered, original), false);
  assert.equal(isPreservedFontNotice(preservedFontNoticePath, copy, altered), false);
  assert.equal(isPreservedFontNotice(preservedFontNoticePath, altered, altered), false);
  for (const path of ["resources/quotation-pdf/other.txt", "resources/quotation-pdf/dejavuinfo.txt",
    "resources/quotation-pdf/../quotation-pdf/DejaVuinfo.txt", "docs/DejaVuinfo.txt"])
    assert.equal(isPreservedFontNotice(path, copy, original), false);
});
