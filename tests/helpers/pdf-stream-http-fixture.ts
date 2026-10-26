/** Passive one-page PDF; /A is text inside an exact-length content stream. */
export function syntheticStreamPdf(indirectLength = false): Buffer {
  const stream = "BT /F1 12 Tf 5 40 Td (Synthetic /A token is printed text only) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${indirectLength ? "6 0 R" : Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...(indirectLength ? [String(Buffer.byteLength(stream, "latin1"))] : []),
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(body, "latin1"); body += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => offset.toString().padStart(10, "0") + " 00000 n \n").join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
