import { logAttachmentLimit, logAttachmentExtensions } from "@voltronix/crm-contracts";
import { MysqlDatabaseError, type MysqlDatabase as Database } from "../db/mysql/database";
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
const assignmentProjection = `CAST(a.id AS CHAR) AS id,CAST(a.task_id AS CHAR) AS taskId,a.department,
  CAST(a.user_id AS CHAR) AS userId,u.username AS userName,a.status,CAST(a.assigned_by AS CHAR) AS actorId,
  a.assigned_date AS assignedAt,a.version`;
const jobProjection = `CAST(t.id AS CHAR) AS id,t.deal_name AS dealName,t.account_name AS accountName,t.job_deal_number AS jobNumber,
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
function search(value: string) { return `%${value.replace(/[!%_]/g, "!$&")}%`; }

export function createDepartmentsService(db: Database, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const auth = createAuthService(db, { now });
  async function current(token: Token) {
    const actor = (await auth.authenticate(token));
    if (!actor) throw new DepartmentsError(401);
    return actor;
  }
  async function manager(token: Token) {
    const actor = (await current(token));
    if (!actor.permissions.includes("dashboard.view")) throw new DepartmentsError(403);
    return actor;
  }
  async function worker(token: Token, department: unknown): Promise<{ actor: AuthUser; department: Department }> {
    const actor = (await current(token));
    if (typeof department !== "string" || !Object.hasOwn(DEPARTMENT_PERMISSIONS, department)) throw new DepartmentsError(404);
    const value = department as Department;
    if (!actor.permissions.includes(DEPARTMENT_PERMISSIONS[value])) throw new DepartmentsError(403);
    return { actor, department: value };
  }
  async function safe<T>(operation: () => Promise<T>, write = false): Promise<T> {
    try {
      const transaction = db.transaction(operation);
      return write ? (await transaction.immediate()) : (await transaction());
    } catch (error) {
      if (error instanceof MysqlDatabaseError && error.code === "MYSQL_CONFLICT") throw new DepartmentsError(409);
      if (error instanceof DepartmentsError || error instanceof AttachmentError) throw error;
      throw new DepartmentsError(503);
    }
  }
  async function job(id: unknown): Promise<Job> {
    if (!identifier.safeParse(id).success) throw new DepartmentsError(404);
    const row = (await db.prepare(`SELECT ${jobProjection} FROM tasks t WHERE t.id=? AND ${won}`).get(id)) as Job | undefined;
    if (!row) throw new DepartmentsError(404);
    return row;
  }
  async function assignment(taskId: string, department: Department) {
    return (await db.prepare(`SELECT ${assignmentProjection} FROM departments_assign a LEFT JOIN users u ON u.id=a.user_id
      WHERE a.task_id=? AND a.department=? AND ${latest}`).get(taskId, department)) as Assignment | undefined;
  }
  async function assignedJob(actor: AuthUser, department: Department, id: unknown): Promise<DepartmentJob> {
    const row = (await job(id)), active = (await assignment(row.id, department));
    if (!active || active.userId !== actor.localUserId || active.status === "Unassigned") throw new DepartmentsError(404);
    return { ...row, assignment: active };
  }
  // Account Owner approved read-only cross-department history on a task where
  // the reader has a current latest assignment paired with its current grant.
  // Writes, detail routes, queues and exports continue to use worker/assignedJob.
  async function canReadAssignedJobHistory(actor: AuthUser, row: Job): Promise<boolean> {
    const active = (await db.prepare(`SELECT a.department FROM departments_assign a
      WHERE a.task_id=? AND a.user_id=? AND a.status<>'Unassigned' AND ${latest}`).all(row.id, actor.localUserId)) as { department: Department }[];
    return active.some(value => DEPARTMENTS.includes(value.department) && actor.permissions.includes(DEPARTMENT_PERMISSIONS[value.department]));
  }
  function checkVersion(row: Job, expected: number) {
    if (!Number.isSafeInteger(row.version) || row.version >= Number.MAX_SAFE_INTEGER || row.version !== expected) throw new DepartmentsError(409);
  }
  async function touch(row: Job, expected: number, at: string) {
    checkVersion(row, expected);
    const result = (await db.prepare("UPDATE tasks SET version=version+1,updated_at=? WHERE id=? AND version=?").run(at, row.id, expected));
    if (result.changes !== 1) throw new DepartmentsError(409);
  }
  async function audit(actor: AuthUser, row: Job, department: string, action: string, targetId: string, fields: string[], at: string) {
    (await db.prepare("INSERT INTO crm_department_audit_events(actor_user_id,task_id,department,action,target_id,changed_fields,occurred_at) VALUES(?,?,?,?,?,?,?)")
      .run(actor.localUserId, row.id, department, action, targetId, JSON.stringify(fields), at));
  }
  async function assignmentState(row: Job): Promise<JobAssignments> {
    const assignments = (await db.prepare(`SELECT ${assignmentProjection} FROM departments_assign a LEFT JOIN users u ON u.id=a.user_id
      WHERE a.task_id=? AND ${latest} ORDER BY a.department`).all(row.id)) as Assignment[];
    const accounts = (await db.prepare(`SELECT CAST(a.id AS CHAR) AS id,CAST(a.user_id AS CHAR) AS userId,u.username AS userName,
      a.payment_status AS status,a.assigned_time AS assignedAt FROM accounts a LEFT JOIN users u ON u.id=a.user_id
      WHERE a.task_id=? ORDER BY a.id DESC LIMIT 1`).get(row.id)) as AccountAssignment | undefined;
    return { taskId: row.id, version: row.version, assignments, accounts: accounts ?? null };
  }
  async function getAssignments(token: Token, id: unknown) { return (await safe(async () => { (await manager(token)); return (await assignmentState((await job(id)))); })); }
  async function listAssignees(token: Token, department: unknown, input: unknown = {}): Promise<Page<{ id: string; name: string }>> {
    return (await safe(async () => {
      (await manager(token));
      const selected = parse(z.enum([...DEPARTMENTS, "Accounts"]), department), value = parse(searchInput, input);
      const filters = ["status='active'"], args: (string | number)[] = [];
      if (selected !== "Accounts") { filters.push("department_role=?"); args.push(selected); }
      if (value.query) { filters.push("username COLLATE utf8mb4_0900_as_ci LIKE ? ESCAPE '!'"); args.push(search(value.query)); }
      const where = filters.join(" AND ");
      const total = ((await db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${where}`).get(...args)) as { n: number }).n;
      if (!Number.isSafeInteger(total) || total < 0) throw new DepartmentsError(503);
      const items = (await db.prepare(`SELECT CAST(id AS CHAR) AS id,username AS name FROM users WHERE ${where} ORDER BY username,id LIMIT ? OFFSET ?`)
        .all(...args, value.pageSize, (value.page - 1) * value.pageSize)) as { id: string; name: string }[];
      return { items, total, page: value.page, pageSize: value.pageSize };
    }));
  }
  async function assignee(id: string, department: Department | "Accounts") {
    const row = (await db.prepare("SELECT status,department_role FROM users WHERE id=?").get(id)) as { status: string; department_role: string | null } | undefined;
    if (!row || row.status !== "active" || (department !== "Accounts" && row.department_role !== department)) throw new DepartmentsError(400);
  }
  async function append(actor: AuthUser, row: Job, department: Department, userId: string | null, at: string) {
    const inserted = (await db.prepare(`INSERT INTO departments_assign(task_id,user_id,department,status,assigned_by,assigned_by_external,assigned_date,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(row.id, userId, department, userId === null ? "Unassigned" : "Assigned",
      actor.localUserId, actor.externalUserId, at, at, at));
    (await audit(actor, row, department, userId === null ? "departments.unassign" : "departments.assign", String(inserted.lastInsertRowid), ["user_id", "status", "assigned_by", "assigned_date"], at));
  }
  async function assign(token: Token, id: unknown, input: unknown): Promise<JobAssignments> {
    return (await safe(async () => {
      const actor = (await manager(token)), row = (await job(id)), value = parse(assignInput, input);
      checkVersion(row, value.expectedVersion);
      if (row.jobStatus === "Closed") throw new DepartmentsError(409);
      for (const item of value.assignments) (await assignee(item.userId, item.department));
      const at = new Date(now()).toISOString();
      for (const item of value.assignments) (await append(actor, row, item.department, item.userId, at));
      (await touch(row, value.expectedVersion, at));
      return (await assignmentState((await job(row.id))));
    }, true));
  }
  async function unassign(token: Token, id: unknown, input: unknown): Promise<JobAssignments> {
    return (await safe(async () => {
      const actor = (await manager(token)), row = (await job(id)), value = parse(unassignInput, input);
      checkVersion(row, value.expectedVersion);
      const active = (await assignment(row.id, value.department));
      if (row.jobStatus === "Closed" || !active?.userId || active.status === "Completed") throw new DepartmentsError(409);
      const at = new Date(now()).toISOString();
      (await append(actor, row, value.department, null, at)); (await touch(row, value.expectedVersion, at));
      return (await assignmentState((await job(row.id))));
    }, true));
  }
  async function assignAccounts(token: Token, id: unknown, input: unknown): Promise<JobAssignments> {
    return (await safe(async () => {
      const actor = (await manager(token)), row = (await job(id)), value = parse(accountInput, input);
      checkVersion(row, value.expectedVersion);
      if (row.jobStatus === "Closed") throw new DepartmentsError(409);
      (await assignee(value.userId, "Accounts"));
      const at = new Date(now()).toISOString();
      const inserted = (await db.prepare(`INSERT INTO accounts(task_id,user_id,assigned_by_id,assigned_time,payment_status,actor_user_id,created_at)
        VALUES(?,?,?,?,'Assigned',?,?)`).run(row.id, value.userId, actor.externalUserId, at, actor.localUserId, at));
      (await touch(row, value.expectedVersion, at)); (await audit(actor, row, "Accounts", "accounts.assign", String(inserted.lastInsertRowid), ["user_id", "payment_status", "assigned_by_id", "assigned_time"], at));
      return (await assignmentState((await job(row.id))));
    }, true));
  }
  async function listQueue(token: Token, department: unknown, input: unknown = {}): Promise<Page<DepartmentJob>> {
    return (await safe(async () => {
      const access = (await worker(token, department)), value = parse(queueInput, input);
      const filters = [won, latest, "a.department=?", "a.user_id=?", "a.status IN ('Assigned','Process','Completed','Hold')"];
      const args: (string | number)[] = [access.department, access.actor.localUserId];
      // Source Hold queue means whole-job Hold. Retain the won cohort consistently;
      // the PHP hold helper accidentally omitted it. Other status queues are active-only.
      if (value.status === "Hold") filters.push("t.Job_Status='Hold'");
      else if (value.status !== "all") { filters.push("a.status=?", "(t.Job_Status IS NULL OR t.Job_Status='Active')"); args.push(value.status); }
      if (value.query) { filters.push("CONCAT(t.deal_name,' ',COALESCE(t.account_name,''),' ',COALESCE(t.job_deal_number,'')) COLLATE utf8mb4_0900_as_ci LIKE ? ESCAPE '!'"); args.push(search(value.query)); }
      const from = `FROM tasks t JOIN departments_assign a ON a.task_id=t.id WHERE ${filters.join(" AND ")}`;
      const total = ((await db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...args)) as { n: number }).n;
      if (!Number.isSafeInteger(total) || total < 0) throw new DepartmentsError(503);
      const rows = (await db.prepare(`SELECT ${jobProjection} ${from} ORDER BY t.created_at DESC,t.id DESC LIMIT ? OFFSET ?`)
        .all(...args, value.pageSize, (value.page - 1) * value.pageSize)) as Job[];
      const items: DepartmentJob[] = [];
      for (const row of rows) items.push({ ...row, assignment: (await assignment(row.id, access.department))! });
      return { items, total, page: value.page, pageSize: value.pageSize };
    }));
  }
  async function getJob(token: Token, department: unknown, id: unknown): Promise<DepartmentJob> {
    return (await safe(async () => { const access = (await worker(token, department)); return (await assignedJob(access.actor, access.department, id)); }));
  }
  async function listLogs(token: Token, department: unknown, id: unknown, input: unknown = {}): Promise<Page<WorkLog>> {
    return (await safe(async () => {
      const actor = (await current(token));
      if (typeof department !== "string" || !Object.hasOwn(DEPARTMENT_PERMISSIONS, department)) throw new DepartmentsError(404);
      if (!DEPARTMENTS.some(value => actor.permissions.includes(DEPARTMENT_PERMISSIONS[value]))) throw new DepartmentsError(403);
      const row = (await job(id));
      if (!(await canReadAssignedJobHistory(actor, row))) throw new DepartmentsError(404);
      const value = parse(pageInput, input);
      return (await logs(row.id, department as Department, value.page, value.pageSize));
    }));
  }
  async function logs(taskId: string, department: Department, page: number, pageSize: number): Promise<Page<WorkLog>> {
    const total = ((await db.prepare("SELECT COUNT(*) AS n FROM crm_department_work_logs WHERE task_id=? AND department=?").get(taskId, department)) as { n: number }).n;
      if (!Number.isSafeInteger(total) || total < 0) throw new DepartmentsError(503);
    const rows = (await db.prepare(`SELECT CAST(l.id AS CHAR) AS id,CAST(l.task_id AS CHAR) AS taskId,l.department,CAST(l.assignment_id AS CHAR) AS assignmentId,
      CAST(l.actor_user_id AS CHAR) AS actorId,u.username AS actorName,l.authority,l.scope,l.status,l.comments,l.notes,l.created_at AS createdAt
      FROM crm_department_work_logs l JOIN users u ON u.id=l.actor_user_id WHERE l.task_id=? AND l.department=? ORDER BY l.id DESC LIMIT ? OFFSET ?`)
      .all(taskId, department, pageSize, (page - 1) * pageSize)) as Omit<WorkLog, "attachment">[];
    const attachment = db.prepare("SELECT id,file_name AS name,media_type AS mediaType,file_size AS size FROM crm_department_log_attachments WHERE log_id=?");
    const items: WorkLog[] = [];
    for (const row of rows) items.push({ ...row, attachment: ((await attachment.get(row.id)) as WorkLog["attachment"] | undefined) ?? null });
    return { items, total, page, pageSize };
  }
  async function listJobLogs(token: Token, id: unknown, department: unknown, input: unknown = {}): Promise<Page<WorkLog>> {
    return (await safe(async () => { (await manager(token)); const row = (await job(id)), selected = parse(z.enum(DEPARTMENTS), department), value = parse(pageInput, input);
      return (await logs(row.id, selected, value.page, value.pageSize)); }));
  }
  async function updateStatus(token: Token, department: unknown, id: unknown, input: unknown): Promise<DepartmentJob> {
    return (await safe(async () => {
      const access = (await worker(token, department)), row = (await assignedJob(access.actor, access.department, id)), value = parse(statusInput, input);
      checkVersion(row, value.expectedVersion);
      if (row.jobStatus === "Hold" || row.jobStatus === "Closed") throw new DepartmentsError(409);
      const at = new Date(now()).toISOString();
      (await db.prepare("UPDATE departments_assign SET status=?,version=version+1,updated_at=? WHERE id=?").run(value.status, at, row.assignment.id));
      (await touch(row, value.expectedVersion, at)); (await audit(access.actor, row, access.department, "departments.status", row.assignment.id, ["status"], at));
      return (await assignedJob(access.actor, access.department, row.id));
    }, true));
  }
  async function authorizeLog(token: Token, department: unknown, id: unknown): Promise<void> {
    (await safe(async () => {
      const access = (await worker(token, department)), row = (await assignedJob(access.actor, access.department, id));
      if (row.jobStatus === "Hold" || row.jobStatus === "Closed" || row.assignment.status === "Completed") throw new DepartmentsError(409);
    }));
  }
  async function downloadLogAttachment(token: Token, id: unknown) {
    return (await safe(async () => {
      const actor = (await current(token));
      if (!z.uuid().safeParse(id).success) throw new DepartmentsError(404);
      const parent = (await db.prepare(`SELECT CAST(l.task_id AS CHAR) AS taskId,l.department FROM crm_department_log_attachments f
        JOIN crm_department_work_logs l ON l.id=f.log_id WHERE f.id=?`).get(id)) as { taskId: string; department: Department } | undefined;
      if (!parent) throw new DepartmentsError(404);
      const row = (await job(parent.taskId));
      if (!actor.permissions.includes("dashboard.view") && !(await canReadAssignedJobHistory(actor, row))) throw new DepartmentsError(404);
      const file = (await db.prepare("SELECT id,file_name AS name,media_type AS mediaType,file_size AS size,content_sha256 AS digest,content FROM crm_department_log_attachments WHERE id=?")
        .get(id)) as { id: string; name: string; mediaType: string; size: number; digest: string; content: Buffer };
      if (file.content.length !== file.size || createHash("sha256").update(file.content).digest("hex") !== file.digest) throw new DepartmentsError(503);
      return { id: file.id, name: file.name, mediaType: file.mediaType, size: file.size, content: file.content };
    }));
  }
  async function addLog(token: Token, department: unknown, id: unknown, input: unknown, attachment?: unknown): Promise<DepartmentJob> {
    return (await safe(async () => {
      const access = (await worker(token, department)), row = (await assignedJob(access.actor, access.department, id)), value = parse(logInput, input);
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
      const inserted = (await db.prepare(`INSERT INTO crm_department_work_logs(task_id,department,assignment_id,actor_user_id,authority,scope,status,comments,notes,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(row.id, access.department, row.assignment.id, access.actor.localUserId,
        value.authority ?? null, value.scope ?? null, value.status, value.comments ?? null, value.notes, at));
      const logId = String(inserted.lastInsertRowid);
      if (file) {
        const fileId = randomUUID();
        (await db.prepare(`INSERT INTO crm_department_log_attachments(id,log_id,uploaded_by,file_name,media_type,file_size,content_sha256,content,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(fileId, logId, access.actor.localUserId, file.name, mediaType!, file.content.length,
          createHash("sha256").update(file.content).digest("hex"), file.content, at));
        (await db.prepare(`INSERT INTO crm_department_log_attachment_audit_events(actor_user_id,log_id,attachment_id,action,occurred_at)
          VALUES(?,?,?,'log_attachments.create',?)`).run(access.actor.localUserId, logId, fileId, at));
      }
      (await touch(row, value.expectedVersion, at));
      (await audit(access.actor, row, access.department, "departments.log", logId, ["authority", "scope", "status", "comments", "notes", ...(file ? ["attachment"] : [])], at));
      return (await assignedJob(access.actor, access.department, row.id));
    }, true));
  }
  return { getAssignments, listAssignees, assign, unassign, assignAccounts, listQueue, getJob, listLogs, listJobLogs, updateStatus, addLog, authorizeLog, downloadLogAttachment };
}
