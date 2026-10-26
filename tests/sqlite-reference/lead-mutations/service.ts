import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import { z } from "zod";
import { createAuthService, type AuthUser } from "../auth/service";
import { LEAD_TRANSITIONS, type LeadMutationCapabilities, type LeadMutationResult, type ZohoTransport } from "./contracts";
import { buildAccountPayload, buildAccountSearchPath, buildContactPayload, buildDealPayload, parseDealInput } from "../commercial/deals";
import { CommercialError } from "../commercial/validation";

type Token = string | null | undefined;
type Kind = "lead.stage" | "note.create" | "note.edit" | "deal.create";
type Task = { id: string; externalId: string | null; assignedTo: string | null; status: string; quoteId: string | null; version: number };
type Operation = { operation_id: string; actor_user_id: string; task_id: string | null; kind: Kind; request_hash: string;
  state: "inflight" | "completed" | "reconciliation"; result_task_id: string | null; result_note_id: string | null; result_version: number | null };
type Note = { id: string; externalId: string | null; title: string; content: string };
export class LeadMutationError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409 | 503) {
    super(({400: "Invalid lead change.",401: "Sign in required.",403: "Access denied.",404: "Record not found.",
      409: "The record changed or an integration operation needs reconciliation. Reload before continuing.",
      503: "Lead changes are unavailable. An approved integration is required; an attempted operation may need reconciliation."})[status]);
    this.name = "LeadMutationError";
  }
}
const localId = z.string().regex(/^[1-9][0-9]{0,18}$/).refine((v) => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9_223_372_036_854_775_807n);
const remoteId = z.string().regex(/^[1-9][0-9]{0,39}$/);
const cleanText = (max: number) => z.string().trim().max(max).refine((v) => !v.includes("\0"));
const base = { operationId: z.uuid(), expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1) };
const amount = z.string().regex(/^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$/);
const remoteDate = z.iso.datetime({ offset: true });
const stageInput = z.object({ ...base, stage: z.enum(LEAD_TRANSITIONS), serviceCharge: amount.optional() }).strict();
const addNoteInput = z.object({ ...base, title: cleanText(200).min(1), content: cleanText(10_000).min(1) }).strict();
const editNoteInput = z.object({ ...base, title: cleanText(200).optional(), content: cleanText(10_000).min(1) }).strict();
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input); if (!result.success) throw new LeadMutationError(400); return result.data;
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new LeadMutationError(503);
  return value as Record<string, unknown>;
}
function first(value: unknown): Record<string, unknown> {
  const data = record(value).data;
  if (!Array.isArray(data) || data.length !== 1) throw new LeadMutationError(503);
  return record(data[0]);
}
function receipt(value: unknown): string {
  const row = first(value);
  if (row.code !== "SUCCESS" || row.status !== "success") throw new LeadMutationError(503);
  const result = remoteId.safeParse(record(row.details).id);
  if (!result.success) throw new LeadMutationError(503);
  return result.data;
}
function stages(task: Task): string[] {
  if (["Pending", "Qualification"].includes(task.status)) return ["Site Visit", "Closed Lost"];
  if (task.status === "Site Visit") return task.quoteId ? ["Proposal/Price Quote", "Closed Lost"] : ["Closed Lost"];
  if (["Proposal", "Proposal/Price Quote"].includes(task.status)) return ["Closed Won", "Closed Lost"];
  return [];
}
const numberColumns = { DealNumber: "deal_number", QualDealNumber: "qual_deal_number", SiteDealNumber: "site_deal_number",
  QuoteDealNumber: "quote_deal_number", JobDealNumber: "job_deal_number", LostDealNumber: "lost_deal_number" } as const;
const dateColumns = { Qual_Deal_Date: "qual_deal_date", Site_Deal_Date: "site_deal_date", Quote_Deal_Date: "quote_deal_date",
  Job_Date: "job_deal_date", Lost_Deal_Date: "lost_deal_date" } as const;
const stageFields = { "Site Visit": ["SiteDealNumber", "site_deal_date"], "Proposal/Price Quote": ["QuoteDealNumber", "quote_deal_date"],
  "Closed Won": ["JobDealNumber", "job_deal_date"], "Closed Lost": ["LostDealNumber", "lost_deal_date"] } as const;

