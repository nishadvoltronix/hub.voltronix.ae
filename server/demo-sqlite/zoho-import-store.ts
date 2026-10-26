import { createHash } from "node:crypto";
import { z } from "zod";
import type { SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { assertMigrationsCurrent } from "../../tests/sqlite-reference/db/migrations.js";

const identifier = z.string().regex(/^[1-9][0-9]{0,29}$/);
const localId = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => BigInt(value) <= 9_223_372_036_854_775_807n);
const text = (max: number) => z.string().max(max).refine(value => !value.includes("\0"));
const timestamp = z.iso.datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)));
const date = z.union([timestamp, z.iso.date()]);
const money = z.string().regex(/^-?(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,18})?$/);
const localMoney = /^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$/;
const lookup = z.object({ externalId: identifier, name: text(200) }).strict().nullable();
const common = { externalId: identifier, createdAt: timestamp, modifiedAt: timestamp,
  missingOptionalFields: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/)).max(50) };
const productSchema = z.object({ ...common, name: text(2000).min(1), description: text(100_000).nullable(), unitPrice: money.nullable() }).strict();
const dealSchema = z.object({ ...common, name: text(200).min(1), stage: text(100).min(1), applicationStatus: text(100).nullable(),
  amount: money.nullable(), account: lookup, contact: lookup, owner: lookup, assignedTo: lookup, createdBy: lookup,
  dealNumber: text(200).nullable(), enquiryNumber: text(200).nullable(), qualificationNumber: text(200).nullable(),
  siteNumber: text(200).nullable(), quotationNumber: text(200).nullable(), jobNumber: text(200).nullable(), lostNumber: text(200).nullable(),
  qualificationDate: date.nullable(), siteDate: date.nullable(), quotationDate: date.nullable(), jobDate: date.nullable(), lostDate: date.nullable(),
  email: text(254).nullable(), phone: text(100).nullable(), mobile: text(100).nullable(), address: text(2_000).nullable(),
  description: text(100_000).nullable(), department: text(200).nullable(), poBox: text(200).nullable(), trn: text(200).nullable() }).strict();
const noteSchema = z.object({ ...common, dealId: identifier, title: text(200).nullable(), content: text(100_000).nullable(), createdBy: lookup }).strict();
const snapshotSchema = z.object({ organizationId: identifier, capturedAt: timestamp, products: z.array(productSchema).max(20_000),
  deals: z.array(dealSchema).max(20_000), notes: z.array(noteSchema).max(20_000), complete: z.literal(true), snapshotConsistent: z.literal(false),
  deletionsVerified: z.literal(false), richTextCompletenessVerified: z.literal(false),
  excludedNoteCounts: z.object({ otherModules: z.number().int().min(0).max(20_000), unavailableDeals: z.number().int().min(0).max(20_000) }).strict(),
  excludedScopes: z.tuple([z.literal("Quotes"), z.literal("Attachments"), z.literal("Users"), z.literal("Accounts"), z.literal("Contacts"),
    z.literal("Deleted records"), z.literal("History")]), requestsPerformed: z.number().int().min(0).max(10_000) }).strict();
