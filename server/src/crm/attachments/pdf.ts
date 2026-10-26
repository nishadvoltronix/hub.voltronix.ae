/** Narrow fallback for classic-xref PDFs refused by raw byte scanning.
 * PDF 1.4 reference sections 3.2.7 and 3.4.3: stream extents come from
 * /Length and object offsets from xref. No stream is decoded or executed.
 * Unsupported syntax, ambiguous structure and exhausted budgets fail closed.
 */
const RESTRICTED = new Set("A AA Action OpenAction PA JavaScript JS Launch GoTo GoToR GoToE GoTo3DView Named ResetForm SubmitForm ImportData URI Rendition Movie Sound Screen Hide SetOCGState Thread Trans EmbeddedFile EmbeddedFiles Filespec FileAttachment EF AF Collection RichMedia 3D AcroForm XFA Encrypt ObjStm XRef Prev XRefStm F FFilter FDecodeParms FS RF DOS Mac Unix PS Ref OPI Crypt".split(" "));
const MAX_BYTES = 52_428_800, MAX_OBJECTS = 8192, MAX_TOKENS = 250_000, MAX_DEPTH = 32;
type Name = { kind: "name"; value: string };
type Ref = { kind: "ref"; id: number };
type Dict = { kind: "dict"; entries: Map<string, Value> };
type Value = number | boolean | null | Name | Ref | Dict | Value[] | { kind: "string" };
type ObjectRecord = { value: Value; stream: boolean; unsignedInteger: boolean };
export class PdfProfileError extends Error {
  constructor(public readonly code: string) { super(`Unsupported PDF profile: ${code}`); }
}
function fail(code: string): never { throw new PdfProfileError(code); }
function check(value: unknown, code: string): asserts value { if (!value) fail(code); }
function whitespace(c: number | undefined) { return c !== undefined && [0, 9, 10, 12, 13, 32].includes(c); }
function delimiter(c: number | undefined) { return c === undefined || whitespace(c) || [40, 41, 60, 62, 91, 93, 123, 125, 47, 37].includes(c); }
function dictionary(value: Value | undefined): Dict { check(value && !Array.isArray(value) && typeof value === "object" && value.kind === "dict", "dictionary"); return value; }
function reference(value: Value | undefined): Ref { check(value && !Array.isArray(value) && typeof value === "object" && value.kind === "ref", "reference"); return value; }
function isName(value: Value | undefined, name: string) { return value && !Array.isArray(value) && typeof value === "object" && value.kind === "name" && value.value === name; }
function integer(value: Value | undefined): number { check(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, "integer"); return value; }

class Reader {
  position = 0;
  limit: number;
  tokens = 0;
  readonly refs = new Set<number>();
  constructor(readonly bytes: Buffer) { this.limit = bytes.length; }
  skip() {
    while (this.position < this.limit) {
      if (whitespace(this.bytes[this.position])) { this.position++; continue; }
      if (this.bytes[this.position] !== 37) break;
      while (this.position < this.limit && ![10, 13].includes(this.bytes[this.position]!)) this.position++;
      check(this.position < this.limit, "unterminated-comment");
    }
  }
  word(): string {
    this.skip(); const start = this.position;
    while (this.position < this.limit && !delimiter(this.bytes[this.position])) this.position++;
    check(this.position > start && this.position - start <= 64, "word");
    check(++this.tokens <= MAX_TOKENS, "token-budget");
    return this.bytes.toString("latin1", start, this.position);
  }
  expect(word: string) { check(this.word() === word, "keyword"); }
  uint(): number { const word = this.word(); check(/^(?:0|[1-9][0-9]{0,9})$/.test(word), "unsigned-integer"); return Number(word); }
  value(depth = 0): Value {
    check(depth <= MAX_DEPTH, "nesting-budget"); check(++this.tokens <= MAX_TOKENS, "token-budget"); this.skip();
    check(this.position < this.limit, "truncated-value"); const c = this.bytes[this.position]!;
    if (c === 47) {
      this.position++; let name = "";
      while (this.position < this.limit && !delimiter(this.bytes[this.position])) {
        let code = this.bytes[this.position++]!;
        if (code === 35) {
          const hex = this.bytes.toString("latin1", this.position, this.position + 2);
          check(this.position + 2 <= this.limit && /^[0-9a-f]{2}$/i.test(hex), "name-escape");
          code = parseInt(hex, 16); this.position += 2;
        }
        check(code >= 33 && code <= 126, "name-character"); name += String.fromCharCode(code);
        check(name.length <= 127, "name-budget");
      }
      check(name.length && !RESTRICTED.has(name), "restricted-name"); return { kind: "name", value: name };
    }
    if (c === 40) {
      this.position++; let nesting = 1;
      while (this.position < this.limit && nesting) {
        const code = this.bytes[this.position++]!;
        if (code === 92) {
          check(this.position < this.limit, "string-escape");
          if (this.bytes[this.position] === 13 && this.bytes[this.position + 1] === 10) this.position++;
          this.position++;
        } else if (code === 40) { check(++nesting <= MAX_DEPTH, "string-nesting-budget"); }
        else if (code === 41) nesting--;
      }
      check(!nesting, "unterminated-string"); return { kind: "string" };
    }
    if (c === 60 && this.bytes[this.position + 1] !== 60) {
      this.position++;
      while (this.position < this.limit && this.bytes[this.position] !== 62) {
        const code = this.bytes[this.position++]!;
        check(whitespace(code) || (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102), "hex-string");
      }
      check(this.position < this.limit, "unterminated-hex-string"); this.position++; return { kind: "string" };
    }
    if (c === 60) {
      this.position += 2; const entries = new Map<string, Value>();
      while (true) {
        this.skip();
        if (this.bytes[this.position] === 62 && this.bytes[this.position + 1] === 62) { this.position += 2; break; }
        const key = this.value(depth + 1);
        check(key && !Array.isArray(key) && typeof key === "object" && key.kind === "name", "dictionary-key");
        check(!entries.has(key.value), "duplicate-key"); entries.set(key.value, this.value(depth + 1));
      }
      return { kind: "dict", entries };
    }
    if (c === 91) {
      this.position++; const values: Value[] = [];
      while (true) { this.skip(); if (this.bytes[this.position] === 93) { this.position++; break; } values.push(this.value(depth + 1)); }
      return values;
    }
    const word = this.word();
    if (word === "true" || word === "false") return word === "true";
    if (word === "null") return null;
    check(/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(word), "number-or-keyword");
    const number = Number(word); check(Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER, "number-range");
    // Look ahead only for syntactically valid generation-zero indirect references.
    const after = this.position; this.skip(); const rest = this.bytes.toString("latin1", this.position, Math.min(this.position + 32, this.limit));
    // eslint-disable-next-line no-control-regex -- PDF whitespace explicitly includes NUL.
    const suffix = /^(\d{1,5})[\x00\t\n\f\r ]+R/.exec(rest);
    if (/^(?:0|[1-9][0-9]*)$/.test(word) && suffix && delimiter(this.bytes[this.position + suffix[0].length])) {
      check(number > 0 && number < MAX_OBJECTS && suffix[1] === "0", "reference-range");
      this.position += suffix[0].length; this.refs.add(number); return { kind: "ref", id: number };
    }
    this.position = after; return number;
  }
}

