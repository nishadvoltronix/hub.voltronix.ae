import { createHash } from "node:crypto";
import { z } from "zod";
import type { SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { createAuthService, type AuthUser } from "../../tests/sqlite-reference/auth/service.js";
import { parseDealInput } from "../../tests/sqlite-reference/commercial/deals.js";
import { calculateLocalQuotation, calculateSavedQuotation, parseSavedQuotationInput, PERCENTAGE_QUOTATION_POLICY, parseLocalQuotationInput, type QuotationInput } from "../src/crm/commercial/quotations.js";
import type { CommercialMutationResult, QuotationDetail, QuotationCapabilities } from "../src/crm/commercial/persistence-contracts.js";
import type { LeadMutationResult, LeadMutationCapabilities } from "../src/crm/lead-mutations/contracts.js";
import { inspectLocalWorkflowExtension } from "./workflow-schema.js";
import { inspectPercentageQuotationExtension } from "./percentage-schema.js";
import { validateLocalQuotationIssuer, type LocalQuotationIssuer } from "../src/crm/quotation-pdf/render.js";

type Token = string | null | undefined;
export class LocalWorkflowError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409 | 503, message?: string) {
    super(message ?? ({ 400: "Invalid local workflow input.", 401: "Sign in required.", 403: "Access denied.",
      404: "Record not found.", 409: "The local record changed or this operation is unavailable. Reload before continuing.",
      503: "Local workflows require the reviewed SQLite extension." })[status]);
  }
}
const idSchema = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => BigInt(value) <= 9_223_372_036_854_775_807n);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 2);
const text = (max: number) => z.string().trim().max(max).refine(value => !value.includes("\0"));
const operationId = z.uuid();
const stageInput = z.object({ operationId, expectedVersion: version,
  stage: z.enum(["Site Visit", "Proposal/Price Quote", "Closed Won", "Closed Lost"]),
  serviceCharge: z.string().regex(/^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$/).optional() }).strict();
const noteInput = z.object({ operationId, expectedVersion: version, title: text(200).min(1), content: text(10_000).min(1) }).strict();
const editNoteInput = noteInput.extend({ title: text(200).optional() });
const quoteInput = z.object({ operationId, expectedVersion: version, quotation: z.unknown() }).strict();
const editQuoteInput = quoteInput.extend({ expectedQuoteVersion: version });
export const localPageInput = z.object({ page: z.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(25) }).strict();
export const localSearchInput = localPageInput.extend({ query: text(120).default("") });
export function localParse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value); if (!parsed.success) throw new LocalWorkflowError(400); return parsed.data;
}
const permitted = (user: AuthUser) => user.permissions.some(key => ["leads.manage", "leads.manage.agents"].includes(key));
export type LocalTask = { id: string; ownerId: string; status: string; version: number; quoteNumber: string | null; createdAt: string };
type LocalQuote = { id: string; task_id: number; quote_number: string; quotation_json: string; totals_json: string;
  version: number; created_at: string; updated_at: string; calculation_policy: string; issuer_company: string | null; issuer_salesperson: string | null };
type Result = (LeadMutationResult | CommercialMutationResult) & { persistence: "local-demo" };

/** Only new, positively identified local records use this service. Existing
 * remote records never acquire a local owner through a fallback or NULL match. */
