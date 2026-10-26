/** Bounded, single-image GIF profile. CompuServe GIF89a sections 18–23 and appendix F.
 * No animation, text/application/comment payloads, external decoder or public preview.
 */
export const MAX_GIF_PIXELS = 16_000_000;
export const MAX_GIF_DIMENSION = 8192;

function invalid(): never { throw new Error("Unsupported GIF content."); }

/** Validate every decoded palette index and exact pixel count without allocating a raster.
 * Dictionary entries inherit valid indices from their prefix and final symbol; keeping
 * their lengths and first symbols bounds memory to the 4,096-entry GIF dictionary.
 */
function validateLzw(data: Buffer, minimum: number, paletteSize: number, expectedPixels: number) {
  if (minimum < 2 || minimum > 8 || !data.length) invalid();
  const clear = 1 << minimum, end = clear + 1;
  const lengths = new Uint32Array(4096), first = new Uint16Array(4096);
  for (let i = 0; i < clear; i++) { lengths[i] = 1; first[i] = i; }
  let width = minimum + 1, next = end + 1, previous = -1, bit = 0, pixels = 0, codes = 0;
  const read = () => {
    if (bit + width > data.length * 8 || ++codes > expectedPixels * 2 + 4096) invalid();
    const byte = bit >>> 3, shift = bit & 7;
    const code = ((data[byte]! | ((data[byte + 1] ?? 0) << 8) | ((data[byte + 2] ?? 0) << 16)) >>> shift) & ((1 << width) - 1);
    bit += width; return code;
  };
  if (read() !== clear) invalid();
  while (true) {
    const code = read();
    if (code === clear) { width = minimum + 1; next = end + 1; previous = -1; continue; }
    if (code === end) {
      // No hidden data after EOI, including extra sub-block bytes. Zero bit padding only.
      if (pixels !== expectedPixels || data.length * 8 - bit >= 8) invalid();
      for (; bit < data.length * 8; bit++) if ((data[bit >>> 3]! >>> (bit & 7)) & 1) invalid();
      return;
    }
    let length: number, symbol: number;
    if (code < clear) { if (code >= paletteSize) invalid(); length = 1; symbol = code; }
    else if (code < next) { length = lengths[code]!; symbol = first[code]!; }
    else if (code === next && previous !== -1 && next < 4096) { length = lengths[previous]! + 1; symbol = first[previous]!; }
    else invalid();
    if (!length || (pixels += length) > expectedPixels) invalid();
    if (previous !== -1 && next < 4096) {
      lengths[next] = lengths[previous]! + 1; first[next] = first[previous]!;
      // The suffix is `symbol`, already checked directly or through a valid entry.
      if (symbol >= paletteSize) invalid();
      next++; if (next === (1 << width) && width < 12) width++;
    }
    previous = code;
  }
}

export function validateStaticGif(bytes: Buffer): void {
  if (bytes.length < 35 || !["GIF87a", "GIF89a"].includes(bytes.toString("latin1", 0, 6))) invalid();
  const width = bytes.readUInt16LE(6), height = bytes.readUInt16LE(8), packed = bytes[10]!;
  const oldVersion = bytes.toString("latin1", 3, 6) === "87a";
  if (!width || !height || width > MAX_GIF_DIMENSION || height > MAX_GIF_DIMENSION || width * height > MAX_GIF_PIXELS
    || bytes[12] !== 0 || (oldVersion && (packed & 8))) invalid(); // Non-square pixel aspect ratios are outside this profile.
  const globalSize = packed & 128 ? 1 << ((packed & 7) + 1) : 0;
  if ((globalSize && bytes[11]! >= globalSize) || (!globalSize && (bytes[11] !== 0 || (packed & 15)))) invalid();
  let offset = 13 + globalSize * 3, transparent: number | undefined;
  if (offset >= bytes.length) invalid();
  // Permit one optional transparency/control block; reject delay, disposal animation,
  // user-input flags and every extension carrying arbitrary application/text content.
  if (bytes[offset] === 0x21) {
    if (bytes.toString("latin1", 3, 6) !== "89a" || offset + 8 > bytes.length || bytes[offset + 1] !== 0xf9 || bytes[offset + 2] !== 4) invalid();
    const flags = bytes[offset + 3]!;
    if ((flags & ~5) || bytes.readUInt16LE(offset + 4) !== 0 || bytes[offset + 7] !== 0) invalid();
    if (flags & 1) transparent = bytes[offset + 6]; else if (bytes[offset + 6] !== 0) invalid();
    offset += 8;
  }
  if (offset + 10 > bytes.length || bytes[offset++] !== 0x2c) invalid();
  const left = bytes.readUInt16LE(offset), top = bytes.readUInt16LE(offset + 2);
  const imageWidth = bytes.readUInt16LE(offset + 4), imageHeight = bytes.readUInt16LE(offset + 6), imageFlags = bytes[offset + 8]!;
  if (!imageWidth || !imageHeight || left + imageWidth > width || top + imageHeight > height || (imageFlags & 24) || (oldVersion && (imageFlags & 32))) invalid();
  offset += 9;
  const localSize = imageFlags & 128 ? 1 << ((imageFlags & 7) + 1) : 0;
  if (!localSize && (imageFlags & 39)) invalid();
  const paletteSize = localSize || globalSize;
  if (!paletteSize || (transparent !== undefined && transparent >= paletteSize)) invalid();
  offset += localSize * 3;
  if (offset >= bytes.length) invalid();
  const minimum = bytes[offset++]!, parts: Buffer[] = []; let blocks = 0;
  while (true) {
    if (offset >= bytes.length) invalid();
    const size = bytes[offset++]!;
    if (!size) break;
    if (++blocks > 65_536 || offset + size > bytes.length) invalid();
    parts.push(bytes.subarray(offset, offset + size)); offset += size;
  }
  // Exactly one frame and one trailer. Appended HTML/ZIP and secondary images fail.
  if (offset + 1 !== bytes.length || bytes[offset] !== 0x3b) invalid();
  validateLzw(Buffer.concat(parts), minimum, paletteSize, imageWidth * imageHeight);
}
