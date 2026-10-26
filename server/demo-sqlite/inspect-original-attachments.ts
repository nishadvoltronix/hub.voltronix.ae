/** Read-only original-file compatibility inspection. Never opens a database,
 * logs in, renders a document, invokes its actions or writes original assets. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateContent as backend } from "../src/crm/attachments/service.js";
import { validateContent as retained } from "../../src/server/attachments/service.js";
import { validateContent as sqlite } from "../../tests/sqlite-reference/attachments/service.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const inputRoot = resolve(repository, "assets/photos");
const reportDirectory = resolve(repository, "server/.local-data/reports", `original-attachment-corpus-${randomUUID()}`);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const deniedNames = "A|AA|Action|OpenAction|PA|JavaScript|JS|Launch|GoTo|GoToR|GoToE|GoTo3DView|Named|ResetForm|SubmitForm|ImportData|URI|Rendition|Movie|Sound|Screen|Hide|SetOCGState|Thread|Trans|EmbeddedFile|EmbeddedFiles|Filespec|FileAttachment|EF|AF|Collection|RichMedia|3D|AcroForm|XFA|Encrypt|ObjStm";
function pdfDiagnostics(bytes: Buffer) {
  const raw = bytes.toString("latin1"), names = raw.replace(/#[0-9a-f]{2}/gi, value => String.fromCharCode(parseInt(value.slice(1), 16)));
  const exact = [...new Set([...names.matchAll(new RegExp(`/(${deniedNames})\\b`, "g"))].map(value => value[1]!))].sort();
  const folded = [...new Set([...names.matchAll(new RegExp(`/(${deniedNames})\\b`, "gi"))].map(value => value[1]!))].sort();
  const structure = {
    acceptedHeader: /^%PDF-1\.[0-7][\r\n]/.test(raw), acceptedEndAndXref: /%%EOF\s*$/.test(raw) && /\bstartxref\s+\d+\s+%%EOF\s*$/.test(raw),
    literalCatalog: /\/Type\s*\/Catalog\b/.test(names), literalPages: /\/Type\s*\/Pages\b/.test(names),
  };
  return { structure, exactRawRestrictedNames: exact, previousCaseFoldedRawMatches: folded,
    refusedOnlyByPreviousCaseFoldedPredicate: Object.values(structure).every(Boolean) && !exact.length && !!folded.length,
    meaning: "Raw lexical matches only: not a parser determination that an action is present or safe. No stream is skipped or decoded." };
}
const files = execFileSync("git", ["ls-files", "-z", "--", "assets/photos"], { cwd: repository, encoding: "utf8" }).split("\0").filter(Boolean).sort();
assert.ok(files.length > 0, "Original tracked corpus must exist");
const rows = files.map(file => {
  const path = resolve(repository, file); assert.ok(path.startsWith(inputRoot + sep));
  const stat = lstatSync(path); assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Only original regular files may be inspected");
  const extension = extname(file).toLowerCase(), declared = ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".pdf": "application/pdf" } as Record<string, string>)[extension];
  assert.ok(declared, "Unexpected original extension requires explicit inspection");
  const bytes = readFileSync(path), before = sha256(bytes);
  const results = Object.fromEntries(Object.entries({ backend, retained, sqlite }).map(([name, validate]) => {
    try { return [name, { status: 200, mediaType: validate(basename(file), declared, bytes) }]; }
    catch (error) { assert.ok(error && typeof error === "object" && "status" in error); return [name, { status: error.status }]; }
  }));
  assert.deepEqual(results.backend, results.retained, "Provider validation agreement"); assert.deepEqual(results.backend, results.sqlite, "Provider validation agreement");
  assert.equal(sha256(bytes), before, "Validator must not rewrite bytes"); assert.equal(sha256(readFileSync(path)), before, "Original file must stay unchanged");
  return { path: relative(repository, path).replaceAll("\\", "/"), extension, size: bytes.length, sha256: before, preserved: true, results,
    ...(extension === ".pdf" ? { pdf: pdfDiagnostics(bytes) } : {}) };
});
const groups: Record<string, { count: number; accepted: number; refused: number; bytes: number; uniqueHashes: number }> = {};
for (const row of rows) {
  const group = groups[row.extension] ??= { count: 0, accepted: 0, refused: 0, bytes: 0, uniqueHashes: 0 };
  group.count++; group.bytes += row.size; if (row.results.backend!.status === 200) group.accepted++; else group.refused++;
}
for (const [extension, group] of Object.entries(groups)) group.uniqueHashes = new Set(rows.filter(row => row.extension === extension).map(row => row.sha256)).size;
const summary = { inspected: rows.length, accepted: rows.filter(row => row.results.backend!.status === 200).length, refused: rows.filter(row => row.results.backend!.status !== 200).length,
  preserved: rows.filter(row => row.preserved).length, uniqueHashes: new Set(rows.map(row => row.sha256)).size, previousCaseFoldingOnly: rows.filter(row => row.pdf?.refusedOnlyByPreviousCaseFoldedPredicate).length, groups };
const receipt = { inspectionStatus: "PASS", capturedAt: new Date().toISOString(), scope: `${rows.length}-file tracked assets/photos corpus inspection; no authorization or historical parent linkage inferred`, summary,
  securityBoundary: "PDF upload retains its existing lexical profile; rejected bytes can qualify only through the bounded classic-xref fallback with exact direct/scalar-reference stream lengths and restricted semantic names. Office/archive and unsupported previews remain download-only. No original is uploaded, rendered, executed, extracted or persisted to a database.",
  sourceReferences: ["application/controllers/Admincrm.php:852", "application/controllers/Electrical.php:202", "application/controllers/Civil.php:203", "application/controllers/Project_Manager.php:199", "application/controllers/Switchgear.php:202", "application/controllers/Maintenance.php:202", "application/views/quotes/quote_contracting.php:253", "application/controllers/Admincrm.php:1702"],
  parentMapping: "UNVERIFIED. Current PHP upload controllers write uploads/*, which is absent. assets/photos/logo references establish branding; no authoritative original task/log/remote attachment manifest is present for the other files.",
  rows };
mkdirSync(reportDirectory, { recursive: true }); writeFileSync(resolve(reportDirectory, "receipt-private.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ inspectionStatus: receipt.inspectionStatus, report: relative(repository, resolve(reportDirectory, "receipt-private.json")).replaceAll("\\", "/"), summary }, null, 2));
