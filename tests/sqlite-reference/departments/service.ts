import { logAttachmentLimit, logAttachmentExtensions } from "@voltronix/crm-contracts";
import type { Database } from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { createAuthService, type AuthUser } from "../auth/service";
import { DEPARTMENT_PERMISSIONS } from "../auth/permissions";
import { AttachmentError, validateContent } from "../attachments/service";
import { ASSIGNMENT_STATUSES, DEPARTMENTS, LOG_OPTIONS, type AccountAssignment, type Assignment, type Department, type DepartmentJob, type JobAssignments, type Page, type WorkLog } from "./contracts";

type Token = string | null | undefined;
export class DepartmentsError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409 | 503) {
    super(({ 400: "Invalid department input.", 401: "Sign in required.", 403: "Access denied.",
      404: "Department job not found.", 409: "The job changed or this operation is unavailable. Reload and try again.",
      503: "Department workflows are temporarily unavailable." })[status]);
    this.name = "DepartmentsError";
  }
}
const identifier = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const text = (max: number) => z.string().trim().max(max).refine((v) => !v.includes("\0"));
const pageInput = z.object({ page: z.number().int().min(1).max(1_000_000).default(1), pageSize: z.number().int().min(1).max(100).default(25) }).strict();
const searchInput = pageInput.extend({ query: text(120).default("") });
const queueInput = searchInput.extend({ status: z.enum(["all", ...ASSIGNMENT_STATUSES]).default("all") });
const assignInput = z.object({ expectedVersion: version, assignments: z.array(z.object({ department: z.enum(DEPARTMENTS), userId: identifier }).strict()).min(1).max(5)
  .refine((v) => new Set(v.map((a) => a.department)).size === v.length) }).strict();
const unassignInput = z.object({ expectedVersion: version, department: z.enum(DEPARTMENTS) }).strict();
const accountInput = z.object({ expectedVersion: version, userId: identifier }).strict();
const statusInput = z.object({ expectedVersion: version, status: z.enum(["Process", "Completed"]) }).strict();
const logInput = z.object({ expectedVersion: version, authority: text(100).optional(), scope: text(100).optional(), status: text(100),
  comments: text(4_000).optional(), notes: text(4_000) }).strict();
const logFileInput = z.object({ name: z.string().min(1).max(120), mediaType: z.string().min(1).max(120), content: z.custom<Buffer>(Buffer.isBuffer) }).strict();
const won = "t.status IN ('Close to Won','Closed Won')";
const latest = "a.id=(SELECT MAX(x.id) FROM departments_assign x WHERE x.task_id=a.task_id AND x.department=a.department)";
const assignmentProjection = `CAST(a.id AS TEXT) AS id,CAST(a.task_id AS TEXT) AS taskId,a.department,
  CAST(a.user_id AS TEXT) AS userId,u.username AS userName,a.status,CAST(a.assigned_by AS TEXT) AS actorId,
  a.assigned_date AS assignedAt,a.version`;
const jobProjection = `CAST(t.id AS TEXT) AS id,t.deal_name AS dealName,t.account_name AS accountName,t.job_deal_number AS jobNumber,
  t.status AS salesStatus,t.Job_Status AS jobStatus,t.Admin_Remarks AS remarks,t.version,t.updated_at AS updatedAt,
  t.complaint_info AS complaintDescription,t.created_at AS createdAt,t.qual_deal_number AS qualificationNumber,
  t.quote_deal_number AS quotationNumber,t.enq_deal_date AS enquiryDate,t.quote_deal_date AS quotationDate,
  t.customer_email AS customerEmail,t.customer_contact AS customerContact`;
type Job = Omit<DepartmentJob, "assignment">;
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new DepartmentsError(400);
  return result.data;
}
function search(value: string) { return `%${value.replace(/[\\%_]/g, "\\$&")}%`; }

