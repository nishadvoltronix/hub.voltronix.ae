import { createHash } from "node:crypto";
import { taskSyncSource } from "../zoho-sync/provenance.js";
import { MysqlDatabaseError, type MysqlDatabase as Database } from "../db/mysql/database.js";
import { z } from "zod";
import { createAuthService, type AuthUser } from "../auth/service.js";
import { LEAD_TRANSITIONS, type LeadMutationCapabilities, type LeadMutationResult, type ZohoTransport } from "./contracts.js";
import { buildAccountPayload, buildAccountSearchPath, buildContactPayload, buildDealPayload, parseDealInput,
  parseAccountPayloadProfile, parseDealPayloadProfile, parseDealPipeline, type AccountPayloadProfile, type DealPayloadProfile } from "../commercial/deals.js";
import { CommercialError } from "../commercial/validation.js";
import { compare, decimal } from "../commercial/decimal.js";
import { buildStageFields, NATIVE_PRODUCTION_STAGE_PROFILE, parseStagePayloadProfile, stageReadbackMatches, type StagePayloadProfile } from "./stage-profile.js";
import { assertNativeZohoContext, nativeZohoReference, type NativeZohoContext } from "../../integrations/zoho/native-numbering.js";
import { assertZohoActorBinding, ZohoUserBindingError } from "../../integrations/zoho/user-binding.js";

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
function amountReadbackMatches(actual: unknown, expected: string): boolean {
  // The verified transport preserves JSON decimals as strings. Never accept a
  // rounded JavaScript number or commit an amount overwritten by automation.
  const parsed = amount.safeParse(actual);
  return parsed.success && compare(decimal(parsed.data), decimal(expected)) === 0;
}
const remoteDate = z.iso.datetime({ offset: true });
const stageInput = z.object({ ...base, stage: z.enum(LEAD_TRANSITIONS), serviceCharge: amount.optional() }).strict();
const addNoteInput = z.object({ ...base, title: cleanText(200).min(1), content: cleanText(10_000).min(1) }).strict();
const editNoteInput = z.object({ ...base, title: cleanText(200).optional(), content: cleanText(10_000).min(1) }).strict();
const accountSearchResponse = z.object({
  data: z.array(z.object({ id: remoteId, Account_Name: z.string().min(1).max(200) })).max(1),
  info: z.object({ more_records: z.literal(false) }).optional(),
}).strict();
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

