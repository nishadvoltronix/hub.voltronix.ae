import { crc32, inflateRawSync } from "node:zlib";

// These bounded container validators do not execute, extract, render, rewrite or
// certify malware-free documents. Office/archive files are always download-only.
const invalid = () => { throw new Error("Unsupported binary container"); };
const requireValid = (condition: unknown): void => { if (!condition) invalid(); };
const dimensions = (width: number, height: number) => requireValid(width > 0 && height > 0 && width * height <= 40_000_000);
export function validateBmp(bytes: Buffer) {
  requireValid(bytes.length >= 54 && bytes.toString("ascii", 0, 2) === "BM" && bytes.readUInt32LE(2) === bytes.length && bytes.readUInt32LE(6) === 0);
  const start = bytes.readUInt32LE(10), header = bytes.readUInt32LE(14), width = bytes.readInt32LE(18), height = Math.abs(bytes.readInt32LE(22));
  requireValid([40, 108, 124].includes(header) && start >= 14 + header && start <= bytes.length && bytes.readUInt16LE(26) === 1);
  dimensions(width, height);
  const bits = bytes.readUInt16LE(28), compression = bytes.readUInt32LE(30), palette = bytes.readUInt32LE(46);
  requireValid([1, 4, 8, 24, 32].includes(bits) && compression === 0);
  requireValid(bits > 8 ? palette === 0 : palette <= 2 ** bits && start >= 14 + header + 4 * (palette || 2 ** bits));
  requireValid(start + Math.ceil(width * bits / 32) * 4 * height === bytes.length);
  // Embedded/linked colour profiles need separate handling; never resolve paths.
  if (header === 124) requireValid(bytes.readUInt32LE(126) === 0 && bytes.readUInt32LE(130) === 0);
}
export function validateWebp(bytes: Buffer) {
  requireValid(bytes.length >= 26 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.readUInt32LE(4) + 8 === bytes.length && bytes.toString("ascii", 8, 12) === "WEBP");
  let offset = 12, images = 0, chunks = 0, extended = false, canvasWidth = 0, canvasHeight = 0;
  const types = new Set<string>();
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4), length = bytes.readUInt32LE(offset + 4), start = offset + 8, end = start + length;
    requireValid(++chunks <= 64 && !types.has(type) && end + (length % 2) <= bytes.length && (!(length % 2) || bytes[end] === 0)); types.add(type);
    if (type === "VP8X") {
      requireValid(chunks === 1 && length === 10 && !(bytes[start]! & 0xc3) && bytes.readUIntLE(start + 1, 3) === 0);
      canvasWidth = bytes.readUIntLE(start + 4, 3) + 1; canvasHeight = bytes.readUIntLE(start + 7, 3) + 1;
      dimensions(canvasWidth, canvasHeight); extended = true;
    } else if (type === "VP8 ") {
      requireValid(++images === 1 && length >= 10 && !(bytes[start]! & 1) && bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 1, 0x2a])));
      const width = bytes.readUInt16LE(start + 6) & 0x3fff, height = bytes.readUInt16LE(start + 8) & 0x3fff;
      dimensions(width, height); requireValid((bytes.readUIntLE(start, 3) >>> 5) <= length - 10 && (!extended || width === canvasWidth && height === canvasHeight));
    } else if (type === "VP8L") {
      requireValid(++images === 1 && length >= 5 && bytes[start] === 0x2f);
      const packed = bytes.readUInt32LE(start + 1), width = (packed & 0x3fff) + 1, height = ((packed >>> 14) & 0x3fff) + 1;
      requireValid((packed >>> 29) === 0); dimensions(width, height); requireValid(!extended || width === canvasWidth && height === canvasHeight);
    } else requireValid(extended && ["ALPH", "ICCP", "EXIF", "XMP "].includes(type) && length > 0 && (type !== "ALPH" || images === 0));
    offset = end + (length % 2);
  }
  requireValid(offset === bytes.length && images === 1);
}
const safeArchiveName = (name: string) => name.length > 0 && name.length <= 512 && !name.startsWith("/") && !/[\\:\u202a-\u202e\u2066-\u2069]/.test(name) && ![...name].some(value => value.charCodeAt(0) < 32 || value.charCodeAt(0) === 127) && !name.split("/").some(part => part === ".." || part === ".");
type ZipEntry = { name: string; bytes: Buffer; size: number; crc: number; method: number };
function zipEntries(bytes: Buffer): ZipEntry[] {
  requireValid(bytes.length >= 22);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65_557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  requireValid(end >= 0 && bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length);
  const count = bytes.readUInt16LE(end + 10), length = bytes.readUInt32LE(end + 12), central = bytes.readUInt32LE(end + 16);
  requireValid(count <= 2048 && bytes.readUInt16LE(end + 8) === count && central + length === end);
  const result: ZipEntry[] = [], names = new Set<string>(), ranges: [number, number][] = [];
  let offset = central, expanded = 0;
  for (let index = 0; index < count; index++) {
    requireValid(offset + 46 <= end && bytes.readUInt32LE(offset) === 0x02014b50);
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), crc = bytes.readUInt32LE(offset + 16), compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24), nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32), local = bytes.readUInt32LE(offset + 42);
    requireValid(!(flags & ~0x080e) && [0, 8].includes(method) && bytes.readUInt16LE(offset + 34) === 0 && offset + 46 + nameLength + extraLength + commentLength <= end);
    // Avoid ambiguous legacy-codepage names, duplicate aliases, symlinks and ZIP64.
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
    requireValid(safeArchiveName(name) && !names.has(name.toLowerCase()) && ((bytes.readUInt32LE(offset + 38) >>> 16) & 0xf000) !== 0xa000);
    names.add(name.toLowerCase()); expanded += size;
    requireValid(size <= 64 * 1024 * 1024 && expanded <= 256 * 1024 * 1024 && size <= Math.max(1_048_576, compressed * 500));
    requireValid(local + 30 <= central && bytes.readUInt32LE(local) === 0x04034b50 && bytes.readUInt16LE(local + 6) === flags && bytes.readUInt16LE(local + 8) === method);
    const localNameLength = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), data = local + 30 + localNameLength + localExtra;
    requireValid(localNameLength === nameLength && bytes.subarray(local + 30, local + 30 + nameLength).equals(nameBytes) && data + compressed <= central);
    if (!(flags & 8)) requireValid(bytes.readUInt32LE(local + 14) === crc && bytes.readUInt32LE(local + 18) === compressed && bytes.readUInt32LE(local + 22) === size);
    let stop = data + compressed;
    if (flags & 8) {
      if (stop + 4 <= central && bytes.readUInt32LE(stop) === 0x08074b50) stop += 4;
      requireValid(stop + 12 <= central && bytes.readUInt32LE(stop) === crc && bytes.readUInt32LE(stop + 4) === compressed && bytes.readUInt32LE(stop + 8) === size); stop += 12;
    }
    ranges.push([local, stop]); result.push({ name, bytes: bytes.subarray(data, data + compressed), size, crc, method });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  requireValid(offset === end); ranges.sort((a, b) => a[0] - b[0]);
  let previous = 0; for (const [start, stop] of ranges) { requireValid(start === previous); previous = stop; } requireValid(previous === central);
  return result;
}
function unpack(entry: ZipEntry, limit: number) {
  requireValid(entry.size <= limit);
  const bytes = entry.method === 0 ? entry.bytes : inflateRawSync(entry.bytes, { maxOutputLength: Math.max(1, entry.size) });
  requireValid(bytes.length === entry.size && crc32(bytes) === entry.crc); return bytes;
}
export function validateZip(bytes: Buffer, office?: "docx" | "xlsx" | "pptx") {
  const entries = zipEntries(bytes);
  // Validate every member's compressed stream and CRC with a fixed aggregate
  // expansion budget. No archive member is written to a filesystem.
  let expanded = 0;
  for (const entry of entries) { expanded += entry.size; requireValid(expanded <= 64 * 1024 * 1024); unpack(entry, 32 * 1024 * 1024); }
  if (!office) return;
  const root = { docx: "word/document.xml", xlsx: "xl/workbook.xml", pptx: "ppt/presentation.xml" }[office];
  requireValid(entries.some(entry => entry.name === root) && entries.some(entry => entry.name === "_rels/.rels"));
  const contentTypes = entries.find(entry => entry.name === "[Content_Types].xml"); requireValid(contentTypes);
  for (const entry of entries) {
    requireValid(!/(?:vbaProject|vbaData|activeX|embeddings|macros)/i.test(entry.name));
    if (entry.name.endsWith(".xml") || entry.name.endsWith(".rels")) {
      const xml = new TextDecoder("utf-8", { fatal: true }).decode(unpack(entry, 4 * 1024 * 1024)).replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_match, value: string) => {
        const point = parseInt(value[0]?.toLowerCase() === "x" ? value.slice(1) : value, value[0]?.toLowerCase() === "x" ? 16 : 10);
        requireValid(point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)); return String.fromCodePoint(point);
      });
      // UTF-16 without a BOM is byte-valid UTF-8 containing NULs; it must not
      // bypass the UTF-8 known-pattern checks through a different XML decoder.
      requireValid(!xml.includes("\0"));
      const declaredEncoding = /^\s*<\?xml\b[^?]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(xml)?.[1];
      requireValid(declaredEncoding === undefined || /^utf-8$/i.test(declaredEncoding));
      requireValid(!/<!\s*(?:DOCTYPE|ENTITY)|macroEnabled|vbaProject|TargetMode\s*=\s*["']External/i.test(xml));
      if (entry === contentTypes) {
        const contentType = { docx: "wordprocessingml.document", xlsx: "spreadsheetml.sheet", pptx: "presentationml.presentation" }[office];
        requireValid(xml.includes(`application/vnd.openxmlformats-officedocument.${contentType}.main+xml`) && xml.includes("/" + root));
      }
    }
  }
}
export function validateCompoundOffice(bytes: Buffer, extension: "doc" | "xls" | "ppt") {
  requireValid(bytes.length >= 512 && bytes.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex")) && bytes.readUInt16LE(28) === 0xfffe);
  const major = bytes.readUInt16LE(26), shift = bytes.readUInt16LE(30), sector = 2 ** shift;
  requireValid((major === 3 && shift === 9 || major === 4 && shift === 12) && bytes.readUInt16LE(32) === 6 && bytes.length % sector === 0 && bytes.readUInt32LE(56) === 4096);
  const sectors = bytes.length / sector - 1, fatCount = bytes.readUInt32LE(44), fat: number[] = [], ids: number[] = [];
  const block = (id: number) => { requireValid(id < sectors); return bytes.subarray((id + 1) * sector, (id + 2) * sector); };
  for (let index = 0; index < 109; index++) { const id = bytes.readUInt32LE(76 + index * 4); if (id !== 0xffffffff) ids.push(id); }
  let difat = bytes.readUInt32LE(68); const seen = new Set<number>();
  for (let n = 0; n < bytes.readUInt32LE(72); n++) { requireValid(!seen.has(difat) && n < sectors); seen.add(difat); const data = block(difat); for (let i = 0; i < sector - 4; i += 4) if (data.readUInt32LE(i) !== 0xffffffff) ids.push(data.readUInt32LE(i)); difat = data.readUInt32LE(sector - 4); }
  requireValid(ids.length === fatCount && new Set(ids).size === ids.length && (difat === 0xfffffffe || difat === 0xffffffff));
  for (const id of ids) { const data = block(id); for (let i = 0; i < sector; i += 4) fat.push(data.readUInt32LE(i)); }
  // Claim each sector once globally. Aliased chains must not cause repeated
  // allocation/traversal when many directory entries reference the same bytes.
  const owned = new Set<number>([...ids, ...seen]);
  requireValid(owned.size === ids.length + seen.size);
  for (const id of ids) requireValid(fat[id] === 0xfffffffd);
  for (const id of seen) requireValid(fat[id] === 0xfffffffc);
  let allocated = 0;
  const chain = (start: number) => { const found: Buffer[] = []; let id = start; while (id !== 0xfffffffe) {
    requireValid(id < sectors && !owned.has(id)); owned.add(id); allocated += sector; requireValid(allocated <= bytes.length);
    found.push(block(id)); id = fat[id] ?? 0xffffffff;
  } return Buffer.concat(found); };
  const directory = chain(bytes.readUInt32LE(48)); requireValid(directory.length > 0);
  requireValid(directory[66] === 5);
  const rootSize = directory.readBigUInt64LE(120); requireValid(rootSize <= BigInt(bytes.length));
  const miniStream = rootSize > 0n ? chain(directory.readUInt32LE(116)) : Buffer.alloc(0);
  requireValid(miniStream.length === Math.ceil(Number(rootSize) / sector) * sector);
  const miniCount = bytes.readUInt32LE(64), miniFatBytes = miniCount ? chain(bytes.readUInt32LE(60)) : Buffer.alloc(0);
  requireValid(miniFatBytes.length === miniCount * sector && (miniCount > 0 || [0xfffffffe, 0xffffffff].includes(bytes.readUInt32LE(60))));
  const miniOwned = new Set<number>();
  const validateSmall = (start: number, size: number) => {
    let id = start, count = 0;
    while (id !== 0xfffffffe) {
      requireValid(id * 64 + 64 <= Number(rootSize) && id * 4 + 4 <= miniFatBytes.length && !miniOwned.has(id));
      miniOwned.add(id); count++; requireValid(count <= Math.ceil(size / 64)); id = miniFatBytes.readUInt32LE(id * 4);
    }
    requireValid(count === Math.ceil(size / 64));
  };
  const streamNames: string[] = [];
  for (let i = 0; i < directory.length; i += 128) {
    const kind = directory[i + 66]; if (!kind) continue;
    const length = directory.readUInt16LE(i + 64); requireValid([1, 2, 5].includes(kind) && (kind !== 5 || i === 0) && length >= 2 && length <= 64 && length % 2 === 0 && directory.readUInt16LE(i + length - 2) === 0);
    const name = directory.toString("utf16le", i, i + length - 2); requireValid(!/(?:VBA|Macros|EncryptionInfo|EncryptedPackage|ObjectPool)/i.test(name));
    if (kind === 2) streamNames.push(name);
    const size = directory.readBigUInt64LE(i + 120); requireValid(size <= BigInt(bytes.length));
    if (kind === 2 && size >= 4096n) requireValid(chain(directory.readUInt32LE(i + 116)).length === Math.ceil(Number(size) / sector) * sector);
    else if (kind === 2) validateSmall(directory.readUInt32LE(i + 116), Number(size));
  }
  requireValid(extension === "doc" ? streamNames.includes("WordDocument") : extension === "xls" ? streamNames.some(name => ["Workbook", "Book"].includes(name)) : streamNames.includes("PowerPoint Document"));
}

/** RAR4/5 header walk. Compressed members are never decompressed or rendered. */
export function validateRar(bytes: Buffer) {
  const v5 = bytes.subarray(0, 8).equals(Buffer.from("526172211a070100", "hex")), v4 = bytes.subarray(0, 7).equals(Buffer.from("526172211a0700", "hex"));
  requireValid(v5 || v4); let offset = v5 ? 8 : 7, count = 0, main = false, ended = false;
  const vint = (state: { at: number }, limit: number) => { let result = 0n; for (let n = 0; n < 10; n++) { requireValid(state.at < limit); const next = bytes[state.at++]!; result |= BigInt(next & 127) << BigInt(n * 7); if (!(next & 128)) { requireValid(result <= BigInt(Number.MAX_SAFE_INTEGER)); return Number(result); } } invalid(); return 0; };
  while (offset < bytes.length) {
    requireValid(++count <= 4096);
    if (v5) {
      requireValid(offset + 6 <= bytes.length); const state = { at: offset + 4 }, size = vint(state, bytes.length), end = state.at + size;
      requireValid(size <= 1_048_576 && end <= bytes.length && crc32(bytes.subarray(offset + 4, end)) === bytes.readUInt32LE(offset));
      const type = vint(state, end), flags = vint(state, end); requireValid(!(flags & (8 | 16)) && type !== 4);
      const extra = flags & 1 ? vint(state, end) : 0, data = flags & 2 ? vint(state, end) : 0;
      requireValid(extra <= end - state.at && end + data <= bytes.length);
      if (type === 1) { requireValid(!main); main = true; const archiveFlags = vint(state, end); requireValid(!(archiveFlags & 1)); }
      else if (type === 2) {
        requireValid(main); const fileFlags = vint(state, end), unpacked = vint(state, end); requireValid(!(fileFlags & 8) && unpacked <= 64 * 1024 * 1024); vint(state, end);
        if (fileFlags & 2) state.at += 4; if (fileFlags & 4) state.at += 4;
        vint(state, end); vint(state, end); const nameLength = vint(state, end); requireValid(state.at + nameLength <= end - extra);
        requireValid(safeArchiveName(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(state.at, state.at + nameLength))));
        // Encryption and redirection extras cannot be handled by this profile.
        let position = end - extra; while (position < end) { const field = { at: position }, fieldSize = vint(field, end), next = field.at + fieldSize; requireValid(next <= end); const fieldType = vint(field, next); requireValid(![1, 5].includes(fieldType)); position = next; }
      } else if (type === 5) { ended = true; requireValid(end + data === bytes.length); }
      else requireValid(type === 3 && main);
      offset = end + data;
    } else {
      requireValid(offset + 7 <= bytes.length); const type = bytes[offset + 2]!, flags = bytes.readUInt16LE(offset + 3), size = bytes.readUInt16LE(offset + 5), end = offset + size;
      requireValid(size >= 7 && end <= bytes.length && (crc32(bytes.subarray(offset + 2, end)) & 0xffff) === bytes.readUInt16LE(offset));
      let data = flags & 0x8000 ? bytes.readUInt32LE(offset + 7) : 0;
      if (type === 0x73) { requireValid(!main && size >= 13 && !(flags & (1 | 0x80))); main = true; }
      else if (type === 0x74) {
        requireValid(main && size >= 32 && !(flags & (1 | 2 | 4 | 0x100 | 0x200)) && bytes.readUInt32LE(offset + 11) <= 64 * 1024 * 1024);
        data = bytes.readUInt32LE(offset + 7); const length = bytes.readUInt16LE(offset + 26); requireValid(32 + length <= size);
        requireValid(safeArchiveName(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset + 32, offset + 32 + length))));
      } else if (type === 0x7b) { ended = true; requireValid(end + data === bytes.length); } else invalid();
      requireValid(end + data <= bytes.length); offset = end + data;
    }
  }
  requireValid(offset === bytes.length && main && ended);
}
/** Exact 7z start/next-header bounds+CRC; opaque compressed headers/data remain
 * download-only and are never extracted. No malware/name-content claim is made. */
export function validateSevenZip(bytes: Buffer) {
  requireValid(bytes.length >= 34 && bytes.subarray(0, 6).equals(Buffer.from("377abcaf271c", "hex")) && bytes[6] === 0 && bytes[7]! <= 4 && crc32(bytes.subarray(12, 32)) === bytes.readUInt32LE(8));
  const offset = bytes.readBigUInt64LE(12), size = bytes.readBigUInt64LE(20);
  requireValid(size > 0n && size <= 4_194_304n && 32n + offset + size === BigInt(bytes.length));
  const header = bytes.subarray(32 + Number(offset)); requireValid([1, 0x17].includes(header[0]!) && header.at(-1) === 0 && crc32(header) === bytes.readUInt32LE(28));
}
