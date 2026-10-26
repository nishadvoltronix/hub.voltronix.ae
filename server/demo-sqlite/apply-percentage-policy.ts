import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { openDatabase, type SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { dataRoot, databaseConfig, openDemo, privateDirectory, readPrivate, writePrivateNew } from "./storage.js";
import { applyPercentageQuotationExtension } from "./percentage-schema.js";

const backupName = process.argv[3];
if (process.argv.length !== 4 || process.argv[2] !== "--apply-owner-approved-percentage-v2"
  || !backupName || !/^crm-demo-[0-9a-f-]{36}\.sqlite$/.test(backupName)
  || process.env.CRM_RUNTIME_ENABLE !== undefined || process.env.CRM_RUNTIME_PROFILE !== undefined
  || ["DEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_OPTIONS", "PWDEBUG"].some(key => !!process.env[key])
  || process.execArgv.some(arg => arg.startsWith("--inspect"))) throw new Error("Explicit local percentage policy acknowledgement and verified backup required.");
if (existsSync(join(dataRoot, "launcher.lock"))) throw new Error("Stop the owned SQLite demo before applying the percentage policy.");
for (const port of [3001, 3002]) await new Promise<void>((resolve, reject) => {
  const server = createServer(); server.once("error", () => reject(new Error("Local demo port is still occupied.")));
  server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(error => error ? reject(error) : resolve()));
});
const backup = join(privateDirectory(["backups"]), backupName);
const verified = readPrivate(backup + ".json") as { filename?: string; integrityVerified?: boolean; status?: string };
if (verified.filename !== backup || verified.integrityVerified !== true || verified.status !== "SQLITE_DEMO_BACKUP_CREATED") throw new Error("The selected immutable backup lacks a matching verification receipt.");
function snapshot(db: SqliteDatabase, omitPercentageSequence = false) {
  const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string; sql: string }[];
  return tables.map(table => {
    const rows = db.prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`).all()
      .filter(row => !(omitPercentageSequence && table.name === "sqlite_sequence" && (row as { name?: string }).name === "crm_demo_percentage_quotations"));
    const values = rows.map(row => JSON.stringify(row)).sort();
    return { name: table.name, sql: table.sql, rows: values.length, sha256: createHash("sha256").update(values.join("\n")).digest("hex") };
  });
}
const copy = openDatabase({ ...databaseConfig, filename: backup }, { readonly: true }), db = openDemo();
try {
  if (copy.pragma("integrity_check", { simple: true }) !== "ok" || (copy.pragma("foreign_key_check") as unknown[]).length) throw new Error("Backup integrity failed.");
  const before = snapshot(db);
  if (JSON.stringify(before) !== JSON.stringify(snapshot(copy))) throw new Error("Current database differs from the verified backup; take a fresh backup.");
  const result = applyPercentageQuotationExtension(db), after = snapshot(db);
  const preserved = snapshot(db, true).filter(table => before.some(old => old.name === table.name));
  const expected = before.map(table => table.name === "sqlite_sequence" && !result.applied
    ? snapshot(db, true).find(item => item.name === table.name)! : table);
  if (JSON.stringify(expected) !== JSON.stringify(preserved) || db.pragma("integrity_check", { simple: true }) !== "ok"
    || (db.pragma("foreign_key_check") as unknown[]).length) throw new Error("Percentage extension preservation verification failed; retained state needs review.");
  const directory = privateDirectory(["acceptance"], true), receipt = join(directory, `percentage-policy-${randomUUID()}.json`);
  writePrivateNew(receipt, { status: "PASS", action: "account-owner-approved-percentage-policy-v2", actor: "Account Owner instruction via local operator",
    occurredAt: new Date().toISOString(), backup, ...result, before, after, originalTablesPreserved: true, integrity: "ok", foreignKeyViolations: 0 });
  process.stdout.write(JSON.stringify({ status: "PASS", ...result, receipt, originalTablesPreserved: true }) + "\n");
} finally { copy.close(); db.close(); }
