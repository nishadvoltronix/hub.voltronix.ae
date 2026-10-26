import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { applyCompatibilityPreservingRows, compatibilitySnapshot } from "./attachment-compatibility-preservation.js";
import { access, dataRoot, databaseConfig, privateDirectory, readPrivate, writePrivateNew } from "./storage.js";

export function parseCompatibilityApplyArguments(args: readonly string[], environment: NodeJS.ProcessEnv, execArgs: readonly string[]) {
  assert.equal(args.length, 2); assert.equal(args[0], "--apply-local-attachment-compatibility");
  assert.match(args[1] ?? "", /^crm-demo-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.sqlite$/);
  assert.equal(environment.CRM_RUNTIME_ENABLE, undefined); assert.equal(environment.CRM_RUNTIME_PROFILE, undefined);
  assert.ok(!["DEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_OPTIONS", "PWDEBUG"].some(key => !!environment[key]));
  assert.ok(!execArgs.some(value => value.startsWith("--inspect")));
  return args[1]!;
}

async function apply(args: readonly string[]) {
  const name = parseCompatibilityApplyArguments(args, process.env, process.execArgv);
  assert.ok(!existsSync(join(dataRoot, "launcher.lock")), "Stop the owned demo before the compatibility upgrade");
  const reservations: Server[] = [];
  let committed = false;
  try {
  for (const port of [3001, 3002]) await new Promise<void>((done, fail) => {
    const server = createServer(); server.once("error", () => fail(new Error("Local demo listener is still occupied")));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => { reservations.push(server); done(); });
  });
  access(); // Established private demo provenance; never prints or uses credentials for login.
  const backup = join(privateDirectory(["backups"]), name);
  const metadata = readPrivate(backup + ".json") as { filename: string; status: string; integrityVerified: boolean };
  assert.equal(metadata.filename, backup); assert.equal(metadata.status, "SQLITE_DEMO_BACKUP_CREATED"); assert.equal(metadata.integrityVerified, true);
  const saved = openDatabase({ ...databaseConfig, filename: backup }, { readonly: true });
  const db = openDatabase(databaseConfig);
  try {
    const acceptance = privateDirectory(["acceptance"], true), run = randomUUID();
    const snapshot = compatibilitySnapshot(saved), before = compatibilitySnapshot(db);
    assert.deepEqual(before, snapshot, "Current state differs from the verified backup");
    assert.equal(before.ledger.length, 9, "Only the pending local M10 upgrade is permitted");
    const intentReceipt = join(acceptance, `attachment-compatibility-intent-${run}.json`);
    writePrivateNew(intentReceipt, { status: "INTENT_ONLY", at: new Date().toISOString(), actor: "Account Owner request via local operator",
      action: "Local attachment M9-to-M10 compatibility upgrade; no business/account/session mutations", backup,
      beforeSha256: createHash("sha256").update(JSON.stringify(before)).digest("hex") });
    const result = applyCompatibilityPreservingRows(db, snapshot);
    committed = true;
    const receipt = join(acceptance, `attachment-compatibility-${run}.json`);
    const rows = (snapshot: typeof result.before) => Object.values(snapshot.tables).reduce((sum, table) => sum + table.count, 0);
    const output = { status: "PASS", actor: "Account Owner request via local operator", occurredAt: new Date().toISOString(), backup, intentReceipt,
      reason: "Source-backed local worker upload size compatibility; task and PM limits retained",
      migration: { from: 9, to: 10, added: result.after.ledger[9] },
      before: { tableCount: Object.keys(result.before.tables).length, rows: rows(result.before) },
      after: { tableCount: Object.keys(result.after.tables).length, rows: rows(result.after) },
      tablesPreserved: Object.keys(result.before.tables).filter(table => table !== "crm_schema_migrations"),
      originalMigrationRowsPreserved: true, originalRowidsAndBlobsPreserved: true, sessionsAndLoginAttemptsPreserved: true,
      authenticationAttempts: 0, businessWrites: 0, integrity: "ok", foreignKeyViolations: 0,
      schemaBefore: result.before.schema.filter(row => row.tbl_name === "crm_department_log_attachments"),
      schemaAfter: result.after.schema.filter(row => row.tbl_name === "crm_department_log_attachments") };
    writePrivateNew(receipt, output);
    return { ...output, schemaBefore: undefined, schemaAfter: undefined, tablesPreserved: output.tablesPreserved.length, receipt };
  } finally { saved.close(); db.close(); }
  } catch (error) {
    if (committed) throw new Error("M10 COMMITTED but completion evidence could not be written. Preserve the intent receipt; inspect read-only and do not retry blindly.", { cause: error });
    throw error;
  } finally {
    await Promise.all(reservations.map(server => new Promise<void>(done => server.close(() => done()))));
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await apply(process.argv.slice(2)))); }
  catch (error) { console.error("Local attachment upgrade did not complete its verified evidence sequence; inspect the outcome below.");
    console.error(error instanceof Error ? error.message : "Unknown error"); process.exitCode = 1; }
}
