import { closeSync, openSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DatabaseConfig } from "../config/database";
import { localDirectory, type SqliteDatabase } from "./connection";

export interface SchemaInspection {
  formatVersion: 2;
  inspectedAt: string;
  environment: "development" | "test";
  integrity: "ok";
  foreignKeyViolations: number;
  tables: {
    name: string;
    rowCount: string;
    columns: Record<string, unknown>[];
    foreignKeys: Record<string, unknown>[];
    indexes: Record<string, unknown>[];
  }[];
  limitations: string[];
}

export class SchemaInspectionError extends Error {
  constructor() {
    super("SQLite inspection failed. Check the local database and its integrity; no successful report was produced.");
    this.name = "SchemaInspectionError";
  }
}

/** Read-only, consistent snapshot of metadata/counts. Never exports values/defaults/SQL bodies. */
export function inspectSchema(db: SqliteDatabase, config: Pick<DatabaseConfig, "environment">): SchemaInspection {
  if (!db.readonly || db.pragma("query_only", { simple: true }) !== 1) throw new SchemaInspectionError();
  try {
    return db.transaction((): SchemaInspection => {
      if (db.pragma("quick_check", { simple: true }) !== "ok") throw new SchemaInspectionError();
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all() as { name: string }[];
      return {
        formatVersion: 2,
        inspectedAt: new Date().toISOString(),
        environment: config.environment,
        integrity: "ok",
        foreignKeyViolations: (db.pragma("foreign_key_check") as unknown[]).length,
        tables: tables.map(({ name }) => ({
          name,
          rowCount: (db.prepare('SELECT CAST(COUNT(*) AS TEXT) AS total FROM "' + name.replaceAll('"', '""') + '"').get() as { total: string }).total,
          columns: db.prepare('SELECT cid, name, type, "notnull", pk, hidden FROM pragma_table_xinfo(?)').all(name) as Record<string, unknown>[],
          foreignKeys: db.prepare('SELECT id, seq, "table", "from", "to", on_update, on_delete, match FROM pragma_foreign_key_list(?)').all(name) as Record<string, unknown>[],
          indexes: db.prepare('SELECT seq, name, "unique", origin, partial FROM pragma_index_list(?)').all(name) as Record<string, unknown>[],
        })),
        limitations: [
          "This reports local metadata and aggregate counts, not the provenance of records or CRM feature parity.",
          "Application row values, column defaults, SQL definitions, triggers and view bodies are excluded.",
          "Foreign-key checks cover only constraints actually declared in this database.",
        ],
      };
    })();
  } catch {
    throw new SchemaInspectionError();
  }
}

/** Exclusive private report; every run gets a separate file and never replaces prior evidence. */
export function writeSchemaReport(applicationDirectory: string, report: SchemaInspection): string {
  const directory = localDirectory(applicationDirectory, [".local-data", "reports"], true);
  const filename = join(directory, "schema-" + report.environment + "-" + randomUUID() + ".json");
  const descriptor = openSync(filename, "wx", 0o600);
  try { writeFileSync(descriptor, JSON.stringify(report, null, 2) + "\n", "utf8"); }
  finally { closeSync(descriptor); }
  return filename;
}
