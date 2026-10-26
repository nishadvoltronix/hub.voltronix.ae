import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { validateClassicPdf, PdfProfileError } from "../src/crm/attachments/pdf.js";
import { AttachmentError, validateContent } from "../src/crm/attachments/service.js";
import { classicPdf } from "./helpers/pdf-profile-fixture.js";

const denied = "A AA Action OpenAction PA JavaScript JS Launch GoTo GoToR GoToE GoTo3DView Named ResetForm SubmitForm ImportData URI Rendition Movie Sound Screen Hide SetOCGState Thread Trans EmbeddedFile EmbeddedFiles Filespec FileAttachment EF AF Collection RichMedia 3D AcroForm XFA Encrypt ObjStm".split(" ");
const refusals = (bytes: Buffer) => assert.throws(() => validateClassicPdf(bytes), PdfProfileError);

test("classic PDF fallback separates inert stream bytes from names without changing uploaded bytes", async () => {
  const bytes = classicPdf({ catalog: "/Label (escaped \\( /A \\) and nested (text)) /Hex <2f4a53> /Custom /A.safe % /JS is a comment\n" });
  const before = createHash("sha256").update(bytes).digest("hex");
  const result = validateClassicPdf(bytes);
  assert.deepEqual({ ...result, tokens: undefined }, { profile: "classic-xref-bounded-stream-v1", objects: 4, streams: 1, pages: 1, tokens: undefined });
  assert.ok(result.tokens > 0 && result.tokens < 250_000);
  assert.equal(validateContent("original.pdf", "application/pdf", bytes), "application/pdf");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), before);
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false });
  const pdf = await loading.promise;
  try { assert.equal(pdf.numPages, 1); assert.equal(await pdf.getJSActions(), null); assert.equal(await pdf.getOpenAction(), null); assert.deepEqual(await (await pdf.getPage(1)).getAnnotations(), []); }
  finally { await loading.destroy(); }
});

test("classic PDF fallback accepts only the evidenced Sharp scanner header suffix", () => {
  const scanned = classicPdf({ header: "%PDF-1.4 Sharp Scanned ImagePDF\n" });
  assert.equal(validateClassicPdf(scanned).pages, 1);
  assert.equal(validateContent("scan.pdf", "application/pdf", scanned), "application/pdf");
  for (const suffix of [" Sharp Scanned ImagePDF extra", " arbitrary producer", "\tSharp Scanned ImagePDF"]) {
    refusals(classicPdf({ header: `%PDF-1.4${suffix}\n` }));
  }
});

test("classic PDF fallback retains every canonical and escaped restricted name plus external-content exclusions", () => {
  for (const name of [...denied, "XRef", "Prev", "XRefStm", "F", "FFilter", "FDecodeParms", "FS", "RF", "DOS", "Mac", "Unix", "PS", "Ref", "OPI", "Crypt"]) {
    for (const key of [name, [...name].map(c => "#" + c.charCodeAt(0).toString(16)).join("")]) {
      const bytes = classicPdf({ catalog: `/${key} null` }); refusals(bytes);
      assert.throws(() => validateContent("active.pdf", "application/pdf", bytes), (e: unknown) => e instanceof AttachmentError && e.status === 415);
    }
  }
  for (const value of ["<< /S /JavaScript /JS (alert) >>", "<< /Type /Filespec /F (external) >>", "<< /Subtype /PS >>"]) refusals(classicPdf({ extra: [value] }));
});

test("classic PDF fallback refuses malformed dictionaries, streams, strings, references and hidden objects", () => {
  for (const bytes of [
    classicPdf({ streamLength: "1" }), classicPdf({ streamLength: "99999999" }), classicPdf({ streamLength: "-1" }),
    classicPdf({ streamLength: "5 0 R", extra: ["10"] }), classicPdf({ streamDictionary: "/Length 0" }),
    classicPdf({ streamDictionary: "/Type 5 0 R", extra: ["/#4fbjStm"] }),
    classicPdf({ catalog: "/Broken <zz>" }), classicPdf({ catalog: "/Broken (unterminated" }),
    classicPdf({ catalog: "/Bad#Q1 null" }), classicPdf({ catalog: "/Null#00 null" }), classicPdf({ catalog: "/Missing 77 0 R" }),
    classicPdf({ catalog: "/WrongGeneration 1 1 R" }), classicPdf({ extra: ["5 0 R"] }),
    classicPdf({ content: "/A\nendstream\nendobj\n99 0 obj << /JS null >> endobj\n", streamLength: "3" }),
    classicPdf({ extra: ["null\nendobj\n99 0 obj null"] }),
    classicPdf({ catalog: "/Type /Catalog" }),
    Buffer.concat([classicPdf(), Buffer.from("trailing garbage")]),
    Buffer.from(classicPdf().toString("latin1").replace("stream\n", "stream\r"), "latin1"),
    Buffer.from(classicPdf().toString("latin1").replace("endstream", "endstreaX"), "latin1"),
  ]) refusals(bytes);
});

