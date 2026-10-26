// Synthetic black/white static GIF. This is test evidence only, never CRM data.
export function syntheticGif() { return Buffer.from("47494638376101000100800000000000ffffff2c00000000010001000002024401003b", "hex"); }

export function gifWithCodes(width: number, height: number, codes: readonly (readonly [number, number])[], localPalette = false) {
  const output: number[] = []; let bits = 0, pending = 0;
  for (const [code, size] of codes) {
    pending |= code << bits; bits += size;
    while (bits >= 8) { output.push(pending & 255); pending >>>= 8; bits -= 8; }
  }
  if (bits) output.push(pending);
  const header = Buffer.from("47494638396100000000800000", "hex"); header.writeUInt16LE(width, 6); header.writeUInt16LE(height, 8);
  const image = Buffer.from("2c000000000000000000", "hex"); image.writeUInt16LE(width, 5); image.writeUInt16LE(height, 7);
  const palette = Buffer.from("000000ffffff", "hex");
  if (localPalette) { header[10] = 0; image[9] = 128; }
  const blocks: Buffer[] = [];
  for (let i = 0; i < output.length; i += 255) { const part = output.slice(i, i + 255); blocks.push(Buffer.from([part.length, ...part])); }
  return Buffer.concat([header, ...(localPalette ? [] : [palette]), image, ...(localPalette ? [palette] : []), Buffer.from([2]), ...blocks, Buffer.from([0, 0x3b])]);
}

// Uncompressed literal codes cross each width boundary, fill the dictionary,
// continue at 12 bits (deferred clear), then explicitly reset it.
export function syntheticLargeGif() {
  const codes: [number, number][] = [[4, 3]];
  for (let i = 0; i < 8192; i++) codes.push([i & 1, Math.min(12, Math.ceil(Math.log2(Math.max(8, i + 6))))]);
  codes.push([4, 12], [1, 3], [5, 3]);
  return gifWithCodes(2731, 3, codes);
}