type Snapshot = z.infer<typeof snapshotSchema>;
type Module = "Products" | "Deals" | "Notes";
type Row = Record<string, string | number | null>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const canonical = (value: string) => value.trim().replace(/;$/, "");
const definitions = [
  `CREATE TABLE crm_demo_zoho_import_extension (version INTEGER PRIMARY KEY CHECK(version=1), checksum TEXT NOT NULL, organization_id TEXT NOT NULL) STRICT`,
  `CREATE TABLE crm_demo_zoho_import_runs (run_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),
    plan_hash TEXT NOT NULL CHECK(length(plan_hash)=64), imported_at TEXT NOT NULL, counts_json TEXT NOT NULL CHECK(json_valid(counts_json))) STRICT`,
  `CREATE TABLE crm_demo_zoho_import_records (organization_id TEXT NOT NULL, module TEXT NOT NULL CHECK(module IN ('Products','Deals','Notes')),
    external_id TEXT NOT NULL, local_id TEXT NOT NULL, source_hash TEXT NOT NULL CHECK(length(source_hash)=64), local_hash TEXT NOT NULL CHECK(length(local_hash)=64),
    source_created_at TEXT NOT NULL, source_modified_at TEXT NOT NULL, source_json TEXT NOT NULL CHECK(json_valid(source_json)),
    run_id TEXT NOT NULL REFERENCES crm_demo_zoho_import_runs(run_id) ON DELETE RESTRICT,
    PRIMARY KEY(organization_id,module,external_id), UNIQUE(module,local_id)) STRICT`,
  `CREATE TRIGGER crm_demo_zoho_import_runs_source BEFORE INSERT ON crm_demo_zoho_import_runs
    WHEN NOT EXISTS(SELECT 1 FROM crm_demo_zoho_import_extension WHERE organization_id=NEW.organization_id)
    BEGIN SELECT RAISE(ABORT,'Zoho import source differs'); END`,
  `CREATE TRIGGER crm_demo_zoho_import_records_source BEFORE INSERT ON crm_demo_zoho_import_records
    WHEN NOT EXISTS(SELECT 1 FROM crm_demo_zoho_import_extension e JOIN crm_demo_zoho_import_runs r ON r.organization_id=e.organization_id
      WHERE e.organization_id=NEW.organization_id AND r.run_id=NEW.run_id)
    BEGIN SELECT RAISE(ABORT,'Zoho import source differs'); END`,
  ...["extension", "runs", "records"].flatMap(table => ["UPDATE", "DELETE"].map(action =>
    `CREATE TRIGGER crm_demo_zoho_import_${table}_no_${action.toLowerCase()} BEFORE ${action} ON crm_demo_zoho_import_${table} BEGIN SELECT RAISE(ABORT,'Zoho import provenance is immutable'); END`)),
  ...([{ table: "products", module: "Products", key: "product_id" }, { table: "tasks", module: "Deals", key: "id" },
    { table: "job_notes", module: "Notes", key: "id" }] as const).flatMap(item => ["UPDATE", "DELETE"].map(action =>
      `CREATE TRIGGER crm_demo_zoho_import_${item.table}_no_${action.toLowerCase()} BEFORE ${action} ON ${item.table}
       WHEN EXISTS(SELECT 1 FROM crm_demo_zoho_import_records WHERE module='${item.module}' AND local_id=CAST(OLD.${item.key} AS TEXT))
       BEGIN SELECT RAISE(ABORT,'Imported Zoho records are read-only'); END`)),
];
export const ZOHO_IMPORT_SCHEMA_CHECKSUM = createHash("sha256").update(definitions.join(";\n")).digest("hex");
export const ZOHO_IMPORT_SCHEMA_OBJECTS = Object.freeze(definitions.map(sql => Object.freeze({ name: sql.split(/\s+/)[2]!, sql: canonical(sql) })));
export class ZohoSqliteImportError extends Error {
  constructor(readonly code: "INPUT_INVALID" | "SCHEMA_INVALID" | "SOURCE_MISMATCH" | "PLAN_STALE" | "APPLY_FAILED") {
    super(`Zoho SQLite import ${code}. No overwrite or automatic repair was attempted.`); this.name = "ZohoSqliteImportError";
  }
}
function fail(code: ZohoSqliteImportError["code"]): never { throw new ZohoSqliteImportError(code); }
export function inspectZohoImportExtension(db: SqliteDatabase): boolean {
  try {
    const rows = db.prepare("SELECT name,sql FROM sqlite_master WHERE name GLOB 'crm_demo_zoho_import_*' ORDER BY name").all() as { name: string; sql: string }[];
    if (!rows.length) return false;
    if (rows.length !== definitions.length || definitions.some(sql => !rows.some(row => canonical(row.sql) === canonical(sql)))) return fail("SCHEMA_INVALID");
    const saved = db.prepare("SELECT version,checksum,organization_id FROM crm_demo_zoho_import_extension").all() as Row[];
    if (saved.length !== 1 || saved[0]!.version !== 1 || saved[0]!.checksum !== ZOHO_IMPORT_SCHEMA_CHECKSUM
      || !identifier.safeParse(saved[0]!.organization_id).success) return fail("SCHEMA_INVALID");
    return true;
  } catch (error) { throw error instanceof ZohoSqliteImportError ? error : new ZohoSqliteImportError("SCHEMA_INVALID"); }
}
function source(db: SqliteDatabase, organizationId: string, required = false): boolean {
  if (!inspectZohoImportExtension(db)) { if (required) return fail("SCHEMA_INVALID"); return false; }
  const row = db.prepare("SELECT organization_id FROM crm_demo_zoho_import_extension").get() as Row;
  if (row.organization_id !== organizationId) return fail("SOURCE_MISMATCH");
  return true;
}
function connection(db: SqliteDatabase, writable = false) {
  if (db.inTransaction || db.pragma("foreign_keys", { simple: true }) !== 1 || writable && (db.readonly || db.pragma("query_only", { simple: true }) === 1)) return fail("SCHEMA_INVALID");
  assertMigrationsCurrent(db);
}
/** Explicit reviewed extension only. Never called by normal startup or prepare. */
export function applyZohoImportExtension(db: SqliteDatabase, input: { organizationId: string }): { applied: boolean; checksum: string } {
  try {
    const { organizationId } = z.object({ organizationId: identifier }).strict().parse(input); connection(db, true);
    return db.transaction(() => {
      if (source(db, organizationId)) return { applied: false, checksum: ZOHO_IMPORT_SCHEMA_CHECKSUM };
      for (const sql of definitions) db.exec(sql);
      db.prepare("INSERT INTO crm_demo_zoho_import_extension(version,checksum,organization_id) VALUES(1,?,?)").run(ZOHO_IMPORT_SCHEMA_CHECKSUM, organizationId);
      source(db, organizationId, true); return { applied: true, checksum: ZOHO_IMPORT_SCHEMA_CHECKSUM };
    }).immediate();
  } catch (error) { throw error instanceof ZohoSqliteImportError ? error : new ZohoSqliteImportError("SCHEMA_INVALID"); }
}

