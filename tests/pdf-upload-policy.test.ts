import assert from "node:assert/strict";
import test from "node:test";
import { AttachmentError, validateContent } from "../src/server/attachments/service";
import { syntheticActionPdf } from "./helpers/pdf-upload-fixture";
import { validateContent as sqliteValidate, AttachmentError as SqliteAttachmentError } from "./sqlite-reference/attachments/service";

test("restricted PDF uploads reject action dictionaries independently recognized by PDF.js", async () => {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  for (const name of ["A", "#41"]) {
    const bytes = syntheticActionPdf("/S /Named /N /Print", name);
    const loading = getDocument({ data: new Uint8Array(bytes) });
    const pdf = await loading.promise;
    try {
      assert.equal(pdf.numPages, 1);
      const annotations = await (await pdf.getPage(1)).getAnnotations();
      assert.equal(annotations.length, 1);
      assert.equal(annotations[0].action, "Print");
      assert.throws(() => validateContent("synthetic.pdf", "application/pdf", bytes),
        (error: unknown) => error instanceof AttachmentError && error.status === 415);
    } finally { await loading.destroy(); }
  }
  assert.equal(validateContent("synthetic.pdf", "application/pdf", syntheticActionPdf()), "application/pdf");
});

test("PDF case-sensitive names distinguish inert custom keys from canonical and escaped action names in both providers", async () => {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  for (const key of ["A", "#41", "a", "#61"]) {
    const loading = getDocument({ data: new Uint8Array(syntheticActionPdf("/S /Named /N /Print", key)), useWorkerFetch: false }); const pdf = await loading.promise;
    try { const annotations = await (await pdf.getPage(1)).getAnnotations(); assert.equal(annotations.length, 1); assert.equal(annotations[0].action, ["A", "#41"].includes(key) ? "Print" : undefined); }
    finally { await loading.destroy(); }
  }
  const names = ["A", "AA", "Action", "OpenAction", "PA", "JavaScript", "JS", "Launch", "GoTo", "GoToR", "GoToE", "GoTo3DView", "Named", "ResetForm", "SubmitForm", "ImportData", "URI", "Rendition", "Movie", "Sound", "Screen", "Hide", "SetOCGState", "Thread", "Trans", "EmbeddedFile", "EmbeddedFiles", "Filespec", "FileAttachment", "EF", "AF", "Collection", "RichMedia", "3D", "AcroForm", "XFA", "Encrypt", "ObjStm"];
  const inert = syntheticActionPdf(undefined, "A", names.map(name => `/${name.toLowerCase()} null`).join(" "));
  const loading = getDocument({ data: new Uint8Array(inert), useWorkerFetch: false }); const pdf = await loading.promise;
  try { assert.equal(pdf.numPages, 1); assert.deepEqual(await (await pdf.getPage(1)).getAnnotations(), []); assert.equal(await pdf.getJSActions(), null); assert.equal(await pdf.getOpenAction(), null); }
  finally { await loading.destroy(); }
  for (const [validate, ErrorType] of [[validateContent, AttachmentError], [sqliteValidate, SqliteAttachmentError]] as const) {
    assert.equal(validate("inert-custom.pdf", "application/pdf", inert), "application/pdf");
    for (const name of names) for (const key of [name, [...name].map(value => "#" + value.charCodeAt(0).toString(16)).join("")])
      assert.throws(() => validate("restricted.pdf", "application/pdf", syntheticActionPdf(undefined, "A", `/${key} null`)), (error: unknown) => error instanceof ErrorType && error.status === 415, key);
  }
});