export function createDepartmentsService(db: Database, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const auth = createAuthService(db, { now });
  function current(token: Token) {
    const actor = auth.authenticate(token);
    if (!actor) throw new DepartmentsError(401);
    return actor;
  }
  function manager(token: Token) {
    const actor = current(token);
    if (!actor.permissions.includes("dashboard.view")) throw new DepartmentsError(403);
    return actor;
  }
  function worker(token: Token, department: unknown): { actor: AuthUser; department: Department } {
    const actor = current(token);
    if (typeof department !== "string" || !Object.hasOwn(DEPARTMENT_PERMISSIONS, department)) throw new DepartmentsError(404);
    const value = department as Department;
    if (!actor.permissions.includes(DEPARTMENT_PERMISSIONS[value])) throw new DepartmentsError(403);
    return { actor, department: value };
  }
  function safe<T>(operation: () => T, write = false): T {
    try {
      const transaction = db.transaction(operation);
      return write ? transaction.immediate() : transaction();
    } catch (error) {
      if (error instanceof DepartmentsError || error instanceof AttachmentError) throw error;
      throw new DepartmentsError(503);
    }
  }
  function job(id: unknown): Job {
    if (!identifier.safeParse(id).success) throw new DepartmentsError(404);
    const row = db.prepare(`SELECT ${jobProjection} FROM tasks t WHERE t.id=? AND ${won}`).get(id) as Job | undefined;
    if (!row) throw new DepartmentsError(404);
    return row;
  }
  function assignment(taskId: string, department: Department) {
    return db.prepare(`SELECT ${assignmentProjection} FROM departments_assign a LEFT JOIN users u ON u.id=a.user_id
      WHERE a.task_id=? AND a.department=? AND ${latest}`).get(taskId, department) as Assignment | undefined;
  }
  function assignedJob(actor: AuthUser, department: Department, id: unknown): DepartmentJob {
    const row = job(id), active = assignment(row.id, department);
    if (!active || active.userId !== actor.localUserId || active.status === "Unassigned") throw new DepartmentsError(404);
    return { ...row, assignment: active };
  }
  // Approved read-only task scope; write/detail/queue/export guards stay separate.
  function canReadAssignedJobHistory(actor: AuthUser, row: Job): boolean {
    const active = db.prepare(`SELECT a.department FROM departments_assign a
      WHERE a.task_id=? AND a.user_id=? AND a.status<>'Unassigned' AND ${latest}`).all(row.id, actor.localUserId) as { department: Department }[];
    return active.some(value => DEPARTMENTS.includes(value.department) && actor.permissions.includes(DEPARTMENT_PERMISSIONS[value.department]));
  }
  function checkVersion(row: Job, expected: number) {
    if (!Number.isSafeInteger(row.version) || row.version >= Number.MAX_SAFE_INTEGER || row.version !== expected) throw new DepartmentsError(409);
  }
  function touch(row: Job, expected: number, at: string) {
    checkVersion(row, expected);
    const result = db.prepare("UPDATE tasks SET version=version+1,updated_at=? WHERE id=? AND version=?").run(at, row.id, expected);
    if (result.changes !== 1) throw new DepartmentsError(409);
  }
  function audit(actor: AuthUser, row: Job, department: string, action: string, targetId: string, fields: string[], at: string) {
    db.prepare("INSERT INTO crm_department_audit_events(actor_user_id,task_id,department,action,target_id,changed_fields,occurred_at) VALUES(?,?,?,?,?,?,?)")
      .run(actor.localUserId, row.id, department, action, targetId, JSON.stringify(fields), at);
  }
  function assignmentState(row: Job): JobAssignments {
    const assignments = db.prepare(`SELECT ${assignmentProjection} FROM departments_assign a LEFT JOIN users u ON u.id=a.user_id
      WHERE a.task_id=? AND ${latest} ORDER BY a.department`).all(row.id) as Assignment[];
    const accounts = db.prepare(`SELECT CAST(a.id AS TEXT) AS id,CAST(a.user_id AS TEXT) AS userId,u.username AS userName,
      a.payment_status AS status,a.assigned_time AS assignedAt FROM accounts a LEFT JOIN users u ON u.id=a.user_id
      WHERE a.task_id=? ORDER BY a.id DESC LIMIT 1`).get(row.id) as AccountAssignment | undefined;
    return { taskId: row.id, version: row.version, assignments, accounts: accounts ?? null };
  }
  function getAssignments(token: Token, id: unknown) { return safe(() => { manager(token); return assignmentState(job(id)); }); }
  function listAssignees(token: Token, department: unknown, input: unknown = {}): Page<{ id: string; name: string }> {
    return safe(() => {
      manager(token);
      const selected = parse(z.enum([...DEPARTMENTS, "Accounts"]), department), value = parse(searchInput, input);
      const filters = ["status='active'"], args: (string | number)[] = [];
      if (selected !== "Accounts") { filters.push("department_role=?"); args.push(selected); }
      if (value.query) { filters.push("username LIKE ? ESCAPE '\\'"); args.push(search(value.query)); }
      const where = filters.join(" AND ");
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${where}`).get(...args) as { n: number }).n;
      const items = db.prepare(`SELECT CAST(id AS TEXT) AS id,username AS name FROM users WHERE ${where} ORDER BY username,id LIMIT ? OFFSET ?`)
        .all(...args, value.pageSize, (value.page - 1) * value.pageSize) as { id: string; name: string }[];
      return { items, total, page: value.page, pageSize: value.pageSize };
    });
  }
  function assignee(id: string, department: Department | "Accounts") {
    const row = db.prepare("SELECT status,department_role FROM users WHERE id=?").get(id) as { status: string; department_role: string | null } | undefined;
    if (!row || row.status !== "active" || (department !== "Accounts" && row.department_role !== department)) throw new DepartmentsError(400);
  }
  function append(actor: AuthUser, row: Job, department: Department, userId: string | null, at: string) {
    const inserted = db.prepare(`INSERT INTO departments_assign(task_id,user_id,department,status,assigned_by,assigned_by_external,assigned_date,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) RETURNING CAST(id AS TEXT) AS id`).get(row.id, userId, department, userId === null ? "Unassigned" : "Assigned",
      actor.localUserId, actor.externalUserId, at, at, at) as { id: string };
    audit(actor, row, department, userId === null ? "departments.unassign" : "departments.assign", inserted.id, ["user_id", "status", "assigned_by", "assigned_date"], at);
  }
  function assign(token: Token, id: unknown, input: unknown): JobAssignments {
    return safe(() => {
      const actor = manager(token), row = job(id), value = parse(assignInput, input);
      checkVersion(row, value.expectedVersion);
      if (row.jobStatus === "Closed") throw new DepartmentsError(409);
      for (const item of value.assignments) assignee(item.userId, item.department);
      const at = new Date(now()).toISOString();
      for (const item of value.assignments) append(actor, row, item.department, item.userId, at);
      touch(row, value.expectedVersion, at);
      return assignmentState(job(row.id));
    }, true);
  }
  function unassign(token: Token, id: unknown, input: unknown): JobAssignments {
    return safe(() => {
      const actor = manager(token), row = job(id), value = parse(unassignInput, input);
      checkVersion(row, value.expectedVersion);
      const active = assignment(row.id, value.department);
      if (row.jobStatus === "Closed" || !active?.userId || active.status === "Completed") throw new DepartmentsError(409);
      const at = new Date(now()).toISOString();
      append(actor, row, value.department, null, at); touch(row, value.expectedVersion, at);
      return assignmentState(job(row.id));
    }, true);
  }
  function assignAccounts(token: Token, id: unknown, input: unknown): JobAssignments {
    return safe(() => {
      const actor = manager(token), row = job(id), value = parse(accountInput, input);
      checkVersion(row, value.expectedVersion);
      if (row.jobStatus === "Closed") throw new DepartmentsError(409);
      assignee(value.userId, "Accounts");
      const at = new Date(now()).toISOString();
      const inserted = db.prepare(`INSERT INTO accounts(task_id,user_id,assigned_by_id,assigned_time,payment_status,actor_user_id,created_at)
        VALUES(?,?,?,?,'Assigned',?,?) RETURNING CAST(id AS TEXT) AS id`).get(row.id, value.userId, actor.externalUserId, at, actor.localUserId, at) as { id: string };
      touch(row, value.expectedVersion, at); audit(actor, row, "Accounts", "accounts.assign", inserted.id, ["user_id", "payment_status", "assigned_by_id", "assigned_time"], at);
      return assignmentState(job(row.id));
    }, true);
  }
  function listQueue(token: Token, department: unknown, input: unknown = {}): Page<DepartmentJob> {
    return safe(() => {
      const access = worker(token, department), value = parse(queueInput, input);
      const filters = [won, latest, "a.department=?", "a.user_id=?", "a.status IN ('Assigned','Process','Completed','Hold')"];
      const args: (string | number)[] = [access.department, access.actor.localUserId];
      // Source Hold queue means whole-job Hold. Retain the won cohort consistently;
      // the PHP hold helper accidentally omitted it. Other status queues are active-only.
      if (value.status === "Hold") filters.push("t.Job_Status='Hold'");
      else if (value.status !== "all") { filters.push("a.status=?", "(t.Job_Status IS NULL OR t.Job_Status='Active')"); args.push(value.status); }
      if (value.query) { filters.push("(t.deal_name || ' ' || COALESCE(t.account_name,'') || ' ' || COALESCE(t.job_deal_number,'')) LIKE ? ESCAPE '\\'"); args.push(search(value.query)); }
      const from = `FROM tasks t JOIN departments_assign a ON a.task_id=t.id WHERE ${filters.join(" AND ")}`;
      const total = (db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...args) as { n: number }).n;
      const rows = db.prepare(`SELECT ${jobProjection} ${from} ORDER BY t.created_at DESC,t.id DESC LIMIT ? OFFSET ?`)
        .all(...args, value.pageSize, (value.page - 1) * value.pageSize) as Job[];
      return { items: rows.map((r) => ({ ...r, assignment: assignment(r.id, access.department)! })), total, page: value.page, pageSize: value.pageSize };
    });
  }
  function getJob(token: Token, department: unknown, id: unknown): DepartmentJob {
    return safe(() => { const access = worker(token, department); return assignedJob(access.actor, access.department, id); });
  }
  function listLogs(token: Token, department: unknown, id: unknown, input: unknown = {}): Page<WorkLog> {
    return safe(() => {
      const actor = current(token);
      if (typeof department !== "string" || !Object.hasOwn(DEPARTMENT_PERMISSIONS, department)) throw new DepartmentsError(404);
      if (!DEPARTMENTS.some(value => actor.permissions.includes(DEPARTMENT_PERMISSIONS[value]))) throw new DepartmentsError(403);
      const row = job(id);
      if (!canReadAssignedJobHistory(actor, row)) throw new DepartmentsError(404);
      const value = parse(pageInput, input);
      return logs(row.id, department as Department, value.page, value.pageSize);
    });
  }
  function logs(taskId: string, department: Department, page: number, pageSize: number): Page<WorkLog> {
    const total = (db.prepare("SELECT COUNT(*) AS n FROM crm_department_work_logs WHERE task_id=? AND department=?").get(taskId, department) as { n: number }).n;
    const rows = db.prepare(`SELECT CAST(l.id AS TEXT) AS id,CAST(l.task_id AS TEXT) AS taskId,l.department,CAST(l.assignment_id AS TEXT) AS assignmentId,
      CAST(l.actor_user_id AS TEXT) AS actorId,u.username AS actorName,l.authority,l.scope,l.status,l.comments,l.notes,l.created_at AS createdAt
      FROM crm_department_work_logs l JOIN users u ON u.id=l.actor_user_id WHERE l.task_id=? AND l.department=? ORDER BY l.id DESC LIMIT ? OFFSET ?`)
      .all(taskId, department, pageSize, (page - 1) * pageSize) as Omit<WorkLog, "attachment">[];
    const attachment = db.prepare("SELECT id,file_name AS name,media_type AS mediaType,file_size AS size FROM crm_department_log_attachments WHERE log_id=?");
    const items = rows.map((row) => ({ ...row, attachment: (attachment.get(row.id) as WorkLog["attachment"] | undefined) ?? null }));
    return { items, total, page, pageSize };
  }
  function listJobLogs(token: Token, id: unknown, department: unknown, input: unknown = {}): Page<WorkLog> {
    return safe(() => { manager(token); const row = job(id), selected = parse(z.enum(DEPARTMENTS), department), value = parse(pageInput, input);
      return logs(row.id, selected, value.page, value.pageSize); });
  }
  function updateStatus(token: Token, department: unknown, id: unknown, input: unknown): DepartmentJob {
    return safe(() => {
      const access = worker(token, department), row = assignedJob(access.actor, access.department, id), value = parse(statusInput, input);
      checkVersion(row, value.expectedVersion);
      if (row.jobStatus === "Hold" || row.jobStatus === "Closed") throw new DepartmentsError(409);
      const at = new Date(now()).toISOString();
      db.prepare("UPDATE departments_assign SET status=?,version=version+1,updated_at=? WHERE id=?").run(value.status, at, row.assignment.id);
      touch(row, value.expectedVersion, at); audit(access.actor, row, access.department, "departments.status", row.assignment.id, ["status"], at);
      return assignedJob(access.actor, access.department, row.id);
    }, true);
  }
  function authorizeLog(token: Token, department: unknown, id: unknown): void {
    safe(() => {
      const access = worker(token, department), row = assignedJob(access.actor, access.department, id);
      if (row.jobStatus === "Hold" || row.jobStatus === "Closed" || row.assignment.status === "Completed") throw new DepartmentsError(409);
    });
  }
  function downloadLogAttachment(token: Token, id: unknown) {
    return safe(() => {
      const actor = current(token);
      if (!z.uuid().safeParse(id).success) throw new DepartmentsError(404);
      const parent = db.prepare(`SELECT CAST(l.task_id AS TEXT) AS taskId,l.department FROM crm_department_log_attachments f
        JOIN crm_department_work_logs l ON l.id=f.log_id WHERE f.id=?`).get(id) as { taskId: string; department: Department } | undefined;
      if (!parent) throw new DepartmentsError(404);
      const row = job(parent.taskId);
      if (!actor.permissions.includes("dashboard.view") && !canReadAssignedJobHistory(actor, row)) throw new DepartmentsError(404);
      const file = db.prepare("SELECT id,file_name AS name,media_type AS mediaType,file_size AS size,content_sha256 AS digest,content FROM crm_department_log_attachments WHERE id=?")
        .get(id) as { id: string; name: string; mediaType: string; size: number; digest: string; content: Buffer };
      if (file.content.length !== file.size || createHash("sha256").update(file.content).digest("hex") !== file.digest) throw new DepartmentsError(503);
      return { id: file.id, name: file.name, mediaType: file.mediaType, size: file.size, content: file.content };
    });
  }
  function addLog(token: Token, department: unknown, id: unknown, input: unknown, attachment?: unknown): DepartmentJob {
    return safe(() => {
      const access = worker(token, department), row = assignedJob(access.actor, access.department, id), value = parse(logInput, input);
      checkVersion(row, value.expectedVersion);
      if (row.jobStatus === "Hold" || row.jobStatus === "Closed" || row.assignment.status === "Completed") throw new DepartmentsError(409);
      const choices = LOG_OPTIONS[access.department];
      if (!(choices.status as readonly string[]).includes(value.status)) throw new DepartmentsError(400);
      if ("authority" in choices) {
        if (!value.authority || !(choices.authority as readonly string[]).includes(value.authority) || value.scope !== undefined) throw new DepartmentsError(400);
      } else if (!value.scope || !(choices.scope as readonly string[]).includes(value.scope) || value.authority !== undefined || value.comments !== undefined) throw new DepartmentsError(400);
      const file = attachment === undefined ? undefined : parse(logFileInput, attachment);
      let mediaType: string | undefined;
      if (file) {
        // Extension scope and byte limit come from the active PHP department controller.
        const extension = file.name.split(".").at(-1)?.toLowerCase();
        if (!logAttachmentExtensions(access.department).includes(extension ?? "")) throw new AttachmentError(415);
        mediaType = validateContent(file.name, file.mediaType, file.content, logAttachmentLimit(access.department));
      }
      const at = new Date(now()).toISOString();
      const inserted = db.prepare(`INSERT INTO crm_department_work_logs(task_id,department,assignment_id,actor_user_id,authority,scope,status,comments,notes,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING CAST(id AS TEXT) AS id`).get(row.id, access.department, row.assignment.id, access.actor.localUserId,
        value.authority ?? null, value.scope ?? null, value.status, value.comments ?? null, value.notes, at) as { id: string };
      if (file) {
        const fileId = randomUUID();
        db.prepare(`INSERT INTO crm_department_log_attachments(id,log_id,uploaded_by,file_name,media_type,file_size,content_sha256,content,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(fileId, inserted.id, access.actor.localUserId, file.name, mediaType!, file.content.length,
          createHash("sha256").update(file.content).digest("hex"), file.content, at);
        db.prepare(`INSERT INTO crm_department_log_attachment_audit_events(actor_user_id,log_id,attachment_id,action,occurred_at)
          VALUES(?,?,?,'log_attachments.create',?)`).run(access.actor.localUserId, inserted.id, fileId, at);
      }
      touch(row, value.expectedVersion, at);
      audit(access.actor, row, access.department, "departments.log", inserted.id, ["authority", "scope", "status", "comments", "notes", ...(file ? ["attachment"] : [])], at);
      return assignedJob(access.actor, access.department, row.id);
    }, true);
  }
  return { getAssignments, listAssignees, assign, unassign, assignAccounts, listQueue, getJob, listLogs, listJobLogs, updateStatus, addLog, authorizeLog, downloadLogAttachment };
}