/** Validates an additional constrained profile. It never changes input bytes.
 * Returns only structural counts; no original text, strings or stream data.
 */
export function validateClassicPdf(bytes: Buffer) {
  check(bytes.length > 0 && bytes.length <= MAX_BYTES, "byte-budget");
  check(/^%PDF-1\.[0-7](?: Sharp Scanned ImagePDF)?(?:\r\n|\n|\r)/.test(bytes.toString("latin1", 0, 40)), "header");
  const tailStart = Math.max(0, bytes.length - 256), tail = bytes.toString("latin1", tailStart);
  const footer = /startxref[ \t\r\n]+([0-9]{1,10})[ \t\r\n]+%%EOF[ \t\r\n]*$/.exec(tail);
  check(footer, "footer"); const xref = Number(footer[1]); check(xref > 8 && xref < tailStart + footer.index, "xref-offset");
  const reader = new Reader(bytes); reader.position = xref; reader.expect("xref");
  check(reader.uint() === 0, "xref-subsection"); const count = reader.uint(); check(count > 1 && count <= MAX_OBJECTS, "object-budget");
  while ([9, 32].includes(bytes[reader.position]!)) reader.position++;
  if (bytes[reader.position] === 13) reader.position++;
  check(bytes[reader.position++] === 10, "xref-eol");
  const offsets = new Map<number, number>();
  for (let id = 0; id < count; id++) {
    const entry = /^(\d{10}) (\d{5}) ([fn])(?: \n|\r\n| \r)$/.exec(bytes.toString("latin1", reader.position, reader.position + 20));
    check(entry, "xref-entry"); reader.position += 20;
    const offset = entry[1]!, generation = entry[2]!, flag = entry[3]!;
    if (id === 0) check(flag === "f" && generation === "65535" && Number(offset) === 0, "xref-free-head");
    else {
      // Holes/free lists and old generations require a separately reviewed profile.
      check(flag === "n" && generation === "00000", "xref-generation");
      check(Number(offset) >= 9 && Number(offset) < xref, "object-offset"); offsets.set(id, Number(offset));
    }
  }
  reader.expect("trailer"); const trailer = dictionary(reader.value());
  check(integer(trailer.entries.get("Size")) === count, "xref-size");
  const root = reference(trailer.entries.get("Root"));
  reader.skip(); check(reader.position === tailStart + footer.index, "trailer-tail");
  const ordered = [...offsets].sort((a, b) => a[1] - b[1]);
  check(new Set(ordered.map(entry => entry[1])).size === ordered.length, "duplicate-offset");
  const objects = new Map<number, ObjectRecord>(); let position = 0, streams = 0;
  const boundaries = new Map(ordered.map(([id], index) => [id, ordered[index + 1]?.[1] ?? xref]));
  const scalarLengths = new Map<number, { value: number; end: number }>();
  function streamLength(value: Value | undefined): number {
    if (typeof value === "number") return integer(value);
    const ref = reference(value), parsed = objects.get(ref.id);
    if (parsed) { check(!parsed.stream && parsed.unsignedInteger, "length-scalar"); return integer(parsed.value); }
    const cached = scalarLengths.get(ref.id); if (cached) return cached.value;
    const offset = offsets.get(ref.id), end = boundaries.get(ref.id);
    check(offset !== undefined && end !== undefined, "length-reference");
    const savedPosition = reader.position, savedLimit = reader.limit;
    reader.position = offset; reader.limit = end;
    try {
      check(reader.uint() === ref.id && reader.uint() === 0, "length-identity"); reader.expect("obj");
      // Exactly one unsigned integer, not an alias, string, dictionary or stream.
      // Each referenced target is parsed once and later traversed by normal coverage.
      const length = reader.uint(); reader.expect("endobj"); reader.skip();
      check(reader.position === end, "length-tail"); scalarLengths.set(ref.id, { value: length, end }); return length;
    } finally { reader.position = savedPosition; reader.limit = savedLimit; }
  }
  for (let index = 0; index < ordered.length; index++) {
    const [id, offset] = ordered[index]!; reader.position = position; reader.limit = offset; reader.skip();
    check(reader.position === offset, "unindexed-bytes");
    reader.limit = ordered[index + 1]?.[1] ?? xref; reader.position = offset;
    const scalar = scalarLengths.get(id);
    if (scalar) { check(scalar.end === reader.limit, "length-boundary"); objects.set(id, { value: scalar.value, stream: false, unsignedInteger: true }); position = scalar.end; continue; }
    check(reader.uint() === id && reader.uint() === 0, "object-identity"); reader.expect("obj");
    reader.skip(); const valueStart = reader.position, value = reader.value();
    const unsignedInteger = typeof value === "number" && /^(?:0|[1-9][0-9]{0,9})$/.test(bytes.toString("latin1", valueStart, reader.position));
    check(!(value && !Array.isArray(value) && typeof value === "object" && value.kind === "ref"), "indirect-alias");
    reader.skip(); let stream = false;
    if (bytes.toString("latin1", reader.position, reader.position + 6) === "stream") {
      const dict = dictionary(value); const length = streamLength(dict.entries.get("Length"));
      for (const key of ["F", "FFilter", "FDecodeParms"]) check(!dict.entries.has(key), "external-stream");
      reader.position += 6;
      if (bytes[reader.position] === 13) reader.position++;
      check(bytes[reader.position++] === 10, "stream-eol");
      check(length <= reader.limit - reader.position, "stream-length"); reader.position += length;
      if (bytes[reader.position] === 13) { reader.position++; if (bytes[reader.position] === 10) reader.position++; }
      else if (bytes[reader.position] === 10) reader.position++;
      // Only the declared length (plus one optional EOL) locates this keyword.
      check(bytes.toString("latin1", reader.position, reader.position + 9) === "endstream" && delimiter(bytes[reader.position + 9]), "stream-end");
      reader.position += 9; stream = true; streams++;
    }
    reader.expect("endobj"); reader.skip(); check(reader.position === reader.limit, "object-tail");
    position = reader.position; objects.set(id, { value, stream, unsignedInteger });
  }
  for (const id of reader.refs) check(objects.has(id), "dangling-reference");
  const catalog = dictionary(objects.get(root.id)?.value); check(!objects.get(root.id)!.stream && isName(catalog.entries.get("Type"), "Catalog"), "root-catalog");
  const visited = new Set<number>(); let pages = 0;
  function pageTree(id: number, parent: number | undefined, depth: number): number {
    check(depth <= MAX_DEPTH && !visited.has(id), "page-tree-cycle"); visited.add(id);
    const record = objects.get(id); check(record && !record.stream, "page-tree-object"); const dict = dictionary(record.value);
    if (parent !== undefined) check(reference(dict.entries.get("Parent")).id === parent, "page-parent");
    else check(!dict.entries.has("Parent"), "root-page-parent");
    if (isName(dict.entries.get("Type"), "Page")) { pages++; return 1; }
    check(isName(dict.entries.get("Type"), "Pages"), "page-tree-type");
    const kids = dict.entries.get("Kids"); check(Array.isArray(kids) && kids.length > 0, "page-tree-kids");
    let total = 0; for (const kid of kids) total += pageTree(reference(kid).id, id, depth + 1);
    check(integer(dict.entries.get("Count")) === total, "page-count"); return total;
  }
  pageTree(reference(catalog.entries.get("Pages")).id, undefined, 0);
  check(pages > 0, "pages");
  return { profile: "classic-xref-bounded-stream-v1", objects: objects.size, streams, pages, tokens: reader.tokens } as const;
}