export function createLeadMutationsService(db: Database, options: { transport?: ZohoTransport; accountOwnerId?: string; now?: () => number; wait?: (ms: number) => Promise<void> } = {}) {
  const now = options.now ?? Date.now, auth = createAuthService(db, { now });
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const at = () => new Date(now()).toISOString();
  function safe<T>(operation: () => T): T {
    try { return operation(); } catch (error) { if (error instanceof LeadMutationError) throw error;
      if (error instanceof CommercialError && error.status === 400) throw new LeadMutationError(400); throw new LeadMutationError(503); }
  }
  function actor(token: Token, create = false): AuthUser {
    const user = auth.authenticate(token); if (!user) throw new LeadMutationError(401);
    if (create ? !user.permissions.includes("deals.manage") : !user.permissions.some((p) => p === "leads.manage" || p === "leads.manage.agents")) throw new LeadMutationError(403);
    return user;
  }
  function task(user: AuthUser, id: unknown, stage = false): Task {
    if (!localId.safeParse(id).success || !auth.canAccessTask(user, id as string)) throw new LeadMutationError(404);
    const row = db.prepare("SELECT CAST(id AS TEXT) id,zoho_crm_id externalId,assigned_to assignedTo,status,quote_number quoteId,version FROM tasks WHERE id=?").get(id) as Task;
    if (stage && (user.externalUserId === null || row.assignedTo !== user.externalUserId)) throw new LeadMutationError(403);
    return row;
  }
  function note(parent: Task, id: unknown): Note {
    if (!localId.safeParse(id).success || !parent.externalId) throw new LeadMutationError(404);
    const row = db.prepare("SELECT CAST(id AS TEXT) id,zoho_note_id externalId,note_title title,note_content content FROM job_notes WHERE id=? AND deal_id=?").get(id, parent.externalId) as Note | undefined;
    if (!row) throw new LeadMutationError(404); return row;
  }
  function operation(id: string): Operation | undefined {
    return db.prepare(`SELECT operation_id,CAST(actor_user_id AS TEXT) actor_user_id,CAST(task_id AS TEXT) task_id,kind,request_hash,state,
      CAST(result_task_id AS TEXT) result_task_id,CAST(result_note_id AS TEXT) result_note_id,result_version FROM crm_lead_operations WHERE operation_id=?`).get(id) as Operation | undefined;
  }
  function busyOperation(taskId: string) {
    return db.prepare("SELECT operation_id FROM crm_lead_operations WHERE task_id=? AND state!='completed' UNION ALL SELECT operation_id FROM crm_commercial_operations WHERE task_id=? AND state!='completed' LIMIT 1")
      .get(taskId, taskId) as { operation_id: string } | undefined;
  }
  function result(row: Operation): LeadMutationResult {
    if (row.state !== "completed" || !row.result_task_id || !row.result_version) throw new LeadMutationError(409);
    return { operationId: row.operation_id, taskId: row.result_task_id, version: row.result_version,
      ...(row.result_note_id ? { noteId: row.result_note_id } : {}) };
  }
  function reserve(user: AuthUser, parent: Task, kind: Kind, value: { operationId: string; expectedVersion: number }, hashBody: unknown): LeadMutationResult | undefined {
    const hash = createHash("sha256").update(JSON.stringify(hashBody)).digest("hex"), previous = operation(value.operationId);
    if (previous) {
      if (previous.actor_user_id !== user.localUserId || previous.task_id !== parent.id || previous.kind !== kind || previous.request_hash !== hash) throw new LeadMutationError(409);
      return result(previous);
    }
    if (value.expectedVersion !== parent.version) throw new LeadMutationError(409);
    if (!options.transport) throw new LeadMutationError(503);
    if (!remoteId.safeParse(parent.externalId).success) throw new LeadMutationError(409);
    if (busyOperation(parent.id)) throw new LeadMutationError(409);
    db.prepare(`INSERT INTO crm_lead_operations(operation_id,actor_user_id,task_id,kind,request_hash,state,created_at,updated_at) VALUES(?,?,?,?,?,'inflight',?,?)`)
      .run(value.operationId, user.localUserId, parent.id, kind, hash, at(), at());
  }
  async function request(operationId: string, method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<unknown> {
    if (!options.transport) throw new LeadMutationError(503);
    if (method !== "GET") db.prepare("UPDATE crm_lead_operations SET remote_effect_possible=1,updated_at=? WHERE operation_id=? AND state='inflight'").run(at(), operationId);
    const response = await options.transport.request({ method, path, ...(body === undefined ? {} : { body }) });
    if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) throw new LeadMutationError(503);
    if (response.status === 204) return null;
    if (response.body === null || response.body === undefined) throw new LeadMutationError(503);
    return response.body;
  }
  function current(token: Token, parent: Task, stage = false) {
    safe(() => db.transaction(() => {
      const fresh = task(actor(token), parent.id, stage);
      if (fresh.version !== parent.version || fresh.externalId !== parent.externalId) throw new LeadMutationError(409);
    })());
  }
  function rememberRemote(operationId: string, id: string, reference: "accountId" | "contactId" | "dealId" | "noteId" = "dealId") {
    db.prepare("UPDATE crm_lead_operations SET remote_id=?,remote_references=json_set(remote_references,?,?),updated_at=? WHERE operation_id=? AND state='inflight'")
      .run(id, `$.${reference}`, id, at(), operationId);
  }
  function finish(user: AuthUser, parent: Task, operationId: string, action: Kind, fields: string[], noteId?: string): LeadMutationResult {
    db.prepare("INSERT INTO crm_lead_audit_events(actor_user_id,task_id,operation_id,action,changed_fields,occurred_at) VALUES(?,?,?,?,?,?)")
      .run(user.localUserId, parent.id, operationId, action, JSON.stringify(fields), at());
    db.prepare("UPDATE crm_lead_operations SET state='completed',result_task_id=?,result_note_id=?,result_version=?,updated_at=? WHERE operation_id=? AND state='inflight'")
      .run(parent.id, noteId ?? null, parent.version + 1, at(), operationId);
    return result(operation(operationId)!);
  }
  async function guarded(operationId: string, work: () => Promise<LeadMutationResult>): Promise<LeadMutationResult> {
    try { return await work(); } catch (error) {
      // No response body, request text, credentials or exception details are persisted or exposed.
      safe(() => db.prepare("UPDATE crm_lead_operations SET state='reconciliation',updated_at=? WHERE operation_id=? AND state='inflight'").run(at(), operationId));
      if (error instanceof LeadMutationError) throw error; throw new LeadMutationError(503);
    }
  }
  function capabilities(token: Token, id: unknown): LeadMutationCapabilities {
    return safe(() => db.transaction(() => {
      const user = auth.authenticate(token); if (!user) throw new LeadMutationError(401);
      const parent = task(user, id), canWrite = user.permissions.some((p) => p === "leads.manage" || p === "leads.manage.agents");
      const canStage = canWrite && user.externalUserId !== null && parent.assignedTo === user.externalUserId;
      const blocked = busyOperation(parent.id);
      return { version: parent.version, canChangeStage: canStage, canWriteNotes: canWrite,
        stages: canStage ? stages(parent) : [], integrationAvailable: !!options.transport,
        ...(blocked ? { blockedOperationId: blocked.operation_id } : {}) };
    })());
  }
  async function changeStage(token: Token, id: unknown, input: unknown): Promise<LeadMutationResult> {
    const start = safe(() => db.transaction(() => {
      const user = actor(token), parent = task(user, id, true), value = parse(stageInput, input);
      // A completed identical request may be replayed after its successful stage change.
      if (!operation(value.operationId) && !stages(parent).includes(value.stage)) throw new LeadMutationError(400);
      const replay = reserve(user, parent, "lead.stage", value, value); return { user, parent, value, replay };
    }).immediate());
    if (start.replay) return start.replay;
    const { parent, value } = start;
    return guarded(value.operationId, async () => {
      current(token, parent, true);
      const receiptId = receipt(await request(value.operationId, "PUT", `/Deals/${parent.externalId}`, { data: [{ Stage: value.stage, VZ_App_Status: value.stage,
        ...(value.serviceCharge === undefined ? {} : { Amount: value.serviceCharge }) }] }));
      if (receiptId !== parent.externalId) throw new LeadMutationError(503);
      rememberRemote(value.operationId, receiptId);
      let remote: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 12; attempt++) {
        current(token, parent, true);
        const fetched = first(await request(value.operationId, "GET", `/Deals/${parent.externalId}`));
        if (fetched.id !== parent.externalId) throw new LeadMutationError(503);
        const numberField = stageFields[value.stage][0];
        if (fetched.Stage === value.stage && typeof fetched.DealNumber === "string" && fetched.DealNumber.length > 0 &&
          (value.stage === "Closed Lost" || (typeof fetched[numberField] === "string" && (fetched[numberField] as string).length > 0))) { remote = fetched; break; }
        if (attempt < 11) await wait(2_000);
      }
      if (!remote) throw new LeadMutationError(503);
      const changes: Record<string, string> = { status: value.stage, [stageFields[value.stage][1]]: at() };
      if (value.serviceCharge !== undefined) changes.service_charge = value.serviceCharge;
      for (const [field, column] of Object.entries(numberColumns)) {
        if (remote[field] !== undefined && remote[field] !== null && remote[field] !== "") {
          const parsed = cleanText(100).min(1).safeParse(remote[field]); if (!parsed.success) throw new LeadMutationError(503); changes[column] = parsed.data;
        }
      }
      for (const [field, column] of Object.entries(dateColumns)) {
        if (remote[field] !== undefined && remote[field] !== null && remote[field] !== "") {
          const date = remote[field];
          if (typeof date !== "string" || !remoteDate.safeParse(date).success || !Number.isFinite(Date.parse(date))) throw new LeadMutationError(503);
          changes[column] = new Date(date).toISOString();
        }
      }
      return safe(() => db.transaction(() => {
        const user = actor(token), fresh = task(user, id, true);
        if (fresh.version !== value.expectedVersion || fresh.externalId !== parent.externalId) throw new LeadMutationError(409);
        const keys = Object.keys(changes);
        const update = db.prepare(`UPDATE tasks SET ${keys.map((key) => `${key}=?`).join(",")},version=version+1,updated_at=? WHERE id=? AND version=?`)
          .run(...Object.values(changes), at(), parent.id, value.expectedVersion);
        if (update.changes !== 1) throw new LeadMutationError(409);
        db.prepare("INSERT INTO tasks_status_log(Task_ID,User_ID,Status,Task_Log_Create_Date) VALUES(?,?,?,?)").run(parent.id, user.localUserId, value.stage, at());
        return finish(user, parent, value.operationId, "lead.stage", keys);
      }).immediate());
    });
  }
  async function mutateNote(token: Token, id: unknown, noteId: unknown, input: unknown, edit: boolean): Promise<LeadMutationResult> {
    const start = safe(() => db.transaction(() => {
      const user = actor(token), parent = task(user, id), previous = edit ? note(parent, noteId) : undefined;
      const value = edit ? parse(editNoteInput, input) : parse(addNoteInput, input);
      const title = value.title || previous?.title || "Lead Note";
      const replay = reserve(user, parent, edit ? "note.edit" : "note.create", value, { ...value, noteId: previous?.id ?? null });
      return { parent, previous, value, title, replay };
    }).immediate());
    if (start.replay) return start.replay;
    const { parent, previous, value, title } = start;
    return guarded(value.operationId, async () => {
      current(token, parent);
      if (previous?.externalId && !remoteId.safeParse(previous.externalId).success) throw new LeadMutationError(409);
      const remoteNote = receipt(await request(value.operationId, previous?.externalId ? "PUT" : "POST",
        previous?.externalId ? `/Notes/${previous.externalId}` : `/Deals/${parent.externalId}/Notes`,
        { data: [{ Note_Title: title, Note_Content: value.content }] }));
      if (previous?.externalId && remoteNote !== previous.externalId) throw new LeadMutationError(503);
      rememberRemote(value.operationId, remoteNote, "noteId");
      return safe(() => db.transaction(() => {
        const user = actor(token), fresh = task(user, id);
        if (fresh.version !== value.expectedVersion || fresh.externalId !== parent.externalId) throw new LeadMutationError(409);
        if (previous) {
          const freshNote = note(fresh, previous.id);
          if (freshNote.externalId !== previous.externalId || freshNote.title !== previous.title || freshNote.content !== previous.content) throw new LeadMutationError(409);
          db.prepare("UPDATE job_notes SET note_title=?,note_content=?,zoho_note_id=?,updated_at=? WHERE id=? AND deal_id=?")
            .run(title, value.content, remoteNote, at(), previous.id, fresh.externalId);
        }
        const savedId = previous?.id ?? String(db.prepare("INSERT INTO job_notes(deal_id,note_title,note_content,zoho_note_id,created_at,updated_at) VALUES(?,?,?,?,?,?)")
          .run(fresh.externalId, title, value.content, remoteNote, at(), at()).lastInsertRowid);
        const changed = db.prepare("UPDATE tasks SET version=version+1,updated_at=? WHERE id=? AND version=?").run(at(), fresh.id, value.expectedVersion);
        if (changed.changes !== 1) throw new LeadMutationError(409);
        return finish(user, parent, value.operationId, edit ? "note.edit" : "note.create", ["note_title", "note_content", "zoho_note_id"], savedId);
      }).immediate());
    });
  }
  async function createDeal(token: Token, input: unknown): Promise<LeadMutationResult> {
    const start = safe(() => db.transaction(() => {
      const user = actor(token, true);
      if (!remoteId.safeParse(user.externalUserId).success) throw new LeadMutationError(403);
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new LeadMutationError(400);
      const { operationId: rawOperation, ...fields } = input as Record<string, unknown>;
      const operationId = parse(z.uuid(), rawOperation), value = parseDealInput(fields), searchPath = buildAccountSearchPath(value.companyName);
      const hash = createHash("sha256").update(JSON.stringify({ operationId, ...value })).digest("hex"), previous = operation(operationId);
      if (previous) {
        if (previous.actor_user_id !== user.localUserId || previous.kind !== "deal.create" || previous.request_hash !== hash) throw new LeadMutationError(409);
        const replay = result(previous);
        // A successful creation replay must still belong to this external identity.
        const saved = db.prepare("SELECT assigned_to FROM tasks WHERE id=?").get(replay.taskId) as { assigned_to: string | null } | undefined;
        if (!saved || saved.assigned_to !== user.externalUserId) throw new LeadMutationError(404);
        return { user, operationId, value, searchPath, replay };
      }
      if (!options.transport || !remoteId.safeParse(options.accountOwnerId).success) throw new LeadMutationError(503);
      if (db.prepare("SELECT 1 FROM crm_lead_operations WHERE actor_user_id=? AND kind='deal.create' AND state!='completed'").get(user.localUserId)) throw new LeadMutationError(409);
      db.prepare("INSERT INTO crm_lead_operations(operation_id,actor_user_id,kind,request_hash,state,created_at,updated_at) VALUES(?,?,'deal.create',?,'inflight',?,?)")
        .run(operationId, user.localUserId, hash, at(), at());
      return { user, operationId, value, searchPath, replay: undefined };
    }).immediate());
    if (start.replay) return start.replay;
    const { user: originalUser, operationId, value, searchPath } = start;
    return guarded(operationId, async () => {
      function authorizeCreate() {
        const user = safe(() => actor(token, true));
        if (user.externalUserId !== originalUser.externalUserId) throw new LeadMutationError(403);
      }
      authorizeCreate();
      const lookup = await request(operationId, "GET", searchPath);
      let accountId: string;
      // Zoho uses 204 for no search results. Empty data is accepted as well; arbitrary errors are not absence.
      if (lookup === undefined || lookup === null || (Array.isArray(record(lookup).data) && (record(lookup).data as unknown[]).length === 0)) {
        authorizeCreate();
        accountId = receipt(await request(operationId, "POST", "/Accounts", buildAccountPayload(value, options.accountOwnerId!)));
      } else {
        const account = first(lookup), id = remoteId.safeParse(account.id);
        if (!id.success || account.Account_Name !== value.companyName) throw new LeadMutationError(503);
        accountId = id.data;
      }
      rememberRemote(operationId, accountId, "accountId");
      authorizeCreate();
      const contactId = receipt(await request(operationId, "POST", "/Contacts", buildContactPayload(value, accountId)));
      rememberRemote(operationId, contactId, "contactId");
      authorizeCreate();
      const dealId = receipt(await request(operationId, "POST", "/Deals", buildDealPayload(value, { accountId, contactId, assignedExternalId: originalUser.externalUserId! })));
      rememberRemote(operationId, dealId, "dealId");
      let fetched: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 5; attempt++) {
        authorizeCreate();
        const candidate = first(await request(operationId, "GET", `/Deals/${dealId}`));
        if (candidate.id !== dealId) throw new LeadMutationError(503);
        // Task_model stores DealNumber; the controller's Deal_Number polling spelling is inconsistent.
        if (typeof candidate.DealNumber === "string" && candidate.DealNumber.length > 0) { fetched = candidate; break; }
        if (attempt < 4) await wait(700);
      }
      if (!fetched) throw new LeadMutationError(503);
      function optional(field: string, max = 10_000): string | null {
        const raw = fetched![field]; if (raw === undefined || raw === null) return null;
        const parsed = cleanText(max).safeParse(raw); if (!parsed.success) throw new LeadMutationError(503); return parsed.data;
      }
      function lookupName(field: string): string | null {
        if (fetched![field] === undefined || fetched![field] === null) return null;
        const parsed = cleanText(200).safeParse(record(fetched![field]).name); if (!parsed.success) throw new LeadMutationError(503); return parsed.data;
      }
      const name = optional("Deal_Name", 200), stage = optional("Stage", 100);
      if (!name || !stage) throw new LeadMutationError(503);
      const snapshot = { zoho_crm_id: dealId, deal_name: name, deal_number: optional("DealNumber", 100), qual_deal_number: optional("QualDealNumber", 100),
        enq_number: optional("EnquiryNumber", 100), account_name: lookupName("Account_Name"), customer_name: lookupName("Contact_Name"),
        customer_email: optional("Email", 254), customer_contact: optional("Phone", 100), address: optional("Address", 2_000),
        remark: optional("Description"), complaint_info: optional("Description"), status: stage === "Qualification" ? "Pending" : stage,
        owner_id: fetched.Owner == null ? null : (() => { const parsed = remoteId.safeParse(record(fetched.Owner).id); if (!parsed.success) throw new LeadMutationError(503); return parsed.data; })() };
      return safe(() => db.transaction(() => {
        const user = actor(token, true);
        if (user.externalUserId !== originalUser.externalUserId) throw new LeadMutationError(403);
        if (db.prepare("SELECT 1 FROM tasks WHERE zoho_crm_id=?").get(dealId)) throw new LeadMutationError(409);
        const columns = Object.keys(snapshot), values = Object.values(snapshot);
        const inserted = db.prepare(`INSERT INTO tasks(${columns.join(",")},assigned_to,deal_crm_created_by,created_at,updated_at) VALUES(${columns.map(() => "?").join(",")},?,?,?,?)`)
          .run(...values, user.externalUserId, user.localUserId, at(), at());
        const taskId = String(inserted.lastInsertRowid);
        // Newly created tasks start at version 1; finish increments only its response bookkeeping.
        return finish(user, { id: taskId, externalId: dealId, assignedTo: user.externalUserId, status: snapshot.status, quoteId: null, version: 0 },
          operationId, "deal.create", [...columns, "assigned_to", "deal_crm_created_by"]);
      }).immediate());
    });
  }
  return { capabilities, changeStage, createDeal,
    addNote: (token: Token, id: unknown, input: unknown) => mutateNote(token, id, undefined, input, false),
    editNote: (token: Token, id: unknown, noteId: unknown, input: unknown) => mutateNote(token, id, noteId, input, true) };
}
