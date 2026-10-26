import { createHash } from "node:crypto";
import type { SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { inspectLocalWorkflowExtension } from "./workflow-schema.js";

// Additive policy storage: every original quotation and schema definition stays intact.
// Only an explicit operator call applies this extension; startup only inspects it.
const definitions = [
  `CREATE TABLE crm_demo_percentage_extension (version INTEGER PRIMARY KEY CHECK(version=2), checksum TEXT NOT NULL) STRICT`,
  `CREATE TABLE crm_demo_percentage_quotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL UNIQUE REFERENCES crm_demo_local_tasks(task_id) ON DELETE RESTRICT,
    quote_number TEXT NOT NULL UNIQUE, quotation_json TEXT NOT NULL CHECK(json_valid(quotation_json)),
    totals_json TEXT NOT NULL CHECK(json_valid(totals_json)),
    calculation_policy TEXT NOT NULL CHECK(calculation_policy='percentage-only-v2'),
    version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), issuer_company TEXT, issuer_salesperson TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TRIGGER crm_demo_percentage_quotations_issuer_immutable BEFORE UPDATE OF issuer_company,issuer_salesperson ON crm_demo_percentage_quotations
    WHEN NEW.issuer_company IS NOT OLD.issuer_company OR NEW.issuer_salesperson IS NOT OLD.issuer_salesperson
    BEGIN SELECT RAISE(ABORT,'Quotation issuer snapshot is immutable'); END`,
  `CREATE TRIGGER crm_demo_percentage_quotations_no_legacy BEFORE INSERT ON crm_demo_percentage_quotations
    WHEN EXISTS(SELECT 1 FROM crm_demo_local_quotations WHERE task_id=NEW.task_id OR quote_number=NEW.quote_number)
    BEGIN SELECT RAISE(ABORT,'Historical quotation requires explicit reconciliation'); END`,
  `CREATE TRIGGER crm_demo_percentage_quotations_identity_immutable BEFORE UPDATE OF task_id,quote_number,calculation_policy ON crm_demo_percentage_quotations
    WHEN NEW.task_id IS NOT OLD.task_id OR NEW.quote_number IS NOT OLD.quote_number OR NEW.calculation_policy IS NOT OLD.calculation_policy
    BEGIN SELECT RAISE(ABORT,'Quotation identity and policy are immutable'); END`,
  ...["UPDATE", "DELETE"].map(action => `CREATE TRIGGER crm_demo_percentage_extension_no_${action.toLowerCase()} BEFORE ${action} ON crm_demo_percentage_extension BEGIN SELECT RAISE(ABORT,'Percentage policy provenance is immutable'); END`),
];
const canonical = (sql: string) => sql.trim().replace(/;$/, "");
export const PERCENTAGE_SCHEMA_CHECKSUM = createHash("sha256").update(definitions.join(";\n")).digest("hex");
export const PERCENTAGE_SCHEMA_OBJECTS = definitions.map(sql => ({ name: sql.split(/\s+/)[2]!, sql: canonical(sql) }));
export function inspectPercentageQuotationExtension(db: SqliteDatabase): boolean {
  const rows = db.prepare("SELECT name,sql FROM sqlite_master WHERE name GLOB 'crm_demo_percentage_*'").all() as { name: string; sql: string }[];
  if (!rows.length) return false;
  if (!inspectLocalWorkflowExtension(db) || rows.length !== definitions.length
    || definitions.some(sql => !rows.some(row => canonical(row.sql) === canonical(sql)))) throw new Error("Percentage quotation extension differs from the reviewed schema.");
  const saved = db.prepare("SELECT version,checksum FROM crm_demo_percentage_extension").all() as { version: number; checksum: string }[];
  if (saved.length !== 1 || saved[0]!.version !== 2 || saved[0]!.checksum !== PERCENTAGE_SCHEMA_CHECKSUM) throw new Error("Percentage quotation policy checksum is invalid.");
  return true;
}
export function applyPercentageQuotationExtension(db: SqliteDatabase): { applied: boolean; checksum: string } {
  if (db.readonly || db.inTransaction || db.pragma("foreign_keys", { simple: true }) !== 1 || !inspectLocalWorkflowExtension(db)) throw new Error("Unsafe percentage quotation extension connection.");
  return db.transaction(() => {
    if (inspectPercentageQuotationExtension(db)) return { applied: false, checksum: PERCENTAGE_SCHEMA_CHECKSUM };
    for (const sql of definitions) db.exec(sql);
    // Keep public local quotation IDs distinct from the preserved v1 table.
    db.prepare("INSERT INTO sqlite_sequence(name,seq) SELECT 'crm_demo_percentage_quotations',COALESCE(MAX(id),0) FROM crm_demo_local_quotations").run();
    db.prepare("INSERT INTO crm_demo_percentage_extension(version,checksum) VALUES(2,?)").run(PERCENTAGE_SCHEMA_CHECKSUM);
    inspectPercentageQuotationExtension(db);
    return { applied: true, checksum: PERCENTAGE_SCHEMA_CHECKSUM };
  }).immediate();
}
