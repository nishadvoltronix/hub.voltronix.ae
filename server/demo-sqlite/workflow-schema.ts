import { createHash } from "node:crypto";
import type { SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { assertMigrationsCurrent } from "../../tests/sqlite-reference/db/migrations.js";
import { validateLocalQuotationIssuer, type LocalQuotationIssuer } from "../src/crm/quotation-pdf/render.js";

// This extension is deliberately outside the nine frozen reference migrations.
// Runtime construction only inspects it. An operator must explicitly apply it to
// the guarded demo database after reviewing this source and taking a backup.
const definitions = [
  `CREATE TABLE crm_demo_local_extension (version INTEGER PRIMARY KEY CHECK(version=1), checksum TEXT NOT NULL) STRICT`,
  `CREATE TABLE crm_demo_local_issuer (id INTEGER PRIMARY KEY CHECK(id=1), company TEXT NOT NULL,
    salesperson TEXT NOT NULL, CHECK(company IN ('VOLTRONIX CONTRACTING LLC','VOLTRONIX SWITCHGEAR LLC'))) STRICT`,
  `CREATE TABLE crm_demo_local_tasks (
    task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE RESTRICT,
    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    creation_operation_id TEXT NOT NULL UNIQUE REFERENCES crm_demo_local_operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
    customer_department TEXT NOT NULL CHECK(customer_department IN ('VOLTRONIX CONTRACTING LLC','VOLTRONIX SWITCHGEAR LLC')),
    input_json TEXT NOT NULL CHECK(json_valid(input_json)), created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE crm_demo_local_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES crm_demo_local_tasks(task_id) ON DELETE RESTRICT,
    title TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE crm_demo_local_quotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL UNIQUE REFERENCES crm_demo_local_tasks(task_id) ON DELETE RESTRICT,
    quote_number TEXT NOT NULL UNIQUE, quotation_json TEXT NOT NULL CHECK(json_valid(quotation_json)),
    totals_json TEXT NOT NULL CHECK(json_valid(totals_json)),
    calculation_policy TEXT NOT NULL CHECK(calculation_policy='percentage-create-v1'),
    version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), issuer_company TEXT, issuer_salesperson TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE crm_demo_local_operations (
    operation_id TEXT PRIMARY KEY, actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    task_id INTEGER NOT NULL REFERENCES crm_demo_local_tasks(task_id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK(kind IN ('deal.create','lead.stage','note.create','note.edit','quote.create','quote.edit')),
    request_hash TEXT NOT NULL CHECK(length(request_hash)=64), state TEXT NOT NULL CHECK(state='completed'),
    remote_effect_possible INTEGER NOT NULL DEFAULT 0 CHECK(remote_effect_possible=0),
    remote_references TEXT NOT NULL DEFAULT '{}' CHECK(remote_references='{}'),
    result_json TEXT NOT NULL CHECK(json_valid(result_json)), created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE crm_demo_local_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE REFERENCES crm_demo_local_operations(operation_id) ON DELETE RESTRICT,
    actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    task_id INTEGER NOT NULL REFERENCES crm_demo_local_tasks(task_id) ON DELETE RESTRICT,
    action TEXT NOT NULL, changed_fields TEXT NOT NULL CHECK(json_valid(changed_fields)), occurred_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TRIGGER crm_demo_local_quotations_issuer_immutable BEFORE UPDATE OF issuer_company,issuer_salesperson ON crm_demo_local_quotations
    WHEN NEW.issuer_company IS NOT OLD.issuer_company OR NEW.issuer_salesperson IS NOT OLD.issuer_salesperson
    BEGIN SELECT RAISE(ABORT,'Quotation issuer snapshot is immutable'); END`,
  ...["extension", "issuer", "tasks", "operations", "audit"].flatMap(table => ["UPDATE", "DELETE"].map(action =>
    `CREATE TRIGGER crm_demo_local_${table}_no_${action.toLowerCase()} BEFORE ${action} ON crm_demo_local_${table} BEGIN SELECT RAISE(ABORT,'Local provenance is immutable'); END`)),
];
const canonical = (sql: string) => sql.trim().replace(/;$/, "");
export const LOCAL_WORKFLOW_SCHEMA_CHECKSUM = createHash("sha256").update(definitions.join(";\n")).digest("hex");
export const LOCAL_WORKFLOW_SCHEMA_OBJECTS = definitions.map(sql => ({
  type: sql.startsWith("CREATE TABLE") ? "table" as const : "trigger" as const,
  name: sql.split(/\s+/)[2]!, sql: canonical(sql),
}));

/** False means entirely absent. Partial, foreign or altered objects are errors. */
export function inspectLocalWorkflowExtension(db: SqliteDatabase): boolean {
  const rows = db.prepare("SELECT name,sql FROM sqlite_master WHERE name GLOB 'crm_demo_local_*' ORDER BY name").all() as { name: string; sql: string }[];
  if (!rows.length) return false;
  if (rows.length !== definitions.length || definitions.some(sql => !rows.some(row => canonical(row.sql) === canonical(sql)))) {
    throw new Error("SQLite local workflow extension is incomplete or differs from the reviewed schema.");
  }
  const saved = db.prepare("SELECT version,checksum FROM crm_demo_local_extension").all() as { version: number; checksum: string }[];
  if (saved.length !== 1 || saved[0]!.version !== 1 || saved[0]!.checksum !== LOCAL_WORKFLOW_SCHEMA_CHECKSUM) {
    throw new Error("SQLite local workflow extension checksum is invalid.");
  }
  return true;
}

/** Explicit apply only: never called by initialization, start, or constructors. */
export function applyLocalWorkflowExtension(db: SqliteDatabase, issuer?: LocalQuotationIssuer): { applied: boolean; checksum: string } {
  assertMigrationsCurrent(db);
  if (issuer) validateLocalQuotationIssuer(issuer);
  if (db.readonly || db.inTransaction || db.pragma("foreign_keys", { simple: true }) !== 1) throw new Error("Unsafe SQLite extension connection.");
  return db.transaction(() => {
    if (inspectLocalWorkflowExtension(db)) {
      if (issuer) {
        const saved = db.prepare("SELECT company,salesperson FROM crm_demo_local_issuer WHERE id=1").get() as LocalQuotationIssuer | undefined;
        if (!saved || saved.company !== issuer.company || saved.salesperson !== issuer.salesperson) throw new Error("Existing local issuer configuration cannot be replaced or retrofitted.");
      }
      return { applied: false, checksum: LOCAL_WORKFLOW_SCHEMA_CHECKSUM };
    }
    for (const sql of definitions) db.exec(sql);
    db.prepare("INSERT INTO crm_demo_local_extension(version,checksum) VALUES(1,?)").run(LOCAL_WORKFLOW_SCHEMA_CHECKSUM);
    if (issuer) db.prepare("INSERT INTO crm_demo_local_issuer(id,company,salesperson) VALUES(1,?,?)").run(issuer.company, issuer.salesperson);
    inspectLocalWorkflowExtension(db);
    return { applied: true, checksum: LOCAL_WORKFLOW_SCHEMA_CHECKSUM };
  }).immediate();
}
