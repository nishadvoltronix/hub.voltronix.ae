import assert from "node:assert/strict";
import test from "node:test";
import { validateClassicPdf as retained } from "../src/server/attachments/pdf";
import { validateClassicPdf as sqlite } from "./sqlite-reference/attachments/pdf";
import { validateContent } from "./sqlite-reference/attachments/service";
import { classicPdf } from "./helpers/pdf-profile-fixture";

test("SQLite reference applies the same bounded classic PDF grammar and upload fallback", () => {
  const bytes = classicPdf(); assert.deepEqual(sqlite(bytes), retained(bytes));
  assert.equal(validateContent("inert.pdf", "application/pdf", bytes), "application/pdf");
  const scanned = classicPdf({ header: "%PDF-1.4 Sharp Scanned ImagePDF\n" });
  assert.deepEqual(sqlite(scanned), retained(scanned));
  assert.equal(validateContent("scan.pdf", "application/pdf", scanned), "application/pdf");
  for (const fixture of [
    classicPdf({ catalog: "/#41 << /S /Named /N /Print >>" }),
    classicPdf({ streamLength: "1" }), classicPdf({ streamDictionary: "/F (external)" }),
    classicPdf({ trailer: "/Prev 9" }), classicPdf({ catalog: "/Unresolved 77 0 R" }),
    classicPdf({ pages: "<< /Type /Pages /Count 1 /Kids [2 0 R] >>" }),
    classicPdf({ catalog: "/Deep " + "[".repeat(40) + "null" + "]".repeat(40) }),
  ]) for (const check of [retained, sqlite]) assert.throws(() => check(fixture));
});
