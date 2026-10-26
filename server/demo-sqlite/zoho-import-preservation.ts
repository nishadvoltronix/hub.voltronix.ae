import { createHash } from "node:crypto";
import type { SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { inspectZohoImportExtension, ZOHO_IMPORT_SCHEMA_OBJECTS } from "./zoho-import-store.js";

const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_key, item: unknown) =>
  typeof item === "bigint" ? { bigint: item.toString() } : item)).digest("hex");
function rows(db: SqliteDatabase, table: string) {
  const result = new Map<string, number>();
  for (const row of db.prepare(`SELECT * FROM ${quote(table)}`).safeIntegers(true).all()) {
    const key = digest(row); result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}
/** Captures hashes only. Every old row (including hashes, grants, sessions) must
 * survive byte-for-byte. Only the three import targets may gain business rows. */
export function captureImportPreservation(db: SqliteDatabase) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all() as
    { type: string; name: string; tbl_name: string; sql: string | null }[];
  const tables = schema.filter(row => row.type === "table" && row.name !== "sqlite_sequence")
    .map(row => ({ name: row.name, rows: rows(db, row.name) }));
  const sequence = () => {
    const values = db.prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name").safeIntegers(true).all() as { name: string; seq: bigint }[];
    if (values.some(value => typeof value.name !== "string" || typeof value.seq !== "bigint" || value.seq < 0n)
      || new Set(values.map(value => value.name)).size !== values.length) throw new Error("Invalid SQLite sequence state.");
    return values;
  };
  const previousSequences = sequence();
  return () => {
    const currentSchema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all() as typeof schema;
    const added = currentSchema.filter(current => !schema.some(old => old.type === current.type && old.name === current.name));
    for (const item of added) {
      const expected = ZOHO_IMPORT_SCHEMA_OBJECTS.find(object => object.name === item.name);
      const knownIndex = item.type === "index" && item.sql === null &&
        ((item.tbl_name === "crm_demo_zoho_import_runs" && item.name === "sqlite_autoindex_crm_demo_zoho_import_runs_1")
          || (item.tbl_name === "crm_demo_zoho_import_records" && ["sqlite_autoindex_crm_demo_zoho_import_records_1", "sqlite_autoindex_crm_demo_zoho_import_records_2"].includes(item.name)));
      if (!knownIndex && (!expected || item.type !== expected.sql.split(/\s+/)[1]!.toLowerCase()
        || item.sql?.trim().replace(/;$/, "") !== expected.sql)) throw new Error("Unreviewed schema object added.");
    }
    if (added.length && !inspectZohoImportExtension(db)) throw new Error("Import schema is incomplete.");
    for (const old of schema) {
      const current = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type=? AND name=?").get(old.type, old.name);
      if (digest(old) !== digest(current)) throw new Error("Pre-import schema changed.");
    }
    for (const table of tables) {
      const current = rows(db, table.name);
      for (const [key, count] of table.rows) if (current.get(key) !== count) throw new Error("Pre-import row changed.");
      if (!["tasks", "products", "job_notes", "crm_demo_zoho_import_runs", "crm_demo_zoho_import_records"].includes(table.name)
        && digest([...current].sort()) !== digest([...table.rows].sort())) {
        throw new Error("Unrelated local table changed.");
      }
    }
    const currentSequences = sequence();
    for (const previous of previousSequences) {
      const current = currentSequences.find(value => value.name === previous.name);
      if (!current || (["tasks", "job_notes"].includes(previous.name) ? current.seq < previous.seq : current.seq !== previous.seq)) {
        throw new Error("Unrelated sequence changed.");
      }
    }
    if (currentSequences.some(current => !previousSequences.some(previous => previous.name === current.name)
      && !["tasks", "job_notes"].includes(current.name))) throw new Error("Unrelated sequence added.");
    if (db.pragma("integrity_check", { simple: true }) !== "ok" || (db.pragma("foreign_key_check") as unknown[]).length) {
      throw new Error("Imported database integrity failed.");
    }
  };
}