export interface ZohoImportCounts { received: number; insert: number; alreadyImported: number; skipped: number; conflicts: number }
export interface ZohoSqliteImportSummary {
  Products: ZohoImportCounts; Deals: ZohoImportCounts; Notes: ZohoImportCounts;
  reasons: Record<string, number>; warnings: Record<string, number>;
}
export interface ZohoSqliteImportPlan { readonly snapshotHash: string; readonly summary: Readonly<ZohoSqliteImportSummary> }
export interface ZohoSqliteImportReceipt { runId: string; snapshotHash: string; summary: ZohoSqliteImportSummary; replayed: boolean }
const mappingSchema = z.object({ userMappings: z.array(z.object({ externalId: identifier, localUserId: localId }).strict()).max(2000) }).strict();
type Options = z.infer<typeof mappingSchema>;
type Decision = { module: Module; externalId: string; outcome: "insert" | "alreadyImported" | "skipped" | "conflicts";
  reason?: string; sourceHash: string; sourceJson: string; row?: Row; localId?: string; evidence?: unknown; createdAt: string; modifiedAt: string };
type Prepared = { db: SqliteDatabase; snapshot: Snapshot; options: Options; signature: string };
const prepared = new WeakMap<object, Prepared>();
function validate(input: unknown, options: unknown): { snapshot: Snapshot; options: Options } {
  try {
    const snapshot = snapshotSchema.parse(input), parsedOptions = mappingSchema.parse(options);
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > 20 * 1024 * 1024) return fail("INPUT_INVALID");
    for (const records of [snapshot.products, snapshot.deals, snapshot.notes]) {
      if (new Set(records.map(row => row.externalId)).size !== records.length
        || records.some(row => Date.parse(row.createdAt) > Date.parse(row.modifiedAt))) return fail("INPUT_INVALID");
    }
    const deals = new Set(snapshot.deals.map(row => row.externalId));
    if (snapshot.notes.some(row => !deals.has(row.dealId))) return fail("INPUT_INVALID");
    if (new Set(parsedOptions.userMappings.map(row => row.externalId)).size !== parsedOptions.userMappings.length
      || new Set(parsedOptions.userMappings.map(row => row.localUserId)).size !== parsedOptions.userMappings.length) return fail("INPUT_INVALID");
    return { snapshot, options: parsedOptions };
  } catch (error) { throw error instanceof ZohoSqliteImportError ? error : new ZohoSqliteImportError("INPUT_INVALID"); }
}
function stage(deal: Snapshot["deals"][number]): string | undefined {
  const mappings: Record<string, { local: string; statuses: string[] }> = {
    Qualification: { local: "Pending", statuses: ["Pending", "Qualification"] },
    "Needs Analysis": { local: "Site Visit", statuses: ["Site Visit"] },
    "Site Visit": { local: "Site Visit", statuses: ["Site Visit"] },
    "Proposal/Price Quote": { local: "Proposal/Price Quote", statuses: ["Proposal", "Proposal/Price Quote"] },
    "Closed Won": { local: "Closed Won", statuses: ["Close to Won", "Closed Won"] },
    "Closed Lost": { local: "Closed Lost", statuses: ["Close to Lost", "Closed Lost"] },
  };
  const mapped = Object.hasOwn(mappings, deal.stage) ? mappings[deal.stage] : undefined;
  return mapped && (deal.applicationStatus === null || mapped.statuses.includes(deal.applicationStatus)) ? mapped.local : undefined;
}
const targets = { Products: { table: "products", key: "product_id" }, Deals: { table: "tasks", key: "zoho_crm_id" }, Notes: { table: "job_notes", key: "zoho_note_id" } } as const;
function assess(db: SqliteDatabase, snapshot: Snapshot, options: Options) {
  const hasExtension = source(db, snapshot.organizationId);
  const counts = (received: number): ZohoImportCounts => ({ received, insert: 0, alreadyImported: 0, skipped: 0, conflicts: 0 });
  const summary: ZohoSqliteImportSummary = { Products: counts(snapshot.products.length), Deals: counts(snapshot.deals.length), Notes: counts(snapshot.notes.length), reasons: {}, warnings: {} };
  const decisions: Decision[] = [], eligibleDeals = new Set<string>(), bindings: Row[] = [];
  const users = new Map<string, string>();
  for (const mapping of options.userMappings) {
    const user = db.prepare("SELECT CAST(id AS TEXT) id,user_id,status FROM users WHERE id=?").get(mapping.localUserId) as Row | undefined;
    bindings.push({ externalId: mapping.externalId, localUserId: mapping.localUserId, observedId: typeof user?.user_id === "string" ? user.user_id : null,
      status: typeof user?.status === "string" ? user.status : null });
    if (user?.user_id === mapping.externalId && user.status === "active") users.set(mapping.externalId, mapping.localUserId);
  }
  function add(module: Module, record: { externalId: string; createdAt: string; modifiedAt: string; missingOptionalFields: string[] }, row?: Row, reason?: string) {
    const decision: Decision = { module, externalId: record.externalId, createdAt: record.createdAt, modifiedAt: record.modifiedAt,
      sourceHash: hash(record), sourceJson: JSON.stringify(record), outcome: reason ? "skipped" : "insert", ...(reason ? { reason } : {}), ...(row ? { row } : {}) };
    if (record.missingOptionalFields.length) summary.warnings.SOURCE_OPTIONAL_FIELDS_MISSING = (summary.warnings.SOURCE_OPTIONAL_FIELDS_MISSING ?? 0) + 1;
    const target = targets[module], exists = db.prepare(`SELECT ${module === "Products" ? "product_id" : "CAST(id AS TEXT)"} id FROM ${target.table} WHERE ${target.key}=?`).get(record.externalId) as { id: string } | undefined;
    const ledger = hasExtension ? db.prepare("SELECT * FROM crm_demo_zoho_import_records WHERE organization_id=? AND module=? AND external_id=?")
      .get(snapshot.organizationId, module, record.externalId) as Row | undefined : undefined;
    if (ledger || exists) {
      decision.outcome = "conflicts";
      decision.reason = !ledger ? "PREEXISTING_RECORD" : !exists || ledger.local_id !== exists.id ? "LOCAL_IDENTITY_CHANGED" : ledger.source_hash !== decision.sourceHash ? "SOURCE_CHANGED" : !row ? reason : undefined;
      if (row && ledger && exists && !decision.reason) {
        const saved = db.prepare(`SELECT ${Object.keys(row).map(key => key === "deal_crm_created_by" ? "CAST(deal_crm_created_by AS TEXT) deal_crm_created_by" : key).join(",")} FROM ${target.table} WHERE ${target.key}=?`).get(record.externalId) as Row;
        const localHash = hash(saved);
        if (ledger.local_hash !== localHash || hash(row) !== localHash) decision.reason = "LOCAL_RECORD_CHANGED";
        else { decision.outcome = "alreadyImported"; decision.localId = exists.id; }
        decision.evidence = { ledger, saved };
      } else decision.evidence = { ledger: ledger ?? null, exists: exists ?? null };
    }
    summary[module][decision.outcome]++;
    if (decision.reason) summary.reasons[decision.reason] = (summary.reasons[decision.reason] ?? 0) + 1;
    decisions.push(decision);
    if (module === "Deals" && ["insert", "alreadyImported"].includes(decision.outcome)) eligibleDeals.add(record.externalId);
  }
  for (const product of snapshot.products) add("Products", product,
    { product_id: product.externalId, product_name: product.name, description: product.description, unit_price: product.unitPrice,
      version: 1, created_at: product.createdAt, updated_at: product.modifiedAt },
    product.unitPrice !== null && !localMoney.test(product.unitPrice) ? "LOCAL_AMOUNT_UNSUPPORTED" : undefined);
  for (const deal of snapshot.deals) {
    const mappedStage = stage(deal), status = mappedStage ?? deal.stage, assigned = deal.assignedTo?.externalId;
    const warning = !assigned ? "ASSIGNEE_ABSENT" : !users.has(assigned) ? "ASSIGNEE_UNMAPPED" : undefined;
    if (warning) summary.warnings[warning] = (summary.warnings[warning] ?? 0) + 1;
    if (!mappedStage) summary.warnings.STAGE_UNMAPPED = (summary.warnings.STAGE_UNMAPPED ?? 0) + 1;
    const reason = deal.amount !== null && !localMoney.test(deal.amount) ? "LOCAL_AMOUNT_UNSUPPORTED" : undefined;
    add("Deals", deal, reason ? undefined : { zoho_crm_id: deal.externalId, assigned_to: assigned && users.has(assigned) ? assigned : null, owner_id: deal.owner?.externalId ?? null,
      deal_crm_created_by: null, deal_name: deal.name, status: status!, account_name: deal.account?.name ?? null, customer_name: deal.contact?.name ?? null,
      customer_email: deal.email, customer_contact: deal.phone, address: deal.address, remark: deal.description, complaint_info: deal.description,
      deal_number: deal.dealNumber, enq_number: deal.enquiryNumber, qual_deal_number: deal.qualificationNumber, site_deal_number: deal.siteNumber,
      quote_deal_number: deal.quotationNumber, job_deal_number: deal.jobNumber, lost_deal_number: deal.lostNumber,
      qual_deal_date: deal.qualificationDate, site_deal_date: deal.siteDate, quote_deal_date: deal.quotationDate, job_deal_date: deal.jobDate, lost_deal_date: deal.lostDate,
      service_charge: deal.amount, p_box: deal.poBox, trn: deal.trn, version: 1, created_at: deal.createdAt, updated_at: deal.modifiedAt }, reason);
  }
  for (const note of snapshot.notes) {
    const textUnavailable = note.missingOptionalFields.includes("Note_Title") || note.missingOptionalFields.includes("Note_Content");
    const reason = !eligibleDeals.has(note.dealId) ? "PARENT_NOT_IMPORTED" : textUnavailable ? "NOTE_CONTENT_UNAVAILABLE" : undefined;
    if (!reason && (note.title === null || note.content === null)) {
      summary.warnings.NOTE_NULL_TEXT_AS_EMPTY = (summary.warnings.NOTE_NULL_TEXT_AS_EMPTY ?? 0) + 1;
    }
    add("Notes", note, reason ? undefined : { zoho_note_id: note.externalId, deal_id: note.dealId, note_title: note.title ?? "", note_content: note.content ?? "",
      created_at: note.createdAt, updated_at: note.modifiedAt }, reason);
  }
  return { summary, decisions, signature: hash({ bindings, decisions }) };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
/** Reads only current identities/provenance and candidate target rows. No user,
 * permission, business row or schema is written; raw customer values stay private. */
export function prepareZohoSqliteImport(db: SqliteDatabase, input: unknown, inputOptions: Options): ZohoSqliteImportPlan {
  try {
    connection(db); const { snapshot, options } = validate(input, inputOptions);
    const assessment = db.transaction(() => assess(db, snapshot, options))();
    const plan = freeze({ snapshotHash: hash(snapshot), summary: assessment.summary });
    prepared.set(plan, { db, snapshot: freeze(snapshot), options: freeze(options), signature: assessment.signature }); return plan;
  } catch (error) { throw error instanceof ZohoSqliteImportError ? error : new ZohoSqliteImportError("SCHEMA_INVALID"); }
}
/** Apply only a plan created in this process for this connection. Re-evaluate
 * under one immediate transaction; no networking, overwrite, delete or retry. */
export function applyZohoSqliteImport(db: SqliteDatabase, plan: ZohoSqliteImportPlan,
  input: { runId: string; importedAt: string }, dependencies: { verify?: () => void } = {}): ZohoSqliteImportReceipt {
  try {
    const value = z.object({ runId: z.uuid(), importedAt: timestamp }).strict().parse(input), selected = prepared.get(plan);
    if (!selected || selected.db !== db || dependencies.verify !== undefined && typeof dependencies.verify !== "function") return fail("INPUT_INVALID"); connection(db, true);
    const planHash = hash({ snapshotHash: plan.snapshotHash, options: selected.options });
    // Trusted synchronous assertion hook for the operator's preservation/FK
    // checks. Its failure rolls back every business row and receipt in this run.
    const verify = () => { if (dependencies.verify?.() !== undefined) return fail("APPLY_FAILED"); };
    return db.transaction(() => {
      source(db, selected.snapshot.organizationId, true);
      const previous = db.prepare("SELECT organization_id,snapshot_hash,plan_hash,counts_json FROM crm_demo_zoho_import_runs WHERE run_id=?").get(value.runId) as Row | undefined;
      if (previous) {
        if (previous.organization_id !== selected.snapshot.organizationId || previous.snapshot_hash !== plan.snapshotHash || previous.plan_hash !== planHash) return fail("PLAN_STALE");
        verify();
        return { runId: value.runId, snapshotHash: plan.snapshotHash, summary: JSON.parse(String(previous.counts_json)) as ZohoSqliteImportSummary, replayed: true };
      }
      const current = assess(db, selected.snapshot, selected.options);
      if (current.signature !== selected.signature) return fail("PLAN_STALE");
      db.prepare("INSERT INTO crm_demo_zoho_import_runs(run_id,organization_id,snapshot_hash,plan_hash,imported_at,counts_json) VALUES(?,?,?,?,?,?)")
        .run(value.runId, selected.snapshot.organizationId, plan.snapshotHash, planHash, value.importedAt, JSON.stringify(current.summary));
      for (const item of current.decisions) {
        if (item.outcome !== "insert" || !item.row) continue;
        const columns = Object.keys(item.row), target = targets[item.module];
        const result = db.prepare(`INSERT INTO ${target.table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).safeIntegers(true).run(...Object.values(item.row));
        if (result.changes !== 1) return fail("APPLY_FAILED");
        const id = item.module === "Products" ? item.externalId : String(result.lastInsertRowid);
        db.prepare(`INSERT INTO crm_demo_zoho_import_records(organization_id,module,external_id,local_id,source_hash,local_hash,source_created_at,source_modified_at,source_json,run_id)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(selected.snapshot.organizationId, item.module, item.externalId, id, item.sourceHash, hash(item.row), item.createdAt, item.modifiedAt, item.sourceJson, value.runId);
      }
      verify();
      return { runId: value.runId, snapshotHash: plan.snapshotHash, summary: current.summary, replayed: false };
    }).immediate();
  } catch (error) { throw error instanceof ZohoSqliteImportError ? error : new ZohoSqliteImportError("APPLY_FAILED"); }
}
