import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { createAuthService } from "../../tests/sqlite-reference/auth/service.js";
import { createAttachmentsService, AttachmentError, validateContent, type Attachment } from "../../tests/sqlite-reference/attachments/service.js";
import { LocalWorkflowError, type createLocalWorkflowService } from "./workflow-service.js";

type Token = string | null | undefined;
const pagination = z.object({ page: z.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(25) }).strict();
const metadata = z.object({ expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  name: z.string().min(1).max(120), mediaType: z.string().max(120) }).strict();
const projection = "id,file_name AS name,media_type AS mediaType,file_size AS size,created_at AS createdAt";
const canWrite = (permissions: string[]) => permissions.some(key => ["leads.manage", "leads.manage.agents"].includes(key));

/** Keep every established attachment scope intact. The sole additional scope is
 * an authenticated local creator whose immutable creation provenance and current
 * lead permissions pass the existing local workflow guard. Historical NULL IDs,
 * guessed creators and non-owners never acquire access through this adapter. */
export function createLocalAttachmentsService(db: SqliteDatabase, workflow: ReturnType<typeof createLocalWorkflowService>) {
  const original = createAttachmentsService(db), auth = createAuthService(db);
  function localParent(token: Token, taskId: string, write = false) {
    const user = auth.authenticate(token); if (!user) throw new AttachmentError(401);
    if (!workflow.isLocal(taskId)) throw new AttachmentError(404);
    let task;
    try { task = workflow.task(user, taskId); }
    catch (error) {
      if (error instanceof LocalWorkflowError) throw new AttachmentError(error.status);
      throw error;
    }
    if (task.ownerId !== user.localUserId) throw new AttachmentError(404);
    if (write && !canWrite(user.permissions)) throw new AttachmentError(403);
    return { user, task };
  }
  function run<T>(existing: () => T, local: () => T, write = false): T {
    try {
      const operation = db.transaction(() => {
        try { return existing(); }
        catch (error) {
          // No fallback on auth failure, write denial, conflicts or corruption.
          if (!(error instanceof AttachmentError) || error.status !== 404) throw error;
          return local();
        }
      });
      return write ? operation.immediate() : operation();
    } catch (error) {
      if (error instanceof AttachmentError) throw error;
      throw new AttachmentError(503);
    }
  }
  function authorizeUpload(token: Token, taskId: string) {
    return run(() => original.authorizeUpload(token, taskId), () => { localParent(token, taskId, true); });
  }
  function list(token: Token, taskId: string, input: unknown = {}) {
    return run(() => original.list(token, taskId, input), () => {
      const { user, task } = localParent(token, taskId), parsed = pagination.safeParse(input);
      if (!parsed.success) throw new AttachmentError(400);
      const { page, pageSize } = parsed.data;
      const total = (db.prepare("SELECT COUNT(*) n FROM task_attachment WHERE task_id=?").get(taskId) as { n: number }).n;
      const items = db.prepare(`SELECT ${projection} FROM task_attachment WHERE task_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?`)
        .all(taskId, pageSize, (page - 1) * pageSize) as Attachment[];
      return { items, total, page, pageSize, version: task.version, canUpload: canWrite(user.permissions) };
    });
  }
  function upload(token: Token, taskId: string, input: unknown, bytes: Buffer) {
    return run(() => original.upload(token, taskId, input, bytes), () => {
      // This runs again after the multipart body has been consumed, with fresh
      // auth/provenance/permission checks and the version CAS in one transaction.
      const { user, task } = localParent(token, taskId, true), parsed = metadata.safeParse(input);
      if (!parsed.success || !Buffer.isBuffer(bytes)) throw new AttachmentError(400);
      const value = parsed.data, mediaType = validateContent(value.name, value.mediaType, bytes);
      if (!Number.isSafeInteger(task.version) || task.version >= Number.MAX_SAFE_INTEGER || task.version !== value.expectedVersion) throw new AttachmentError(409);
      const id = randomUUID(), at = new Date().toISOString();
      db.prepare("INSERT INTO task_attachment(id,task_id,user_id,uploaded_by,file_name,media_type,file_size,content_sha256,content,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(id, taskId, user.externalUserId, user.localUserId, value.name, mediaType, bytes.length, createHash("sha256").update(bytes).digest("hex"), bytes, at);
      if (db.prepare("UPDATE tasks SET version=version+1,updated_at=? WHERE id=? AND version=?").run(at, taskId, task.version).changes !== 1) throw new AttachmentError(409);
      db.prepare("INSERT INTO crm_attachment_audit_events(actor_user_id,task_id,attachment_id,action,occurred_at) VALUES(?,?,?,'attachments.create',?)")
        .run(user.localUserId, taskId, id, at);
      return { id, version: task.version + 1 };
    }, true);
  }
  function download(token: Token, id: string) {
    return run(() => original.download(token, id), () => {
      if (!z.uuid().safeParse(id).success) throw new AttachmentError(404);
      const parent = db.prepare("SELECT CAST(task_id AS TEXT) taskId FROM task_attachment WHERE id=?").get(id) as { taskId: string } | undefined;
      if (!parent) throw new AttachmentError(404);
      localParent(token, parent.taskId);
      const row = db.prepare(`SELECT ${projection},content,content_sha256 AS digest FROM task_attachment WHERE id=?`).get(id) as Attachment & { content: Buffer; digest: string };
      if (row.content.length !== row.size || createHash("sha256").update(row.content).digest("hex") !== row.digest) throw new AttachmentError(503);
      return { id: row.id, name: row.name, mediaType: row.mediaType, size: row.size, content: row.content };
    });
  }
  return { authorizeUpload, list, upload, download };
}
