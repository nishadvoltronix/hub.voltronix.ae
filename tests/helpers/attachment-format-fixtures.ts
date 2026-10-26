import { crc32 } from "node:zlib";
import { zipSync } from "fflate";

/** Generated, non-executing containers; never derived from a user upload. */
export function officeZip(kind: "docx" | "xlsx" | "pptx", extras: Record<string, Uint8Array> = {}) {
  const root = { docx: "word/document.xml", xlsx: "xl/workbook.xml", pptx: "ppt/presentation.xml" }[kind];
  const type = { docx: "wordprocessingml.document", xlsx: "spreadsheetml.sheet", pptx: "presentationml.presentation" }[kind];
  return Buffer.from(zipSync({ "[Content_Types].xml": Buffer.from(`<Types><Override PartName="/${root}" ContentType="application/vnd.openxmlformats-officedocument.${type}.main+xml"/></Types>`), "_rels/.rels": Buffer.from("<Relationships/>"), [root]: Buffer.from("<Synthetic/>"), ...extras }, { level: 0 }));
}
/** 1x1 canvas exported by Chromium locally; no external or user image. */
export function webp() { return Buffer.from("UklGRhYCAABXRUJQVlA4WAoAAAAgAAAAAAAAAAAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggKAAAAJABAJ0BKgEAAQABQCYliAJ0ugADmAD++ajv7U2Kqed36FGyiXzAAAA=", "base64"); }
export function compoundOffice(kind: "doc" | "xls" | "ppt", small = false) {
  const sector = 512, count = small ? 4 : 10, bytes = Buffer.alloc((count + 1) * sector);
  Buffer.from("d0cf11e0a1b11ae1", "hex").copy(bytes); bytes.writeUInt16LE(0x3e, 24); bytes.writeUInt16LE(3, 26); bytes.writeUInt16LE(0xfffe, 28); bytes.writeUInt16LE(9, 30); bytes.writeUInt16LE(6, 32);
  bytes.writeUInt32LE(1, 44); bytes.writeUInt32LE(1, 48); bytes.writeUInt32LE(4096, 56); bytes.writeUInt32LE(small ? 2 : 0xfffffffe, 60); bytes.writeUInt32LE(small ? 1 : 0, 64); bytes.writeUInt32LE(0xfffffffe, 68);
  bytes.fill(0xff, 76, 512); bytes.writeUInt32LE(0, 76);
  const fat = bytes.subarray(512, 1024); fat.fill(0xff); fat.writeUInt32LE(0xfffffffd); fat.writeUInt32LE(0xfffffffe, 4);
  const entry = (at: number, name: string, type: number, start: number, size: number) => { bytes.write(name + "\0", at, "utf16le"); bytes.writeUInt16LE((name.length + 1) * 2, at + 64); bytes[at + 66] = type; bytes[at + 67] = 1; bytes.writeUInt32LE(0xffffffff, at + 68); bytes.writeUInt32LE(0xffffffff, at + 72); bytes.writeUInt32LE(type === 5 ? 1 : 0xffffffff, at + 76); bytes.writeUInt32LE(start, at + 116); bytes.writeBigUInt64LE(BigInt(size), at + 120); };
  entry(1024, "Root Entry", 5, small ? 3 : 0xfffffffe, small ? 64 : 0);
  entry(1152, { doc: "WordDocument", xls: "Workbook", ppt: "PowerPoint Document" }[kind], 2, small ? 0 : 2, small ? 8 : 4096);
  if (small) { fat.writeUInt32LE(0xfffffffe, 8); fat.writeUInt32LE(0xfffffffe, 12); bytes.fill(0xff, 1536, 2048); bytes.writeUInt32LE(0xfffffffe, 1536); }
  else for (let id = 2; id < 10; id++) fat.writeUInt32LE(id === 9 ? 0xfffffffe : id + 1, id * 4);
  return bytes;
}
export function bmp() { const bytes = Buffer.alloc(58); bytes.write("BM"); bytes.writeUInt32LE(bytes.length, 2); bytes.writeUInt32LE(54, 10); bytes.writeUInt32LE(40, 14); bytes.writeInt32LE(1, 18); bytes.writeInt32LE(1, 22); bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28); return bytes; }
export function rar4() {
  const header = (kind: number, size: number) => { const bytes = Buffer.alloc(size); bytes[2] = kind; bytes.writeUInt16LE(size, 5); bytes.writeUInt16LE(crc32(bytes.subarray(2)) & 0xffff); return bytes; };
  return Buffer.concat([Buffer.from("526172211a0700", "hex"), header(0x73, 13), header(0x7b, 7)]);
}
export function sevenZip() { const header = Buffer.from([1, 0]), bytes = Buffer.alloc(34); Buffer.from("377abcaf271c0004", "hex").copy(bytes); bytes.writeBigUInt64LE(2n, 20); bytes.writeUInt32LE(crc32(header), 28); bytes.writeUInt32LE(crc32(bytes.subarray(12, 32)), 8); header.copy(bytes, 32); return bytes; }
