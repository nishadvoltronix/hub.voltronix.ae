import { createHash } from "node:crypto";
import { z } from "zod";
import type { CrmWriteCapabilities, LocalPersistenceResult } from "@voltronix/crm-contracts";
import type { SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { createAuthService, type AuthUser } from "../../tests/sqlite-reference/auth/service.js";
import type { LeadMutationCapabilities, LeadMutationResult } from "../../tests/sqlite-reference/lead-mutations/contracts.js";
import type { CommercialMutationResult } from "../../tests/sqlite-reference/commercial/persistence-contracts.js";
import { singleLine, multiLine } from "../../tests/sqlite-reference/commercial/validation.js";

type Token = string | null | undefined;
type NoteResult = LeadMutationResult & LocalPersistenceResult;
type ProductResult = CommercialMutationResult & LocalPersistenceResult;
type Parent = { id: string; externalId: string | null; version: number };
type Note = { id: string; title: string };
type LeadOperation = { actor: string; taskId: string | null; kind: string; request_hash: string; state: string;
  remote_effect_possible: number; remote_id: string | null; remote_references: string;
  result_task_id: string | null; result_note_id: string | null; result_version: number | null };
type ProductOperation = { actor: string; taskId: string | null; kind: string; request_hash: string; state: string;
  remote_effect_possible: number; remote_references: string; result_json: string | null };

export class LocalWriteError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409 | 503) {
    super(({ 400: "Invalid local change.", 401: "Sign in required.", 403: "Access denied.",
      404: "Record not found.", 409: "The record changed or this operation is unavailable. Reload before continuing.",
      503: "Local changes are temporarily unavailable." })[status]);
    this.name = "LocalWriteError";
  }
}
const localId = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1);
const resultVersion = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const text = (max: number) => z.string().trim().max(max).refine(value => !value.includes("\0"));
const noteBase = { operationId: z.uuid(), expectedVersion: version };
const addNoteInput = z.object({ ...noteBase, title: text(200).min(1), content: text(10_000).min(1) }).strict();
const editNoteInput = z.object({ ...noteBase, title: text(200).optional(), content: text(10_000).min(1) }).strict();
const productInput = z.object({ operationId: z.uuid(), name: singleLine(200).min(1), description: multiLine(10_000) }).strict();
const productResult = z.object({ operationId: z.uuid(), productId: z.string().regex(/^9[0-9]{39}$/),
  version: z.literal(1), persistence: z.literal("local-demo") }).strict();
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const value = schema.safeParse(input); if (!value.success) throw new LocalWriteError(400); return value.data;
}
function hash(kind: string, input: unknown) {
  return createHash("sha256").update(JSON.stringify({ persistence: "local-demo", kind, input })).digest("hex");
}
/** A numeric local namespace preserves the existing product wire validators.
 * This deterministic 40-digit key is not a Zoho ID or an acknowledgement. */
function productId(operationId: string) {
  return "9" + BigInt("0x" + operationId.replaceAll("-", "")).toString().padStart(39, "0");
}

/** Only composed by the isolated SQLite demo. All writes, journal completion and
 * immutable audit happen in one synchronous transaction. No remote call exists.
 * Local journal provenance is completed + remote_effect_possible=0, with remote
 * IDs/references unset and a local-demo request-hash discriminator. Products also
 * persist the explicit local-demo result. Remote service completions require an
 * attempted remote write and cannot be replayed through this implementation. */