export function createLeadMutationsService(db: Database, options: { transport?: ZohoTransport; accountOwnerId?: string;
  accountPayloadProfile?: AccountPayloadProfile; dealPayloadProfile?: DealPayloadProfile; dealPipeline?: string; stagePayloadProfile?: StagePayloadProfile;
  production?: NativeZohoContext;
  now?: () => number; wait?: (ms: number) => Promise<void> } = {}) {
  // Composition chooses an explicit source profile before any auth, journal or
  // HTTP work. No environment discovery, tenant guessing or automatic fallback.
  const dealPayloadProfile = parseDealPayloadProfile(options.dealPayloadProfile === undefined ? "legacy-create-v1" : options.dealPayloadProfile);
  const accountPayloadProfile = parseAccountPayloadProfile(options.accountPayloadProfile === undefined ? "legacy-account-email-v1" : options.accountPayloadProfile);
  const dealPipeline = options.dealPipeline === undefined ? undefined : parseDealPipeline(options.dealPipeline);
  const stagePayloadProfile = parseStagePayloadProfile(options.stagePayloadProfile === undefined ? "legacy-stage-v1" : options.stagePayloadProfile);
  const production = options.production;
  if (production) { assertNativeZohoContext(production); if (stagePayloadProfile !== NATIVE_PRODUCTION_STAGE_PROFILE) throw new CommercialError(400); }
  const now = options.now ?? Date.now, auth = createAuthService(db, { now });
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const at = () => new Date(now()).toISOString();
  async function safe<T>(operation: () => Promise<T>): Promise<T> {
    try { return (await operation()); } catch (error) { if (error instanceof MysqlDatabaseError && error.code === "MYSQL_CONFLICT") throw new LeadMutationError(409);
      if (error instanceof LeadMutationError) throw error;
      if (error instanceof ZohoUserBindingError) throw new LeadMutationError(403);
      if (error instanceof CommercialError && error.status === 400) throw new LeadMutationError(400); throw new LeadMutationError(503); }
  }
  async function actor(token: Token, create = false): Promise<AuthUser> {
    const user = (await auth.authenticate(token)); if (!user) throw new LeadMutationError(401);
    if (create ? !user.permissions.includes("deals.manage") : !user.permissions.some((p) => p === "leads.manage" || p === "leads.manage.agents")) throw new LeadMutationError(403);
    if (production) await assertZohoActorBinding(db, user, production.organizationId);
    return user;
  }
  async function task(user: AuthUser, id: unknown, stage = false): Promise<Task> {
    if (!localId.safeParse(id).success || !(await auth.canAccessTask(user, id as string))) throw new LeadMutationError(404);
    const row = (await db.prepare("SELECT CAST(id AS CHAR) id,zoho_crm_id externalId,assigned_to assignedTo,status,quote_number quoteId,version FROM tasks WHERE id=?").get(id)) as Task;
    if (stage && (user.externalUserId === null || row.assignedTo !== user.externalUserId)) throw new LeadMutationError(403);
    return row;
  }
  async function note(parent: Task, id: unknown): Promise<Note> {
    if (!localId.safeParse(id).success || !parent.externalId) throw new LeadMutationError(404);
    const row = (await db.prepare("SELECT CAST(id AS CHAR) id,zoho_note_id externalId,note_title title,note_content content FROM job_notes WHERE id=? AND deal_id=?").get(id, parent.externalId)) as Note | undefined;
    if (!row) throw new LeadMutationError(404); return row;
  }
  async function operation(id: string): Promise<Operation | undefined> {
    return (await db.prepare(`SELECT operation_id,CAST(actor_user_id AS CHAR) actor_user_id,CAST(task_id AS CHAR) task_id,kind,request_hash,state,
      CAST(result_task_id AS CHAR) result_task_id,CAST(result_note_id AS CHAR) result_note_id,result_version FROM crm_lead_operations WHERE operation_id=?`).get(id)) as Operation | undefined;
  }
  async function busyOperation(taskId: string) {
    return (await db.prepare("SELECT operation_id FROM crm_lead_operations WHERE task_id=? AND state!='completed' UNION ALL SELECT operation_id FROM crm_commercial_operations WHERE task_id=? AND state!='completed' LIMIT 1")
      .get(taskId, taskId)) as { operation_id: string } | undefined;
  }
  function result(row: Operation): LeadMutationResult {
    if (row.state !== "completed" || !row.result_task_id || !row.result_version) throw new LeadMutationError(409);
    return { operationId: row.operation_id, taskId: row.result_task_id, version: row.result_version,
      ...(production ? { persistence: "zoho" as const, remoteVerified: true as const } : {}),
      ...(row.result_note_id ? { noteId: row.result_note_id } : {}) };
  }
  async function reserve(user: AuthUser, parent: Task, kind: Kind, value: { operationId: string; expectedVersion: number }, hashBody: unknown): Promise<LeadMutationResult | undefined> {
    if (await taskSyncSource(db, parent.id)) throw new LeadMutationError(403);
    const hash = createHash("sha256").update(JSON.stringify(production ? { input: hashBody, production } : hashBody)).digest("hex"), previous = (await operation(value.operationId));
    if (previous) {
      if (previous.actor_user_id !== user.localUserId || previous.task_id !== parent.id || previous.kind !== kind || previous.request_hash !== hash) throw new LeadMutationError(409);
      return result(previous);
    }
    if (value.expectedVersion !== parent.version) throw new LeadMutationError(409);
    if (!options.transport) throw new LeadMutationError(503);
    if (!remoteId.safeParse(parent.externalId).success) throw new LeadMutationError(409);
    if ((await busyOperation(parent.id))) throw new LeadMutationError(409);
    (await db.prepare(`INSERT INTO crm_lead_operations(operation_id,actor_user_id,task_id,kind,request_hash,state,created_at,updated_at) VALUES(?,?,?,?,?,'inflight',?,?)`)
      .run(value.operationId, user.localUserId, parent.id, kind, hash, at(), at()));
  }
  async function request(operationId: string, method: "GET" | "POST" | "PUT", path: string, body?: unknown,
    acceptedStatuses?: readonly number[], ifUnmodifiedSince?: string): Promise<unknown> {
    if (!options.transport) throw new LeadMutationError(503);
    if (method !== "GET") await journal(operationId,
      "remote_effect_possible=1,updated_at=?", [at()], "remote_effect_possible=1", []);
    const response = await options.transport.request({ method, path, ...(body === undefined ? {} : { body }),
      ...(ifUnmodifiedSince === undefined ? {} : { ifUnmodifiedSince }) });
    if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300
      || (acceptedStatuses && !acceptedStatuses.includes(response.status))) throw new LeadMutationError(503);
    if (response.status === 204) return null;
    if (response.body === null || response.body === undefined) throw new LeadMutationError(503);
    return response.body;
  }
  async function current(token: Token, parent: Task, stage = false) {
    (await safe(async () => (await db.transaction(async () => {
      const fresh = (await task((await actor(token)), parent.id, stage));
      if (await taskSyncSource(db, fresh.id)) throw new LeadMutationError(403);
      if (fresh.version !== parent.version || fresh.externalId !== parent.externalId) throw new LeadMutationError(409);
    })())));
  }
  async function verifiedRemoteDeal(operationId: string, parent: Task): Promise<Record<string, unknown>> {
    const remote = first(await request(operationId, "GET", `/Deals/${parent.externalId}`));
    if (remote.id !== parent.externalId || record(remote.VZ_app_user).id !== parent.assignedTo
      || record(remote.$layout_id).id !== production!.dealLayoutId
      || !remoteDate.safeParse(remote.Modified_Time).success || (dealPipeline !== undefined && remote.Pipeline !== dealPipeline)) throw new LeadMutationError(409);
    const matches = ["Pending", "Qualification"].includes(parent.status)
      ? remote.Stage === "Qualification" && remote.VZ_App_Status === "Pending"
      : LEAD_TRANSITIONS.includes(parent.status as typeof LEAD_TRANSITIONS[number]) && stageReadbackMatches(remote, parent.status as typeof LEAD_TRANSITIONS[number], stagePayloadProfile);
    if (!matches) throw new LeadMutationError(409);
    return remote;
  }
  async function rememberRemote(operationId: string, id: string, reference: "accountId" | "contactId" | "dealId" | "noteId" = "dealId") {
    await journal(operationId, "remote_id=?,remote_references=json_set(remote_references,?,?),updated_at=?",
      [id, `$.${reference}`, id, at()], "remote_id=? AND JSON_UNQUOTE(JSON_EXTRACT(remote_references,?))=?", [id, `$.${reference}`, id]);
  }
  async function journal(operationId: string, assignments: string, values: unknown[], unchanged: string, expected: unknown[]) {
    // -FOUND_ROWS reports zero for both lost ownership and an identical update.
    // Prove the latter with a current locking read in this short transaction;
    // the transaction must finish before any next remote request or local commit.
    await safe(async () => db.transaction(async () => {
      const update = await db.prepare(`UPDATE crm_lead_operations SET ${assignments} WHERE operation_id=? AND state='inflight'`)
        .run(...values, operationId);
      if (update.changes === 1) return;
      if (update.changes === 0 && await db.prepare(`SELECT operation_id FROM crm_lead_operations WHERE operation_id=? AND state='inflight' AND ${unchanged} FOR UPDATE`)
        .get(operationId, ...expected)) return;
      throw new LeadMutationError(409);
    }).immediate());
  }
  async function finish(user: AuthUser, parent: Task, operationId: string, action: Kind, fields: string[], noteId?: string): Promise<LeadMutationResult> {
    (await db.prepare("INSERT INTO crm_lead_audit_events(actor_user_id,task_id,operation_id,action,changed_fields,occurred_at) VALUES(?,?,?,?,?,?)")
      .run(user.localUserId, parent.id, operationId, action, JSON.stringify(fields), at()));
    const completed = await db.prepare("UPDATE crm_lead_operations SET state='completed',result_task_id=?,result_note_id=?,result_version=?,updated_at=? WHERE operation_id=? AND state='inflight'")
      .run(parent.id, noteId ?? null, parent.version + 1, at(), operationId);
    if (completed.changes !== 1) throw new LeadMutationError(409);
    return result((await operation(operationId))!);
  }
  async function guarded(operationId: string, work: () => Promise<LeadMutationResult>): Promise<LeadMutationResult> {
    try { return await work(); } catch (error) {
      // No response body, request text, credentials or exception details are persisted or exposed.
      (await safe(async () => (await db.prepare("UPDATE crm_lead_operations SET state='reconciliation',updated_at=? WHERE operation_id=? AND state='inflight'").run(at(), operationId))));
      if (error instanceof LeadMutationError) throw error; throw new LeadMutationError(503);
    }
  }
  async function capabilities(token: Token, id: unknown): Promise<LeadMutationCapabilities> {
    return (await safe(async () => (await db.transaction(async () => {
      const user = (await auth.authenticate(token)); if (!user) throw new LeadMutationError(401);
      const parent = (await task(user, id));
      let bound = true;
      if (production) { try { await assertZohoActorBinding(db, user, production.organizationId); } catch { bound = false; } }
      const canWrite = bound && user.permissions.some((p) => p === "leads.manage" || p === "leads.manage.agents");
      const canStage = canWrite && user.externalUserId !== null && parent.assignedTo === user.externalUserId;
      const blocked = (await busyOperation(parent.id));
      return { version: parent.version, canChangeStage: canStage, canWriteNotes: canWrite,
        stages: canStage ? stages(parent) : [], integrationAvailable: !!options.transport,
        ...(production ? { persistence: "zoho" as const } : {}),
        ...(blocked ? { blockedOperationId: blocked.operation_id } : {}) };
    })())));
  }
  async function changeStage(token: Token, id: unknown, input: unknown): Promise<LeadMutationResult> {
    const start = (await safe(async () => (await db.transaction(async () => {
      const user = (await actor(token)), parent = (await task(user, id, true)), value = parse(stageInput, input);
      // A completed identical request may be replayed after its successful stage change.
      if (!(await operation(value.operationId)) && !stages(parent).includes(value.stage)) throw new LeadMutationError(400);
      const hashBody = stagePayloadProfile === "legacy-stage-v1" ? value : { ...value, stagePayloadProfile };
      const replay = (await reserve(user, parent, "lead.stage", value, hashBody)); return { user, parent, value, replay };
    }).immediate())));
    if (start.replay) return start.replay;
    const { parent, value } = start;
    return (await guarded(value.operationId, async () => {
      (await current(token, parent, true));
      const before = production ? await verifiedRemoteDeal(value.operationId, parent) : undefined;
      const referenceField = stageFields[value.stage][0];
      const localReferenceOnly = !!production && value.stage !== "Proposal/Price Quote";
      const reference = production ? nativeZohoReference(({ "Site Visit": "site", "Proposal/Price Quote": "quote", "Closed Won": "job", "Closed Lost": "lost" } as const)[value.stage],
        parent.externalId!, before![referenceField], parent.quoteId) : undefined;
      if (production) await current(token, parent, true);
      const receiptId = receipt(await request(value.operationId, "PUT", `/Deals/${parent.externalId}`, { data: [{ ...buildStageFields(value.stage, stagePayloadProfile),
        ...(reference === undefined || localReferenceOnly ? {} : { [referenceField]: reference }),
        ...(value.serviceCharge === undefined ? {} : { Amount: value.serviceCharge }) }] }, undefined, before?.Modified_Time as string | undefined));
      if (receiptId !== parent.externalId) throw new LeadMutationError(503);
      (await rememberRemote(value.operationId, receiptId));
      let remote: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 12; attempt++) {
        (await current(token, parent, true));
        const fetched = first(await request(value.operationId, "GET", `/Deals/${parent.externalId}`));
        if (fetched.id !== parent.externalId) throw new LeadMutationError(503);
        if (production && (record(fetched.VZ_app_user).id !== parent.assignedTo || record(fetched.$layout_id).id !== production.dealLayoutId
          || (localReferenceOnly ? (fetched[referenceField] ?? null) !== (before![referenceField] ?? null) : fetched[referenceField] !== reference)
          || fetched.Pipeline !== dealPipeline)) throw new LeadMutationError(503);
        const numberField = stageFields[value.stage][0];
        if (stageReadbackMatches(fetched, value.stage, stagePayloadProfile) &&
          (value.serviceCharge === undefined || amountReadbackMatches(fetched.Amount, value.serviceCharge)) &&
          typeof fetched.DealNumber === "string" && fetched.DealNumber.length > 0 &&
          (localReferenceOnly || value.stage === "Closed Lost" || (typeof fetched[numberField] === "string" && (fetched[numberField] as string).length > 0))) { remote = fetched; break; }
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
      if (localReferenceOnly) changes[numberColumns[referenceField]!] = reference!;
      for (const [field, column] of Object.entries(dateColumns)) {
        if (remote[field] !== undefined && remote[field] !== null && remote[field] !== "") {
          const date = remote[field];
          if (typeof date !== "string" || !remoteDate.safeParse(date).success || !Number.isFinite(Date.parse(date))) throw new LeadMutationError(503);
          changes[column] = new Date(date).toISOString();
        }
      }
      return (await safe(async () => (await db.transaction(async () => {
        const user = (await actor(token)), fresh = (await task(user, id, true));
        if (fresh.version !== value.expectedVersion || fresh.externalId !== parent.externalId) throw new LeadMutationError(409);
        const keys = Object.keys(changes);
        const update = (await db.prepare(`UPDATE tasks SET ${keys.map((key) => `${key}=?`).join(",")},version=version+1,updated_at=? WHERE id=? AND version=?`)
          .run(...Object.values(changes), at(), parent.id, value.expectedVersion));
        if (update.changes !== 1) throw new LeadMutationError(409);
        (await db.prepare("INSERT INTO tasks_status_log(Task_ID,User_ID,Status,Task_Log_Create_Date) VALUES(?,?,?,?)").run(parent.id, user.localUserId, value.stage, at()));
        return (await finish(user, parent, value.operationId, "lead.stage", keys));
      }).immediate())));
    }));
  }
  async function mutateNote(token: Token, id: unknown, noteId: unknown, input: unknown, edit: boolean): Promise<LeadMutationResult> {
    const start = (await safe(async () => (await db.transaction(async () => {
      const user = (await actor(token)), parent = (await task(user, id)), previous = edit ? (await note(parent, noteId)) : undefined;
      const value = edit ? parse(editNoteInput, input) : parse(addNoteInput, input);
      const title = value.title || previous?.title || "Lead Note";
      const replay = (await reserve(user, parent, edit ? "note.edit" : "note.create", value, { ...value, noteId: previous?.id ?? null }));
      return { parent, previous, value, title, replay };
    }).immediate())));
    if (start.replay) return start.replay;
    const { parent, previous, value, title } = start;
    return (await guarded(value.operationId, async () => {
      (await current(token, parent));
      if (production) await verifiedRemoteDeal(value.operationId, parent);
      if (previous?.externalId && !remoteId.safeParse(previous.externalId).success) throw new LeadMutationError(409);
      let remoteModifiedAt: string | undefined;
      if (production && previous?.externalId) {
        const before = first(await request(value.operationId, "GET", `/Notes/${previous.externalId}`));
        if (before.id !== previous.externalId || record(before.Parent_Id).id !== parent.externalId || before.Note_Title !== previous.title
          || before.Note_Content !== previous.content || !remoteDate.safeParse(before.Modified_Time).success) throw new LeadMutationError(409);
        remoteModifiedAt = before.Modified_Time as string;
      }
      if (production) await current(token, parent);
      const remoteNote = receipt(await request(value.operationId, previous?.externalId ? "PUT" : "POST",
        previous?.externalId ? `/Notes/${previous.externalId}` : `/Deals/${parent.externalId}/Notes`,
        { data: [{ Note_Title: title, Note_Content: value.content }] }, undefined, remoteModifiedAt));
      if (previous?.externalId && remoteNote !== previous.externalId) throw new LeadMutationError(503);
      (await rememberRemote(value.operationId, remoteNote, "noteId"));
      if (production) {
        const after = first(await request(value.operationId, "GET", `/Notes/${remoteNote}`));
        if (after.id !== remoteNote || record(after.Parent_Id).id !== parent.externalId || after.Note_Title !== title || after.Note_Content !== value.content) throw new LeadMutationError(503);
      }
      return (await safe(async () => (await db.transaction(async () => {
        const user = (await actor(token)), fresh = (await task(user, id));
        if (fresh.version !== value.expectedVersion || fresh.externalId !== parent.externalId) throw new LeadMutationError(409);
        if (previous) {
          const freshNote = (await note(fresh, previous.id));
          if (freshNote.externalId !== previous.externalId || freshNote.title !== previous.title || freshNote.content !== previous.content) throw new LeadMutationError(409);
          (await db.prepare("UPDATE job_notes SET note_title=?,note_content=?,zoho_note_id=?,updated_at=? WHERE id=? AND deal_id=?")
            .run(title, value.content, remoteNote, at(), previous.id, fresh.externalId));
        }
        const savedId = previous?.id ?? String((await db.prepare("INSERT INTO job_notes(deal_id,note_title,note_content,zoho_note_id,created_at,updated_at) VALUES(?,?,?,?,?,?)")
          .run(fresh.externalId, title, value.content, remoteNote, at(), at())).lastInsertRowid);
        const changed = (await db.prepare("UPDATE tasks SET version=version+1,updated_at=? WHERE id=? AND version=?").run(at(), fresh.id, value.expectedVersion));
        if (changed.changes !== 1) throw new LeadMutationError(409);
        return (await finish(user, parent, value.operationId, edit ? "note.edit" : "note.create", ["note_title", "note_content", "zoho_note_id"], savedId));
      }).immediate())));
    }));
  }
  async function createDeal(token: Token, input: unknown): Promise<LeadMutationResult> {
    const start = (await safe(async () => (await db.transaction(async () => {
      const user = (await actor(token, true));
      if (!remoteId.safeParse(user.externalUserId).success) throw new LeadMutationError(403);
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new LeadMutationError(400);
      const { operationId: rawOperation, ...fields } = input as Record<string, unknown>;
      const operationId = parse(z.uuid(), rawOperation), value = parseDealInput(fields), searchPath = buildAccountSearchPath(value.companyName);
      // The common Contacts/Accounts/Deals limits are verified by the explicit
      // production metadata profile. Reject before a journal or remote record.
      if (production && (value.closingDate === undefined || value.firstName.length > 40 || value.lastName.length > 80 || `${value.firstName} ${value.lastName}`.length > 120
        || value.email.length > 100 || value.phone.length > 30 || value.mobile.length > 30 || value.address.length > 250)) throw new LeadMutationError(400);
      // Preserve existing default-profile replay hashes. An alternate mapping
      // has a distinct effect and must not reuse a reservation from another one.
      const hash = createHash("sha256").update(JSON.stringify({ operationId, ...value,
        ...(dealPayloadProfile === "legacy-create-v1" ? {} : { dealPayloadProfile }),
        ...(accountPayloadProfile === "legacy-account-email-v1" ? {} : { accountPayloadProfile }),
        ...(dealPipeline === undefined ? {} : { dealPipeline }), ...(production ? { production } : {}) })).digest("hex"), previous = (await operation(operationId));
      if (previous) {
        if (previous.actor_user_id !== user.localUserId || previous.kind !== "deal.create" || previous.request_hash !== hash) throw new LeadMutationError(409);
        const replay = result(previous);
        // A successful creation replay must still belong to this external identity.
        const saved = (await db.prepare("SELECT assigned_to FROM tasks WHERE id=?").get(replay.taskId)) as { assigned_to: string | null } | undefined;
        if (!saved || saved.assigned_to !== user.externalUserId) throw new LeadMutationError(404);
        return { user, operationId, value, searchPath, replay };
      }
      if (!options.transport || !remoteId.safeParse(options.accountOwnerId).success) throw new LeadMutationError(503);
      if ((await db.prepare("SELECT 1 FROM crm_lead_operations WHERE actor_user_id=? AND kind='deal.create' AND state!='completed'").get(user.localUserId))) throw new LeadMutationError(409);
      (await db.prepare("INSERT INTO crm_lead_operations(operation_id,actor_user_id,kind,request_hash,state,created_at,updated_at) VALUES(?,?,'deal.create',?,'inflight',?,?)")
        .run(operationId, user.localUserId, hash, at(), at()));
      return { user, operationId, value, searchPath, replay: undefined };
    }).immediate())));
    if (start.replay) return start.replay;
    const { user: originalUser, operationId, value, searchPath } = start;
    return (await guarded(operationId, async () => {
      async function authorizeCreate() {
        const user = (await safe(async () => (await actor(token, true))));
        if (user.externalUserId !== originalUser.externalUserId) throw new LeadMutationError(403);
      }
      (await authorizeCreate());
      const lookup = await request(operationId, "GET", searchPath, undefined, [200, 204]);
      let candidates: { id: string; Account_Name: string }[] = [];
      if (lookup !== null) {
        const parsed = accountSearchResponse.safeParse(lookup);
        // Empty or singleton partial pages and error/data hybrids are not proof
        // of absence or uniqueness. Never create or bind an account from them.
        if (!parsed.success || (production && parsed.data.info?.more_records !== false)) throw new LeadMutationError(503);
        candidates = parsed.data.data;
        if (candidates[0] && candidates[0].Account_Name !== value.companyName) throw new LeadMutationError(503);
      }
      let accountId: string;
      // Only 204 or a validated empty 200 response permits creation. Pagination
      // info remains optional for compatibility; when present it must be complete.
      if (candidates.length === 0) {
        (await authorizeCreate());
        accountId = receipt(await request(operationId, "POST", "/Accounts", buildAccountPayload(value, options.accountOwnerId!, accountPayloadProfile)));
        await rememberRemote(operationId, accountId, "accountId");
        if (production) {
          const account = first(await request(operationId, "GET", `/Accounts/${accountId}`));
          if (account.id !== accountId || account.Account_Name !== value.companyName || account.Phone !== value.phone || record(account.Owner).id !== options.accountOwnerId) throw new LeadMutationError(503);
        }
      } else {
        accountId = candidates[0]!.id;
        await rememberRemote(operationId, accountId, "accountId");
        if (production) {
          const account = first(await request(operationId, "GET", `/Accounts/${accountId}`));
          if (account.id !== accountId || account.Account_Name !== value.companyName) throw new LeadMutationError(503);
        }
      }
      (await authorizeCreate());
      const contactId = receipt(await request(operationId, "POST", "/Contacts", buildContactPayload(value, accountId)));
      (await rememberRemote(operationId, contactId, "contactId"));
      if (production) {
        const contact = first(await request(operationId, "GET", `/Contacts/${contactId}`));
        if (contact.id !== contactId || contact.First_Name !== value.firstName || contact.Last_Name !== value.lastName
          || contact.Email !== value.email || record(contact.Account_Name).id !== accountId) throw new LeadMutationError(503);
      }
      (await authorizeCreate());
      const dealId = receipt(await request(operationId, "POST", "/Deals", buildDealPayload(value,
        { accountId, contactId, assignedExternalId: originalUser.externalUserId!, ...(production ? { layoutId: production.dealLayoutId } : {}) }, dealPayloadProfile, dealPipeline)));
      (await rememberRemote(operationId, dealId, "dealId"));
      let fetched: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 5; attempt++) {
        (await authorizeCreate());
        const candidate = first(await request(operationId, "GET", `/Deals/${dealId}`));
        if (candidate.id !== dealId) throw new LeadMutationError(503);
        if (dealPipeline !== undefined && candidate.Pipeline !== dealPipeline) throw new LeadMutationError(503);
        // Task_model stores DealNumber; the controller's Deal_Number polling spelling is inconsistent.
        if (typeof candidate.DealNumber === "string" && candidate.DealNumber.length > 0) { fetched = candidate; break; }
        if (attempt < 4) await wait(700);
      }
      if (!fetched) throw new LeadMutationError(503);
      if (production) {
        const matchesCreatedDeal = (row: Record<string, unknown>) => row.id === dealId && row.Deal_Name === `${value.firstName} ${value.lastName}`
          && row.Stage === "Qualification" && row.VZ_App_Status === "Pending" && row.Pipeline === dealPipeline
          && record(row.Account_Name).id === accountId && record(row.Contact_Name).id === contactId
          && record(row.VZ_app_user).id === originalUser.externalUserId && row.Email === value.email
          && record(row.$layout_id).id === production.dealLayoutId
          && row.Closing_Date === value.closingDate
          && row.Assign_Department1 === value.department && remoteDate.safeParse(row.Modified_Time).success;
        if (!matchesCreatedDeal(fetched)) throw new LeadMutationError(503);
        const reference = nativeZohoReference("qualification", dealId, fetched.QualDealNumber, fetched.DealNumber);
        if (fetched.QualDealNumber !== reference) {
          await authorizeCreate();
          const acknowledged = receipt(await request(operationId, "PUT", `/Deals/${dealId}`, { data: [{ QualDealNumber: reference }] }, undefined, fetched.Modified_Time as string));
          if (acknowledged !== dealId) throw new LeadMutationError(503);
          fetched = first(await request(operationId, "GET", `/Deals/${dealId}`));
          if (!matchesCreatedDeal(fetched) || fetched.QualDealNumber !== reference) throw new LeadMutationError(503);
        }
      }
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
      return (await safe(async () => (await db.transaction(async () => {
        const user = (await actor(token, true));
        if (user.externalUserId !== originalUser.externalUserId) throw new LeadMutationError(403);
        if ((await db.prepare("SELECT 1 FROM tasks WHERE zoho_crm_id=?").get(dealId))) throw new LeadMutationError(409);
        const columns = Object.keys(snapshot), values = Object.values(snapshot);
        const inserted = (await db.prepare(`INSERT INTO tasks(${columns.join(",")},assigned_to,deal_crm_created_by,created_at,updated_at) VALUES(${columns.map(() => "?").join(",")},?,?,?,?)`)
          .run(...values, user.externalUserId, user.localUserId, at(), at()));
        const taskId = String(inserted.lastInsertRowid);
        // Newly created tasks start at version 1; finish increments only its response bookkeeping.
        return (await finish(user, { id: taskId, externalId: dealId, assignedTo: user.externalUserId, status: snapshot.status, quoteId: null, version: 0 },
          operationId, "deal.create", [...columns, "assigned_to", "deal_crm_created_by"]));
      }).immediate())));
    }));
  }
  return { capabilities, changeStage, createDeal,
    addNote: async (token: Token, id: unknown, input: unknown) => (await mutateNote(token, id, undefined, input, false)),
    editNote: async (token: Token, id: unknown, noteId: unknown, input: unknown) => (await mutateNote(token, id, noteId, input, true)) };
}
