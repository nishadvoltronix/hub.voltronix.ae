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
