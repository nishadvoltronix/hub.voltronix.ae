import type { Database } from "better-sqlite3";
import { z } from "zod";
import { createAuthService, type AuthUser } from "../auth/service";
import { JOB_STATUSES, type JobPage, type JobRecord } from "./contracts";

type Token = string | null | undefined;
export class JobsError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409 | 503) {
    super(({ 400: "Invalid job input.", 401: "Sign in required.", 403: "Access denied.",
      404: "Job not found.", 409: "The job changed. Reload it and try again.",
      503: "Jobs are temporarily unavailable." })[status]);
    this.name = "JobsError";
  }
}
const idSchema = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n);
const versionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const listInput = z.object({
  query: z.string().trim().max(120).refine((value) => !value.includes("\0")).default(""),
  page: z.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
  jobStatus: z.enum(["all", ...JOB_STATUSES]).default("all"),
}).strict();
const statusInput = z.object({ expectedVersion: versionSchema, jobStatus: z.enum(JOB_STATUSES) }).strict();
const remarksInput = z.object({ expectedVersion: versionSchema,
  remarks: z.string().trim().max(4_000).refine((value) => !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 7_000),
}).strict();
const cohort = "status IN ('Close to Won','Closed Won')";
const projection = `CAST(id AS TEXT) AS id,deal_name AS dealName,account_name AS accountName,
  job_deal_number AS jobNumber,status AS salesStatus,Job_Status AS jobStatus,Admin_Remarks AS remarks,
  hold_by AS holdByExternalId,version,updated_at AS updatedAt,
  complaint_info AS complaintDescription,created_at AS createdAt,qual_deal_number AS qualificationNumber,
  quote_deal_number AS quotationNumber,enq_deal_date AS enquiryDate,quote_deal_date AS quotationDate,
  customer_email AS customerEmail,customer_contact AS customerContact`;
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new JobsError(400);
  return parsed.data;
}
function escapedSearch(value: string) { return `%${value.replace(/[\\%_]/g, "\\$&")}%`; }

/** Only the verified local job status/administrator-remarks workflows are writable. */
export function createJobsService(db: Database, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const auth = createAuthService(db, { now });
  function authorize(token: Token): AuthUser {
    const actor = auth.authenticate(token);
    if (!actor) throw new JobsError(401);
    // layout/layout.php:208 gates the central jobs section. PHP controller omitted this guard.
    if (!actor.permissions.includes("dashboard.view")) throw new JobsError(403);
    return actor;
  }
  function safe<T>(operation: () => T): T {
    try { return operation(); } catch (error) {
      if (error instanceof JobsError) throw error;
      throw new JobsError(503);
    }
  }
  function read<T>(token: Token, operation: (actor: AuthUser) => T): T {
    return safe(() => db.transaction(() => operation(authorize(token)))());
  }
  function write<T>(token: Token, operation: (actor: AuthUser) => T): T {
    return safe(() => db.transaction(() => operation(authorize(token))).immediate());
  }
  function job(id: unknown): JobRecord {
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) throw new JobsError(404);
    const result = db.prepare(`SELECT ${projection} FROM tasks WHERE id=? AND ${cohort}`).get(parsed.data) as JobRecord | undefined;
    if (!result) throw new JobsError(404);
    return result;
  }
  function audit(actor: AuthUser, taskId: string, action: "jobs.status" | "jobs.remarks", fields: string[], at: string) {
    db.prepare("INSERT INTO crm_job_audit_events(actor_user_id,task_id,action,changed_fields,occurred_at) VALUES(?,?,?,?,?)")
      .run(actor.localUserId, taskId, action, JSON.stringify(fields), at);
  }
  function listJobs(token: Token, input: unknown = {}): JobPage {
    return read(token, () => {
      const value = parse(listInput, input);
      const filters = [cohort], parameters: (string | number)[] = [];
      if (value.jobStatus === "Active") filters.push("(Job_Status IS NULL OR Job_Status='' OR Job_Status='Active')");
      else if (value.jobStatus !== "all") { filters.push("Job_Status=?"); parameters.push(value.jobStatus); }
      if (value.query) {
        filters.push("(deal_name || ' ' || COALESCE(account_name,'') || ' ' || COALESCE(job_deal_number,'')) LIKE ? ESCAPE '\\'");
        parameters.push(escapedSearch(value.query));
      }
      const filter = filters.join(" AND ");
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${filter}`).get(...parameters) as { n: number }).n;
      const items = db.prepare(`SELECT ${projection} FROM tasks WHERE ${filter} ORDER BY job_deal_number DESC,id DESC LIMIT ? OFFSET ?`)
        .all(...parameters, value.pageSize, (value.page - 1) * value.pageSize) as JobRecord[];
      return { items, total, page: value.page, pageSize: value.pageSize };
    });
  }
  function getJob(token: Token, id: unknown): JobRecord { return read(token, () => job(id)); }
  function updateStatus(token: Token, id: unknown, input: unknown): JobRecord {
    return write(token, (actor) => {
      const previous = job(id), value = parse(statusInput, input);
      if (!Number.isSafeInteger(previous.version) || previous.version >= Number.MAX_SAFE_INTEGER || previous.version !== value.expectedVersion) throw new JobsError(409);
      const at = new Date(now()).toISOString();
      // Source writes hold_by on all three status choices, not only on Hold.
      const changed = db.prepare(`UPDATE tasks SET Job_Status=?,hold_by=?,version=version+1,updated_at=?
        WHERE id=? AND version=? AND ${cohort}`).run(value.jobStatus, actor.externalUserId, at, previous.id, value.expectedVersion);
      if (changed.changes !== 1) throw new JobsError(409);
      audit(actor, previous.id, "jobs.status", ["Job_Status", "hold_by"], at);
      return job(previous.id);
    });
  }
  function updateRemarks(token: Token, id: unknown, input: unknown): JobRecord {
    return write(token, (actor) => {
      const previous = job(id), value = parse(remarksInput, input);
      if (!Number.isSafeInteger(previous.version) || previous.version >= Number.MAX_SAFE_INTEGER || previous.version !== value.expectedVersion) throw new JobsError(409);
      const at = new Date(now()).toISOString();
      const changed = db.prepare(`UPDATE tasks SET Admin_Remarks=?,version=version+1,updated_at=?
        WHERE id=? AND version=? AND ${cohort}`).run(value.remarks, at, previous.id, value.expectedVersion);
      if (changed.changes !== 1) throw new JobsError(409);
      audit(actor, previous.id, "jobs.remarks", ["Admin_Remarks"], at);
      return job(previous.id);
    });
  }
  return { listJobs, getJob, updateStatus, updateRemarks };
}