export function createLocalWorkflowService(db: SqliteDatabase, options: { now?: () => number } = {}) {
  const enabled = inspectLocalWorkflowExtension(db), percentageEnabled = inspectPercentageQuotationExtension(db), auth = createAuthService(db), now = options.now ?? Date.now;
  const at = () => new Date(now()).toISOString();
  function ready() { if (!enabled) throw new LocalWorkflowError(503); }
  function current(token: Token) { const user = auth.authenticate(token); if (!user) throw new LocalWorkflowError(401); return user; }
  function isLocal(id: unknown) {
    return enabled && idSchema.safeParse(id).success && !!db.prepare("SELECT 1 FROM crm_demo_local_tasks WHERE task_id=?").get(id);
  }
  function task(user: AuthUser, id: unknown, write = false): LocalTask {
    ready(); if (!idSchema.safeParse(id).success) throw new LocalWorkflowError(404);
    const row = db.prepare(`SELECT CAST(t.id AS TEXT) id,CAST(l.owner_user_id AS TEXT) ownerId,t.status,t.version,
      t.quote_number quoteNumber,t.created_at createdAt FROM crm_demo_local_tasks l JOIN tasks t ON t.id=l.task_id
      JOIN crm_demo_local_operations o ON o.operation_id=l.creation_operation_id AND o.task_id=t.id
      WHERE t.id=? AND t.zoho_crm_id IS NULL AND t.assigned_to IS NULL AND t.owner_id IS NULL AND t.quote_id IS NULL
      AND t.deal_crm_created_by=l.owner_user_id AND o.actor_user_id=l.owner_user_id AND o.kind='deal.create'
      AND o.remote_effect_possible=0 AND o.remote_references='{}' AND o.state='completed'`).get(id) as LocalTask | undefined;
    if (!row) throw new LocalWorkflowError(404);
    const owns = row.ownerId === user.localUserId;
    if (!auth.canAccessTask(user, row.id) && !(owns && (permitted(user) || user.permissions.includes("leads.view")))) throw new LocalWorkflowError(404);
    if (write && (!owns || !permitted(user))) throw new LocalWorkflowError(403);
    return row;
  }
  function stages(row: LocalTask) {
    if (["Pending", "Qualification"].includes(row.status)) return ["Site Visit", "Closed Lost"];
    if (row.status === "Site Visit") return row.quoteNumber ? ["Proposal/Price Quote", "Closed Lost"] : ["Closed Lost"];
    if (["Proposal", "Proposal/Price Quote"].includes(row.status)) return ["Closed Won", "Closed Lost"];
    return [];
  }
  function busy(id: string) {
    return !!db.prepare("SELECT 1 FROM crm_lead_operations WHERE task_id=? AND state!='completed' UNION ALL SELECT 1 FROM crm_commercial_operations WHERE task_id=? AND state!='completed' LIMIT 1").get(id, id);
  }
  function checkVersion(row: LocalTask, expected: number) {
    if (!version.safeParse(row.version).success || row.version !== expected || busy(row.id)) throw new LocalWorkflowError(409);
  }
  function requestHash(kind: string, input: unknown) { return createHash("sha256").update(JSON.stringify({ persistence: "local-demo", kind, input })).digest("hex"); }
  function replay(user: AuthUser, uuid: string, kind: string, hash: string, taskId?: string): Result | undefined {
    if (db.prepare("SELECT 1 FROM crm_lead_operations WHERE operation_id=? UNION ALL SELECT 1 FROM crm_commercial_operations WHERE operation_id=?").get(uuid, uuid)) throw new LocalWorkflowError(409);
    const old = db.prepare("SELECT CAST(actor_user_id AS TEXT) actor,CAST(task_id AS TEXT) taskId,kind,request_hash,result_json FROM crm_demo_local_operations WHERE operation_id=?").get(uuid) as
      { actor: string; taskId: string; kind: string; request_hash: string; result_json: string } | undefined;
    if (!old) return undefined;
    if (old.actor !== user.localUserId || old.kind !== kind || old.request_hash !== hash || (taskId !== undefined && old.taskId !== taskId)) throw new LocalWorkflowError(409);
    if (kind === "deal.create") {
      const owner = db.prepare("SELECT CAST(owner_user_id AS TEXT) ownerId FROM crm_demo_local_tasks WHERE task_id=? AND creation_operation_id=?").get(old.taskId, uuid) as { ownerId: string } | undefined;
      if (owner?.ownerId !== user.localUserId) throw new LocalWorkflowError(404);
    }
    return JSON.parse(old.result_json) as Result;
  }
  function finish(user: AuthUser, rowId: string, kind: string, hash: string, value: Result, fields: string[], timestamp: string): Result {
    db.prepare(`INSERT INTO crm_demo_local_operations(operation_id,actor_user_id,task_id,kind,request_hash,state,result_json,created_at)
      VALUES(?,?,?,?,?,'completed',?,?)`).run(value.operationId, user.localUserId, rowId, kind, hash, JSON.stringify(value), timestamp);
    db.prepare("INSERT INTO crm_demo_local_audit(operation_id,actor_user_id,task_id,action,changed_fields,occurred_at) VALUES(?,?,?,?,?,?)")
      .run(value.operationId, user.localUserId, rowId, kind, JSON.stringify(fields), timestamp);
    return value;
  }
  function touch(row: LocalTask, expected: number, timestamp: string) {
    const result = db.prepare("UPDATE tasks SET version=version+1,updated_at=? WHERE id=? AND version=?").run(timestamp, row.id, expected);
    if (result.changes !== 1) throw new LocalWorkflowError(409);
  }
  function createDeal(token: Token, input: unknown): LeadMutationResult & { persistence: "local-demo" } {
    ready(); return db.transaction(() => {
      const user = current(token); if (!user.permissions.includes("deals.manage")) throw new LocalWorkflowError(403);
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new LocalWorkflowError(400);
      const { operationId: rawId, ...fields } = input as Record<string, unknown>, uuid = localParse(operationId, rawId);
      let value: ReturnType<typeof parseDealInput>; try { value = parseDealInput(fields); } catch { throw new LocalWorkflowError(400); }
      const hash = requestHash("deal.create", { operationId: uuid, ...value }), old = replay(user, uuid, "deal.create", hash);
      if (old) return old as LeadMutationResult & { persistence: "local-demo" };
      const timestamp = at();
      const inserted = db.prepare(`INSERT INTO tasks(deal_crm_created_by,deal_name,status,account_name,customer_name,customer_email,
        customer_contact,address,complaint_info,remark,p_box,trn,created_at,updated_at,qual_deal_date)
        VALUES(?,?,'Pending',?,?,?,?,?,?,?,?,?,?,?,?)`).run(user.localUserId, `${value.firstName} ${value.lastName}`, value.companyName,
          `${value.firstName} ${value.lastName}`, value.email, value.phone, value.address, value.description, value.description, value.poBox, value.trn, timestamp, timestamp, timestamp);
      const id = String(inserted.lastInsertRowid), reference = `LOCAL-DEAL-${id}`;
      db.prepare("UPDATE tasks SET deal_number=?,qual_deal_number=? WHERE id=?").run(reference, `LOCAL-QUAL-${id}`, id);
      db.prepare("INSERT INTO crm_demo_local_tasks(task_id,owner_user_id,creation_operation_id,customer_department,input_json,created_at) VALUES(?,?,?,?,?,?)")
        .run(id, user.localUserId, uuid, value.department, JSON.stringify(value), timestamp);
      return finish(user, id, "deal.create", hash, { operationId: uuid, taskId: id, version: 1, persistence: "local-demo" },
        ["local_owner", "customer_snapshot", "status", "local_reference"], timestamp) as LeadMutationResult & { persistence: "local-demo" };
    }).immediate();
  }
  function capabilities(token: Token, id: unknown): LeadMutationCapabilities & { persistence: "local-demo" } {
    return db.transaction(() => {
      const user = current(token), row = task(user, id), canWrite = permitted(user), blocked = busy(row.id);
      return { persistence: "local-demo" as const, version: row.version, canWriteNotes: canWrite && !blocked,
        canChangeStage: canWrite && row.ownerId === user.localUserId && !blocked,
        stages: canWrite && row.ownerId === user.localUserId && !blocked ? stages(row) : [], integrationAvailable: false };
    })();
  }
  function changeStage(token: Token, id: unknown, input: unknown): LeadMutationResult & { persistence: "local-demo" } {
    return db.transaction(() => {
      const user = current(token), row = task(user, id, true), value = localParse(stageInput, input);
      const hash = requestHash("lead.stage", { taskId: row.id, ...value }), old = replay(user, value.operationId, "lead.stage", hash, row.id);
      if (old) return old as LeadMutationResult & { persistence: "local-demo" };
      checkVersion(row, value.expectedVersion); if (!stages(row).includes(value.stage)) throw new LocalWorkflowError(400);
      const timestamp = at(), columns = { "Site Visit": ["site_deal_number", "site_deal_date", "SITE"],
        "Proposal/Price Quote": ["quote_deal_number", "quote_deal_date", "QUOTE"], "Closed Won": ["job_deal_number", "job_deal_date", "JOB"],
        "Closed Lost": ["lost_deal_number", "lost_deal_date", "LOST"] } as const;
      const [numberColumn, dateColumn, label] = columns[value.stage];
      db.prepare(`UPDATE tasks SET status=?,${numberColumn}=?,${dateColumn}=?${value.serviceCharge === undefined ? "" : ",service_charge=?"} WHERE id=?`)
        .run(value.stage, value.stage === "Proposal/Price Quote" ? row.quoteNumber : `LOCAL-${label}-${row.id}`, timestamp,
          ...(value.serviceCharge === undefined ? [] : [value.serviceCharge]), row.id);
      touch(row, value.expectedVersion, timestamp);
      db.prepare("INSERT INTO tasks_status_log(Task_ID,User_ID,Status,Task_Log_Create_Date) VALUES(?,?,?,?)").run(row.id, user.localUserId, value.stage, timestamp);
      return finish(user, row.id, "lead.stage", hash, { operationId: value.operationId, taskId: row.id, version: row.version + 1, persistence: "local-demo" },
        ["status", numberColumn, dateColumn, ...(value.serviceCharge === undefined ? [] : ["service_charge"])], timestamp) as LeadMutationResult & { persistence: "local-demo" };
    }).immediate();
  }
  function mutateNote(token: Token, id: unknown, noteId: unknown, input: unknown, edit: boolean): LeadMutationResult & { persistence: "local-demo" } {
    return db.transaction(() => {
      const user = current(token), row = task(user, id); if (!permitted(user)) throw new LocalWorkflowError(403);
      const value = edit ? localParse(editNoteInput, input) : localParse(noteInput, input);
      const previous = edit && idSchema.safeParse(noteId).success ? db.prepare("SELECT CAST(id AS TEXT) id,title FROM crm_demo_local_notes WHERE id=? AND task_id=?").get(noteId, row.id) as { id: string; title: string } | undefined : undefined;
      if (edit && !previous) throw new LocalWorkflowError(404);
      const kind = edit ? "note.edit" : "note.create", hash = requestHash(kind, { taskId: row.id, noteId: previous?.id ?? null, ...value }), old = replay(user, value.operationId, kind, hash, row.id);
      if (old) return old as LeadMutationResult & { persistence: "local-demo" };
      checkVersion(row, value.expectedVersion); const timestamp = at(), title = value.title || previous?.title || "Lead Note";
      const savedId = previous?.id ?? String(db.prepare("INSERT INTO crm_demo_local_notes(task_id,title,content,created_at,updated_at) VALUES(?,?,?,?,?)")
        .run(row.id, title, value.content, timestamp, timestamp).lastInsertRowid);
      if (previous) db.prepare("UPDATE crm_demo_local_notes SET title=?,content=?,updated_at=? WHERE id=? AND task_id=?").run(title, value.content, timestamp, savedId, row.id);
      touch(row, value.expectedVersion, timestamp);
      return finish(user, row.id, kind, hash, { operationId: value.operationId, taskId: row.id, noteId: savedId, version: row.version + 1, persistence: "local-demo" },
        ["title", "content"], timestamp) as LeadMutationResult & { persistence: "local-demo" };
    }).immediate();
  }
  function savedQuote(id: string) { return db.prepare(`SELECT CAST(id AS TEXT) id,task_id,quote_number,quotation_json,totals_json,
    version,created_at,updated_at,calculation_policy,issuer_company,issuer_salesperson FROM ${percentageEnabled ? "(SELECT * FROM crm_demo_local_quotations UNION ALL SELECT * FROM crm_demo_percentage_quotations)" : "crm_demo_local_quotations"} WHERE task_id=?`).get(id) as LocalQuote | undefined; }
  function quotation(value: unknown) { try { return parseLocalQuotationInput(value); } catch { throw new LocalWorkflowError(400); } }
  function savedInput(row: LocalQuote) {
    let value: QuotationInput;
    try { value = parseSavedQuotationInput(JSON.parse(row.quotation_json), row.calculation_policy, true); } catch { throw new LocalWorkflowError(409); }
    const totals = calculateSavedQuotation(value, row.calculation_policy, true);
    if (JSON.stringify(totals) !== row.totals_json) throw new LocalWorkflowError(409);
    return value;
  }
  function quoteCapabilities(token: Token, id: unknown): QuotationCapabilities {
    return db.transaction(() => {
      const user = current(token), row = task(user, id), saved = savedQuote(row.id), discountBlocked = saved ? (savedInput(saved), saved.calculation_policy !== PERCENTAGE_QUOTATION_POLICY) : false;
      const canWrite = permitted(user) && row.ownerId === user.localUserId && !busy(row.id);
      return { taskVersion: row.version, quoteVersion: saved?.version ?? null, canCreate: canWrite && percentageEnabled && !saved && !row.quoteNumber,
        canEdit: canWrite && percentageEnabled && !!saved && !discountBlocked, discountedEditBlocked: discountBlocked,
        integrationAvailable: false, persistence: "local-demo" as const, pdfAvailable: !!saved?.issuer_company && !!saved.issuer_salesperson };
    })();
  }
  function mutateQuote(token: Token, id: unknown, input: unknown, edit: boolean): CommercialMutationResult & { persistence: "local-demo" } {
    return db.transaction(() => {
      const user = current(token), row = task(user, id, true), value = edit ? localParse(editQuoteInput, input) : localParse(quoteInput, input);
      const parsed = quotation(value.quotation), existing = savedQuote(row.id);
      if (Buffer.byteLength(JSON.stringify(value), "utf8") > 256 * 1024) throw new LocalWorkflowError(400);
      const kind = edit ? "quote.edit" : "quote.create", hash = requestHash(kind, { taskId: row.id, ...value, quotation: parsed });
      // Saved legacy discount values cannot be reinterpreted by zeroing/removing a line.
      if (edit && existing && (savedInput(existing), existing.calculation_policy !== PERCENTAGE_QUOTATION_POLICY)) throw new LocalWorkflowError(409);
      if (!percentageEnabled) throw new LocalWorkflowError(503);
      const old = replay(user, value.operationId, kind, hash, row.id); if (old) return old as CommercialMutationResult & { persistence: "local-demo" };
      checkVersion(row, value.expectedVersion);
      if (edit ? !existing || !("expectedQuoteVersion" in value) || existing.version !== value.expectedQuoteVersion || !version.safeParse(existing.version).success || row.quoteNumber !== existing.quote_number : !!existing || !!row.quoteNumber) throw new LocalWorkflowError(409);
      const normalized: QuotationInput = { ...parsed, items: parsed.items.map(item => {
        const product = db.prepare("SELECT product_name,description FROM products WHERE product_id=?").get(item.productId) as { product_name: string; description: string | null } | undefined;
        if (!product || product.product_name !== item.productName) throw new LocalWorkflowError(400);
        // The source resolves an empty item description from the product. Resolve
        // from the real local product rather than making a remote lookup.
        return { ...item, description: item.description || product.description || "" };
      }) };
      const totals = calculateLocalQuotation(normalized);
      if (!/^(?:0|[1-9][0-9]{0,29})\.[0-9]{2}$/.test(totals.subtotal)) throw new LocalWorkflowError(400);
      const timestamp = at(), number = existing?.quote_number ?? `LOCAL-QUOTE-${row.id}`;
      let quoteId: string;
      if (existing) {
        const changed = db.prepare("UPDATE crm_demo_percentage_quotations SET quotation_json=?,totals_json=?,calculation_policy=?,version=version+1,updated_at=? WHERE id=? AND version=?")
          .run(JSON.stringify(normalized), JSON.stringify(totals), PERCENTAGE_QUOTATION_POLICY, timestamp, existing.id, existing.version);
        if (changed.changes !== 1) throw new LocalWorkflowError(409); quoteId = String(existing.id);
      } else {
        // The explicit operator-approved issuer is snapshotted only at creation.
        // Customer department never supplies it; edits cannot replace it.
        const issuer = db.prepare("SELECT company,salesperson FROM crm_demo_local_issuer WHERE id=1").get() as LocalQuotationIssuer | undefined;
        if (issuer) validateLocalQuotationIssuer(issuer);
        quoteId = String(db.prepare(`INSERT INTO crm_demo_percentage_quotations(task_id,quote_number,quotation_json,totals_json,calculation_policy,issuer_company,issuer_salesperson,created_at,updated_at)
          VALUES(?,?,?,?,'percentage-only-v2',?,?,?,?)`).run(row.id, number, JSON.stringify(normalized), JSON.stringify(totals), issuer?.company ?? null,
            issuer?.salesperson ?? null, timestamp, timestamp).lastInsertRowid);
      }
      db.prepare(`UPDATE tasks SET quote_number=?,service_charge=?,notes=?${edit ? "" : ",status='Proposal/Price Quote',quote_deal_number=?,quote_deal_date=?"} WHERE id=?`)
        .run(number, totals.subtotal, normalized.notes, ...(edit ? [] : [number, timestamp]), row.id);
      touch(row, value.expectedVersion, timestamp);
      return finish(user, row.id, kind, hash, { operationId: value.operationId, taskId: row.id, quoteId: `local-${quoteId}`,
        version: row.version + 1, quoteVersion: (existing?.version ?? 0) + 1, persistence: "local-demo" },
        ["quotation", "service_charge", "notes", ...(edit ? [] : ["status", "quote_deal_number", "quote_deal_date"])], timestamp) as CommercialMutationResult & { persistence: "local-demo" };
    }).immediate();
  }
  function getQuotation(token: Token, id: unknown): QuotationDetail {
    return db.transaction(() => {
      const user = current(token), row = task(user, id), saved = savedQuote(row.id); if (!saved) throw new LocalWorkflowError(404);
      const value = savedInput(saved), totals = calculateSavedQuotation(value, saved.calculation_policy, true);
      if (row.quoteNumber !== saved.quote_number) throw new LocalWorkflowError(409);
      const snapshot = db.prepare(`SELECT t.deal_name dealName,t.deal_number dealNumber,t.account_name accountName,t.customer_name customerName,
        t.customer_email customerEmail,t.customer_contact customerContact,t.address,t.status,t.Job_Status jobStatus,NULL assignedExternalId,
        u.username assignedName,NULL assignedCompany,NULL assignedSaleName,t.created_at createdAt,t.quote_deal_date quoteDealDate,
        t.quote_deal_number quoteDealNumber,t.p_box pBox,t.trn,t.tax_total taxTotal FROM tasks t
        JOIN crm_demo_local_tasks l ON l.task_id=t.id JOIN users u ON u.id=l.owner_user_id WHERE t.id=?`).get(row.id) as QuotationDetail["task"];
      snapshot.assignedLocalId = row.ownerId;
      snapshot.assignedCompany = saved.issuer_company; snapshot.assignedSaleName = saved.issuer_salesperson;
      return { id: `local-${saved.id}`, taskId: row.id, externalId: null, quoteNumber: saved.quote_number, subject: value.subject,
        accountName: snapshot.accountName, dealName: snapshot.dealName, assignedName: snapshot.assignedName, subtotal: totals.subtotal,
        dealNumber: snapshot.dealNumber, dealStatus: snapshot.status, jobStatus: snapshot.jobStatus,
        grandTotal: totals.grandTotal, version: saved.version, taskVersion: row.version, createdAt: saved.created_at, updatedAt: saved.updated_at,
        remoteModifiedAt: null, calculationPolicy: saved.calculation_policy as QuotationDetail["calculationPolicy"], quotation: value, totals, task: snapshot,
        persistence: "local-demo" as const, localOwnerId: row.ownerId, pdfAvailable: !!saved.issuer_company && !!saved.issuer_salesperson };
    })();
  }
  return { enabled, percentageEnabled, current, task, isLocal, createDeal, capabilities, changeStage, getQuotation, quoteCapabilities,
    addNote: (token: Token, id: unknown, input: unknown) => mutateNote(token, id, undefined, input, false),
    editNote: (token: Token, id: unknown, noteId: unknown, input: unknown) => mutateNote(token, id, noteId, input, true),
    createQuotation: (token: Token, id: unknown, input: unknown) => mutateQuote(token, id, input, false),
    updateQuotation: (token: Token, id: unknown, input: unknown) => mutateQuote(token, id, input, true) };
}
