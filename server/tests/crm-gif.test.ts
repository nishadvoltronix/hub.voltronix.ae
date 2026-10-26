import assert from "node:assert/strict";
import test from "node:test";
import { validateContent, AttachmentError, MAX_ATTACHMENT_BYTES } from "../src/crm/attachments/service.js";


const accept = (bytes: Buffer) => assert.equal(validateContent("synthetic.gif", "image/gif", bytes), "image/gif");
const reject = (bytes: Buffer) => assert.throws(() => validateContent("synthetic.gif", "image/gif", bytes), (error) => error instanceof AttachmentError && error.status === 415);
function patch(bytes: Buffer, at: number, values: number[]) { const result = Buffer.from(bytes); result.set(values, at); return result; }
function beforeImage(extension: number[]) { const image = syntheticGif(); image.write("89a", 3); return Buffer.concat([image.subarray(0, 19), Buffer.from(extension), image.subarray(19)]); }

test("static GIF87a/89a profiles fully validate literal, dictionary, special-case LZW, local palette, interlace and transparency", () => {
  accept(syntheticGif());
  accept(gifWithCodes(4, 1, [[4, 3], [0, 3], [1, 3], [6, 3], [5, 4]]));
  accept(gifWithCodes(3, 1, [[4, 3], [0, 3], [6, 3], [5, 3]], true));
  accept(patch(syntheticGif(), 28, [64]));
  accept(beforeImage([0x21, 0xf9, 4, 1, 0, 0, 0, 0]));
  accept(beforeImage([0x21, 0xf9, 4, 4, 0, 0, 0, 0]));
});

test("GIF LZW width changes through 12 bits, a full dictionary, deferred clear and a clear reset remain bounded and valid", () => {
  const image = syntheticLargeGif();
  accept(image);
});

test("GIF rejects incomplete files, invalid signatures, misplaced trailers and arbitrary appended payloads", () => {
  const good = syntheticGif();
  for (let end = 1; end < good.length; end++) reject(good.subarray(0, end));
  reject(patch(good, 0, [0])); reject(patch(good, 3, [56, 56, 97]));
  for (let index = 0; index < 6; index++) reject(patch(good, index, [good[index]! | 128]));
  reject(Buffer.concat([good, Buffer.from("<script>test</script>")]));
  reject(Buffer.concat([good.subarray(0, -1), good.subarray(19)]));
  reject(patch(good, 30, [255])); reject(patch(good, 33, [1]));
});

test("GIF rejects unsupported animation, application, comment, plain-text and malformed control extensions", () => {
  for (const extension of [
    [0x21, 0xff, 11, ...Buffer.from("NETSCAPE2.0"), 3, 1, 0, 0, 0],
    [0x21, 0xfe, 4, ...Buffer.from("text"), 0], [0x21, 1, 0],
    [0x21, 0xf9, 4, 0, 1, 0, 0, 0], [0x21, 0xf9, 4, 8, 0, 0, 0, 0],
    [0x21, 0xf9, 4, 2, 0, 0, 0, 0], [0x21, 0xf9, 4, 32, 0, 0, 0, 0],
    [0x21, 0xf9, 4, 1, 0, 0, 2, 0], [0x21, 0xf9, 4, 0, 0, 0, 1, 0],
    [0x21, 0xf9, 3, 1, 0, 0, 0, 0], [0x21, 0xf9, 4, 1, 0, 0, 0, 1],
    [0x21, 0xf9, 4, 1, 0, 0, 0, 0, 0x21, 0xf9, 4, 1, 0, 0, 0, 0],
  ]) reject(beforeImage(extension));
  const oldVersion = beforeImage([0x21, 0xf9, 4, 1, 0, 0, 0, 0]); oldVersion.write("87a", 3); reject(oldVersion);
});

test("GIF bounds screen, image rectangle, palette indices and reserved bits before decoding", () => {
  const good = syntheticGif();
  for (const [offset, values] of [[6, [0, 0]], [6, [1, 32]], [6, [0xff, 0xff]], [12, [1]], [11, [2]],
    [10, [136]], [20, [1, 0]], [22, [1, 0]], [24, [2, 0]], [26, [0, 0]], [28, [8]], [28, [32]], [28, [1]]] as const) reject(patch(good, offset, [...values]));
  const large = Buffer.from(good); large.writeUInt16LE(4096, 6); large.writeUInt16LE(4096, 8); reject(large);
  reject(gifWithCodes(1, 1, [[4, 3], [2, 3], [5, 3]]));
  reject(patch(good, 10, [0]));
});

test("GIF rejects corrupt LZW, wrong decoded size, missing clear/end codes, hidden compressed payload and code floods", () => {
  for (const codes of [
    [[0, 3], [5, 3]], [[4, 3], [5, 3]], [[4, 3], [0, 3]], [[4, 3], [0, 3], [1, 3], [5, 3]],
    [[4, 3], [6, 3], [5, 3]], [[4, 3], [0, 3], [7, 3], [5, 3]],
    [[4, 3], [0, 3], [5, 3], [0, 8]],
  ]) reject(gifWithCodes(1, 1, codes as [number, number][]));
  for (const minimum of [0, 1, 9, 12]) reject(patch(syntheticGif(), 29, [minimum]));
  reject(patch(syntheticGif(), 32, [0x81]));
  reject(gifWithCodes(1, 1, [...Array.from({ length: 5000 }, () => [4, 3] as const), [0, 3], [5, 3]]));
});

test("GIF obeys existing file-size and extension/media-type limits", () => {
  assert.throws(() => validateContent("synthetic.gif", "image/gif", Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)), (error) => error instanceof AttachmentError && error.status === 413);
  assert.throws(() => validateContent("synthetic.gif", "image/png", syntheticGif()), (error) => error instanceof AttachmentError && error.status === 415);
  assert.throws(() => validateContent("synthetic.png", "image/png", syntheticGif()), (error) => error instanceof AttachmentError && error.status === 415);
});

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
