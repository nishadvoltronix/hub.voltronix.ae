/** Read-only audit of the exact previously refused 16 originals. No rendering,
 * parsing actions, login, database, network or source asset writes. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateClassicPdf, PdfProfileError } from "../src/crm/attachments/pdf.js";
import { validateContent as backend } from "../src/crm/attachments/service.js";
import { validateContent as retained } from "../../src/server/attachments/service.js";
import { validateContent as sqlite } from "../../tests/sqlite-reference/attachments/service.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const source = "server/.local-data/reports/original-attachment-corpus-fd393673-a4a9-4064-9136-2b2cd279012f/receipt-private.json";
const metadataSource = "server/.local-data/reports/original-attachment-corpus-85b353a9-3429-44d6-8b29-45404f12e7e1/refused-pdf-characterization-9bebba35-0c43-4986-9f13-0cc3f63af005.json";
type Original = { path: string; extension: string; size: number; sha256: string; results: { backend: { status: number } }; pdf?: unknown };
const baseline = JSON.parse(readFileSync(resolve(root, source), "utf8")) as { rows: Original[] };
const metadata = JSON.parse(readFileSync(resolve(root, metadataSource), "utf8")) as { records: { sha256: string; openAction: boolean; counts: { externalLinks: number } }[] };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const exact = baseline.rows.filter(row => row.extension === ".pdf" && row.results.backend.status !== 200);
assert.equal(exact.length, 16);
const readOriginal = (row: Original) => {
  const path = resolve(root, row.path); assert.ok(path.startsWith(resolve(root, "assets/photos") + sep));
  const stat = lstatSync(path); assert.ok(stat.isFile() && !stat.isSymbolicLink());
  const bytes = readFileSync(path); assert.equal(bytes.length, row.size); assert.equal(hash(bytes), row.sha256); return bytes;
};
function outcome(validate: typeof backend, row: Original, bytes: Buffer) {
  try { assert.equal(validate(basename(row.path), "application/pdf", bytes), "application/pdf"); return 200; }
  catch (error) { assert.ok(error && typeof error === "object" && "status" in error); return error.status; }
}
const rows = exact.map(row => {
  const bytes = readOriginal(row);
  let parser: ReturnType<typeof validateClassicPdf> | { refused: string };
  try { parser = validateClassicPdf(bytes); } catch (error) { assert.ok(error instanceof PdfProfileError); parser = { refused: error.code }; }
  const providers = Object.fromEntries(Object.entries({ backend, retained, sqlite }).map(([name, validate]) => [name, outcome(validate, row, bytes)]));
  assert.equal(providers.backend, providers.retained); assert.equal(providers.backend, providers.sqlite);
  assert.equal(hash(readOriginal(row)), row.sha256);
  const priorMetadata = metadata.records.find(item => item.sha256 === row.sha256); assert.ok(priorMetadata);
  return { path: row.path, sha256: row.sha256, bytes: row.size, priorStatus: 415, providers, parser, priorRawDiagnostic: row.pdf,
    priorIndependentMetadata: { openAction: priorMetadata.openAction, externalLinks: priorMetadata.counts.externalLinks },
    preserved: true };
});
const alreadyAccepted = baseline.rows.filter(row => row.extension === ".pdf" && row.results.backend.status === 200);
for (const row of alreadyAccepted) for (const validate of [backend, retained, sqlite]) assert.equal(outcome(validate, row, readOriginal(row)), 200);
const directory = resolve(root, "server/.local-data/reports", `pdf-secure-compatibility-${randomUUID()}`); mkdirSync(directory, { recursive: true });
const receipt = { capturedAt: new Date().toISOString(), scope: "Exact 16 prior refusals and 17 accepted PDF baseline; read-only originals; no rendering/actions/network/database/authentication",
  profile: "classic-xref-bounded-stream-v1", source: { path: source, sha256: hash(readFileSync(resolve(root, source))) },
  priorIndependentMetadata: { path: metadataSource, sha256: hash(readFileSync(resolve(root, metadataSource))) },
  summary: { examined: rows.length, newlyCompatible: rows.filter(row => row.providers.backend === 200).length, stillRefused: rows.filter(row => row.providers.backend === 415).length,
    priorAcceptedPreserved: alreadyAccepted.length, originalPdfBytesPreserved: rows.length + alreadyAccepted.length }, rows };
writeFileSync(resolve(directory, "receipt-private.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ status: "PASS", receipt: relative(root, resolve(directory, "receipt-private.json")).replaceAll("\\", "/"), summary: receipt.summary }, null, 2));
