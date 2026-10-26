export function classicPdf(options: { header?: string; catalog?: string; content?: string; streamDictionary?: string; streamLength?: string; page?: string; pages?: string; extra?: string[]; trailer?: string } = {}) {
  const content = options.content ?? "BT (/A /JavaScript is inert page text) Tj ET\n";
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${options.catalog ?? ""} >>`,
    options.pages ?? "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    options.page ?? "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${options.streamLength ?? Buffer.byteLength(content, "latin1")} ${options.streamDictionary ?? ""} >>\nstream\n${content}\nendstream`,
    ...options.extra ?? [],
  ];
  let result = options.header ?? "%PDF-1.4\n", offsets: number[] = [];
  for (const [index, value] of objects.entries()) { offsets = [...offsets, Buffer.byteLength(result, "latin1")]; result += `${index + 1} 0 obj\n${value}\nendobj\n`; }
  const xref = Buffer.byteLength(result, "latin1");
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => String(offset).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${options.trailer ?? ""} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result, "latin1");
}
