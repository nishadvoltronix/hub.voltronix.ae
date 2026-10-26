import assert from "node:assert/strict";
import test from "node:test";
import { AttachmentError, validateContent } from "../src/crm/attachments/service.js";


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

test("PDF case-sensitive names distinguish inert custom keys from canonical and escaped action names", async () => {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Independent parser proves the same annotation dictionary has an action only
  // with /A or its #41 escape. No action/JavaScript is executed or URL followed.
  for (const key of ["A", "#41", "a", "#61"]) {
    const loading = getDocument({ data: new Uint8Array(syntheticActionPdf("/S /Named /N /Print", key)), useWorkerFetch: false });
    const pdf = await loading.promise;
    try { const annotations = await (await pdf.getPage(1)).getAnnotations(); assert.equal(annotations.length, 1); assert.equal(annotations[0].action, ["A", "#41"].includes(key) ? "Print" : undefined); }
    finally { await loading.destroy(); }
  }
  const names = ["A", "AA", "Action", "OpenAction", "PA", "JavaScript", "JS", "Launch", "GoTo", "GoToR", "GoToE", "GoTo3DView", "Named", "ResetForm", "SubmitForm", "ImportData", "URI", "Rendition", "Movie", "Sound", "Screen", "Hide", "SetOCGState", "Thread", "Trans", "EmbeddedFile", "EmbeddedFiles", "Filespec", "FileAttachment", "EF", "AF", "Collection", "RichMedia", "3D", "AcroForm", "XFA", "Encrypt", "ObjStm"];
  const inert = syntheticActionPdf(undefined, "A", names.map(name => `/${name.toLowerCase()} null`).join(" "));
  const loading = getDocument({ data: new Uint8Array(inert), useWorkerFetch: false }); const pdf = await loading.promise;
  try { assert.equal(pdf.numPages, 1); assert.deepEqual(await (await pdf.getPage(1)).getAnnotations(), []); assert.equal(await pdf.getJSActions(), null); assert.equal(await pdf.getOpenAction(), null); }
  finally { await loading.destroy(); }
  assert.equal(validateContent("inert-custom.pdf", "application/pdf", inert), "application/pdf");
  for (const name of names) for (const key of [name, [...name].map(value => "#" + value.charCodeAt(0).toString(16)).join("")])
    assert.throws(() => validateContent("restricted.pdf", "application/pdf", syntheticActionPdf(undefined, "A", `/${key} null`)), (error: unknown) => error instanceof AttachmentError && error.status === 415, key);
});

/** One-page synthetic PDF with an optional link action; no network or real records. */
export function syntheticActionPdf(action?: string, actionKey = "A", customCatalog = ""): Buffer {
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${customCatalog} >>`,
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >>${action ? " /Annots [4 0 R]" : ""} >>`,
    ...(action ? [`<< /Type /Annot /Subtype /Link /Rect [0 0 50 50] /Border [0 0 0] /${actionKey} << ${action} >> >>`] : []),
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(body, "latin1"); body += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => offset.toString().padStart(10, "0") + " 00000 n \n").join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