export function createLocalDemoWrites(db: SqliteDatabase, options: { now?: () => number } = {}) {
  const auth = createAuthService(db), now = options.now ?? Date.now;
  const at = () => new Date(now()).toISOString();
  function current(token: Token): AuthUser {
    const user = auth.authenticate(token); if (!user) throw new LocalWriteError(401); return user;
  }
  function actor(token: Token, product = false) {
    const user = current(token);
    if (product ? !user.permissions.includes("items.write") : !user.permissions.some(key => ["leads.manage", "leads.manage.agents"].includes(key))) throw new LocalWriteError(403);
    return user;
  }
  function parent(user: AuthUser, id: unknown): Parent {
    if (!localId.safeParse(id).success || !auth.canAccessTask(user, id as string)) throw new LocalWriteError(404);
    const row = db.prepare("SELECT CAST(id AS TEXT) id,zoho_crm_id externalId,version FROM tasks WHERE id=?").get(id) as Parent;
    if (!row.externalId) throw new LocalWriteError(409); return row;
  }
  function note(task: Parent, id: unknown): Note {
    if (!localId.safeParse(id).success) throw new LocalWriteError(404);
    const row = db.prepare("SELECT CAST(id AS TEXT) id,note_title title FROM job_notes WHERE id=? AND deal_id=?").get(id, task.externalId) as Note | undefined;
    if (!row) throw new LocalWriteError(404); return row;
  }
  function busy(taskId: string) {
    return !!db.prepare("SELECT 1 FROM crm_lead_operations WHERE task_id=? AND state!='completed' UNION ALL SELECT 1 FROM crm_commercial_operations WHERE task_id=? AND state!='completed' LIMIT 1").get(taskId, taskId);
  }
  function capabilities(token: Token): CrmWriteCapabilities {
    return db.transaction(() => {
      const user = current(token);
      return { persistence: "local-demo" as const, productCreate: user.permissions.includes("items.write"),
        leadNotes: user.permissions.some(key => ["leads.manage", "leads.manage.agents"].includes(key)), integrationAvailable: false as const };
    })();
  }
  function leadCapabilities(token: Token, id: unknown, base: LeadMutationCapabilities): LeadMutationCapabilities {
    return db.transaction(() => {
      const user = current(token);
      if (!localId.safeParse(id).success || !auth.canAccessTask(user, id as string)) throw new LocalWriteError(404);
      const row = db.prepare("SELECT zoho_crm_id externalId FROM tasks WHERE id=?").get(id) as { externalId: string | null };
      return { ...base, canWriteNotes: base.canWriteNotes && !!row.externalId && !busy(id as string) };
    })();
  }
  function mutateNote(token: Token, id: unknown, noteId: unknown, input: unknown, edit: boolean): NoteResult {
    return db.transaction((): NoteResult => {
      const user = actor(token), task = parent(user, id), previous = edit ? note(task, noteId) : undefined;
      const value = edit ? parse(editNoteInput, input) : parse(addNoteInput, input);
      const kind = edit ? "note.edit" : "note.create", requestHash = hash(kind, { taskId: task.id, noteId: previous?.id ?? null, ...value });
      const old = db.prepare(`SELECT CAST(actor_user_id AS TEXT) actor,CAST(task_id AS TEXT) taskId,kind,request_hash,state,
        remote_effect_possible,remote_id,remote_references,CAST(result_task_id AS TEXT) result_task_id,
        CAST(result_note_id AS TEXT) result_note_id,result_version FROM crm_lead_operations WHERE operation_id=?`).get(value.operationId) as LeadOperation | undefined;
      if (db.prepare("SELECT 1 FROM crm_commercial_operations WHERE operation_id=?").get(value.operationId)) throw new LocalWriteError(409);
      if (old) {
        if (old.actor !== user.localUserId || old.taskId !== task.id || old.kind !== kind || old.request_hash !== requestHash
          || old.state !== "completed" || old.remote_effect_possible !== 0 || old.remote_id !== null || old.remote_references !== "{}"
          || old.result_task_id !== task.id || !old.result_note_id || !resultVersion.safeParse(old.result_version).success) throw new LocalWriteError(409);
        return { operationId: value.operationId, taskId: task.id, noteId: old.result_note_id, version: old.result_version!, persistence: "local-demo" };
      }
      if (!version.safeParse(task.version).success || task.version !== value.expectedVersion || busy(task.id)) throw new LocalWriteError(409);
      const timestamp = at(), title = value.title || previous?.title || "Lead Note";
      db.prepare("INSERT INTO crm_lead_operations(operation_id,actor_user_id,task_id,kind,request_hash,state,created_at,updated_at) VALUES(?,?,?,?,?,'inflight',?,?)")
        .run(value.operationId, user.localUserId, task.id, kind, requestHash, timestamp, timestamp);
      let savedId: string;
      if (previous) {
        const changed = db.prepare("UPDATE job_notes SET note_title=?,note_content=?,updated_at=? WHERE id=? AND deal_id=?")
          .run(title, value.content, timestamp, previous.id, task.externalId);
        if (changed.changes !== 1) throw new LocalWriteError(409); savedId = previous.id;
      } else {
        savedId = String(db.prepare("INSERT INTO job_notes(deal_id,note_title,note_content,created_at,updated_at) VALUES(?,?,?,?,?)")
          .run(task.externalId, title, value.content, timestamp, timestamp).lastInsertRowid);
      }
      const changed = db.prepare("UPDATE tasks SET version=version+1,updated_at=? WHERE id=? AND version=?").run(timestamp, task.id, value.expectedVersion);
      if (changed.changes !== 1) throw new LocalWriteError(409);
      db.prepare("INSERT INTO crm_lead_audit_events(actor_user_id,task_id,operation_id,action,changed_fields,occurred_at) VALUES(?,?,?,?,?,?)")
        .run(user.localUserId, task.id, value.operationId, kind, JSON.stringify(["note_title", "note_content"]), timestamp);
      const finished = db.prepare("UPDATE crm_lead_operations SET state='completed',result_task_id=?,result_note_id=?,result_version=?,updated_at=? WHERE operation_id=? AND state='inflight'")
        .run(task.id, savedId, task.version + 1, timestamp, value.operationId);
      if (finished.changes !== 1) throw new LocalWriteError(409);
      return { operationId: value.operationId, taskId: task.id, noteId: savedId, version: task.version + 1, persistence: "local-demo" };
    }).immediate();
  }
  function createProduct(token: Token, input: unknown): ProductResult {
    return db.transaction(() => {
      const user = actor(token, true), value = parse(productInput, input), kind = "product.create", requestHash = hash(kind, value);
      const old = db.prepare(`SELECT CAST(actor_user_id AS TEXT) actor,CAST(task_id AS TEXT) taskId,kind,request_hash,state,
        remote_effect_possible,remote_references,result_json FROM crm_commercial_operations WHERE operation_id=?`).get(value.operationId) as ProductOperation | undefined;
      if (db.prepare("SELECT 1 FROM crm_lead_operations WHERE operation_id=?").get(value.operationId)) throw new LocalWriteError(409);
      if (old) {
        if (old.actor !== user.localUserId || old.taskId !== null || old.kind !== kind || old.request_hash !== requestHash || old.state !== "completed"
          || old.remote_effect_possible !== 0 || old.remote_references !== "{}" || !old.result_json) throw new LocalWriteError(409);
        const result = productResult.safeParse(JSON.parse(old.result_json));
        if (!result.success || result.data.operationId !== value.operationId || result.data.productId !== productId(value.operationId)) throw new LocalWriteError(409);
        return result.data;
      }
      if (db.prepare("SELECT 1 FROM crm_commercial_operations WHERE actor_user_id=? AND kind='product.create' AND state!='completed'").get(user.localUserId)) throw new LocalWriteError(409);
      const id = productId(value.operationId), timestamp = at();
      if (db.prepare("SELECT 1 FROM products WHERE product_id=?").get(id)) throw new LocalWriteError(409);
      db.prepare("INSERT INTO crm_commercial_operations(operation_id,actor_user_id,kind,request_hash,state,created_at,updated_at) VALUES(?,?,?,?,'inflight',?,?)")
        .run(value.operationId, user.localUserId, kind, requestHash, timestamp, timestamp);
      db.prepare("INSERT INTO products(product_id,product_name,description,created_at,updated_at) VALUES(?,?,?,?,?)")
        .run(id, value.name, value.description, timestamp, timestamp);
      const result: ProductResult = { operationId: value.operationId, productId: id, version: 1, persistence: "local-demo" };
      db.prepare("INSERT INTO crm_commercial_audit_events(actor_user_id,operation_id,action,target_id,changed_fields,occurred_at) VALUES(?,?,?,?,?,?)")
        .run(user.localUserId, value.operationId, kind, id, JSON.stringify(["product_name", "description"]), timestamp);
      const finished = db.prepare("UPDATE crm_commercial_operations SET state='completed',result_json=?,updated_at=? WHERE operation_id=? AND state='inflight'")
        .run(JSON.stringify(result), timestamp, value.operationId);
      if (finished.changes !== 1) throw new LocalWriteError(409); return result;
    }).immediate();
  }
  return { capabilities, leadCapabilities, createProduct,
    addNote: (token: Token, id: unknown, input: unknown) => mutateNote(token, id, undefined, input, false),
    editNote: (token: Token, id: unknown, noteId: unknown, input: unknown) => mutateNote(token, id, noteId, input, true) };
}