test("classic PDF fallback verifies exact xref identity, offsets, coverage and nonincremental structure", () => {
  const original = classicPdf().toString("latin1");
  for (const text of [
    original.replace("0000000009 00000 n", "0000000010 00000 n"),
    original.replace("0000000009 00000 n", "0000000009 00001 n"),
    original.replace("0000000009 00000 n", "0000000009 00000 f"),
    original.replace("0000000000 65535 f", "0000000001 65535 f"),
    original.replace("1 0 obj", "9 0 obj"), original.replace("/Size 5", "/Size 6"),
    original.replace(/startxref\n\d+/, "startxref\n9"),
    classicPdf({ trailer: "/Prev 9" }).toString("latin1"), classicPdf({ trailer: "/XRefStm 9" }).toString("latin1"),
  ]) refusals(Buffer.from(text, "latin1"));
  // A line comment cannot hide indexed objects; classic xref entries must be exactly 20 bytes.
  refusals(Buffer.from(original.replace("endobj\n2", "%ndobj\n2"), "latin1"));
  refusals(Buffer.from(original.replace("0000000009 00000 n \n", "0000000009 00000 n\n"), "latin1"));
});

test("classic PDF fallback bounds bytes, object counts, nesting, tokens and page traversal", () => {
  refusals(Buffer.alloc(52_428_801));
  refusals(classicPdf({ catalog: "/Deep " + "[".repeat(40) + "null" + "]".repeat(40) }));
  refusals(classicPdf({ catalog: "/Deep (" + "(".repeat(40) + ")".repeat(40) + ")" }));
  refusals(classicPdf({ catalog: "/Many [" + "0 ".repeat(130_000) + "]" }));
  refusals(Buffer.from(classicPdf().toString("latin1").replace("xref\n0 5", "xref\n0 8193"), "latin1"));
  refusals(classicPdf({ pages: "<< /Type /Pages /Count 1 /Kids [2 0 R] >>" }));
  refusals(classicPdf({ pages: "<< /Type /Pages /Count 2 /Kids [3 0 R 3 0 R] >>" }));
  refusals(classicPdf({ pages: "<< /Type /Pages /Count 2 /Kids [3 0 R] >>" }));
  refusals(classicPdf({ page: "<< /Type /Page /Parent 1 0 R >>" }));
});

test("classic PDF compatibility keeps extension, declared MIME and size gates", () => {
  const valid = classicPdf();
  for (const [name, mime, bytes, status] of [
    ["document.jpg", "image/jpeg", valid, 415], ["document.pdf", "image/jpeg", valid, 415],
    ["document.pdf.exe", "application/pdf", valid, 415], ["document.pdf", "application/pdf", Buffer.from("not a PDF"), 415],
  ] as const) assert.throws(() => validateContent(name, mime, bytes), (e: unknown) => e instanceof AttachmentError && e.status === status);
  assert.throws(() => validateContent("document.pdf", "application/pdf", valid, valid.length - 1), (e: unknown) => e instanceof AttachmentError && e.status === 413);
});

test("classic PDF resolves a scalar indirect length once without aliases, cycles or hidden target bytes", () => {
  const content = "BT (/A inert text) Tj ET\n", length = Buffer.byteLength(content, "latin1");
  const bytes = classicPdf({ content, streamLength: "5 0 R", extra: [String(length), `<< /Length 5 0 R >>\nstream\n${content}\nendstream`] });
  const result = validateClassicPdf(bytes); assert.equal(result.streams, 2); assert.equal(result.pages, 1);
  assert.equal(validateContent("indirect.pdf", "application/pdf", bytes), "application/pdf");
  for (const extra of ["5 0 R", "6 0 R", `(${length})`, `<< /Length ${length} >>`, `-${length}`, `${length}.5`, `${length}\nendobj\n99 0 obj null`, "9999999999"]) {
    refusals(classicPdf({ content, streamLength: "5 0 R", extra: [extra] }));
  }
  for (const streamLength of ["99 0 R", "4 0 R", "5 1 R"]) refusals(classicPdf({ content, streamLength, extra: [String(length)] }));
  // Identical lexical integer rules for targets before and after their streams.
  for (const scalar of [`${length}.0`, `+${length}`, `0${length}`]) {
    refusals(classicPdf({ content, streamLength: "5 0 R", extra: [scalar] }));
    refusals(classicPdf({ content, extra: [scalar, `<< /Length 5 0 R >>\nstream\n${content}\nendstream`] }));
  }
});
