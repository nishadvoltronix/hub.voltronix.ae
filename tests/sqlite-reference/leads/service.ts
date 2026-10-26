import type { Database } from "better-sqlite3";
import { z } from "zod";
import { createAuthService, type AuthUser } from "../auth/service";
import { PIPELINE_STAGES, type LeadDetail, type LeadNote, type LeadPage, type LeadStatusEvent,
  type PipelineAgent, type PipelineLead, type PipelineResult, type PipelineStage } from "./contracts";

type Token = string | undefined | null;
export class LeadsError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 503, message?: string) {
    super(message ?? ({ 400: "Invalid lead request.", 401: "Sign in required.", 403: "Access denied.",
      404: "Record not found.", 503: "Leads are temporarily unavailable." })[status]);
    this.name = "LeadsError";
  }
}
const idSchema = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n);
const pageFields = {
  page: z.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
};
const queryField = z.string().trim().max(120).refine((value) => !value.includes("\0")).default("");
const agentField = z.string().min(1).max(100).refine((value) =>
  Array.from(value).every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127));
const pipelineInput = z.object({ ...pageFields, query: queryField,
  stage: z.enum(["all", "qualification", "siteVisit", "proposal", "won", "lost", "other"]).default("all"),
  agentId: agentField.optional(), scope: z.enum(["default", "own"]).default("default"),
}).strict();
const agentInput = z.object({ ...pageFields, query: queryField,
  scope: z.enum(["default", "own"]).default("default"),
}).strict();
const pageInput = z.object(pageFields).strict();
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new LeadsError(400);
  return result.data;
}
function escapedSearch(value: string) { return `%${value.replace(/[\\%_]/g, "\\$&")}%`; }
// Only fixed source-observed literals become SQL. Request values always use bindings.
const stageExpression = `CASE ${PIPELINE_STAGES.map((stage) =>
  `WHEN t.status IN (${stage.statuses.map((value) => `'${value}'`).join(",")}) THEN '${stage.key}'`).join(" ")} ELSE 'other' END`;
const numberExpression = `CASE (${stageExpression})
  WHEN 'qualification' THEN t.qual_deal_number WHEN 'siteVisit' THEN t.site_deal_number
  WHEN 'proposal' THEN t.quote_deal_number WHEN 'won' THEN t.job_deal_number
  WHEN 'lost' THEN t.lost_deal_number ELSE t.deal_number END`;
const listProjection = `CAST(t.id AS TEXT) AS id, t.deal_name AS dealName, t.status,
  (${stageExpression}) AS stage, t.account_name AS accountName,
  t.assigned_to AS assignedExternalId, u.username AS assignedName,
  t.service_charge AS serviceCharge, (${numberExpression}) AS displayNumber,
  t.created_at AS createdAt, t.updated_at AS updatedAt`;
const detailProjection = `${listProjection}, t.zoho_crm_id AS externalId,
  t.customer_name AS customerName, t.customer_email AS customerEmail,
  t.customer_contact AS customerContact, t.address, t.complaint_info AS description,
  t.remark, t.notes, t.assign_notes AS assignmentNotes, t.owner_id AS ownerExternalId,
  CAST(t.deal_crm_created_by AS TEXT) AS createdByLocalId, t.Job_Status AS jobStatus,
  t.deal_number AS dealNumber, t.enq_number AS enquiryNumber, t.qual_deal_number AS qualificationNumber,
  t.site_deal_number AS siteNumber, t.quote_deal_number AS quotationNumber,
  t.job_deal_number AS jobNumber, t.lost_deal_number AS lostNumber, t.quote_number AS quoteId,
  t.enq_deal_date AS enquiryDate, t.qual_deal_date AS qualificationDate,
  t.site_deal_date AS siteDate, t.quote_deal_date AS quotationDate,
  t.job_deal_date AS jobDate, t.lost_deal_date AS lostDate`;
const taskFrom = "FROM tasks t LEFT JOIN users u ON u.user_id=t.assigned_to";

/** Persisted read models only. Notes/stage writes remain coupled to unverified Zoho operations. */
export function createLeadsService(db: Database) {
  const auth = createAuthService(db);
  function read<T>(token: Token, operation: (actor: AuthUser) => T): T {
    try {
      return db.transaction(() => {
        const actor = auth.authenticate(token);
        if (!actor) throw new LeadsError(401);
        return operation(actor);
      })();
    } catch (error) {
      if (error instanceof LeadsError) throw error;
      throw new LeadsError(503);
    }
  }
  function pipelineScope(actor: AuthUser, requested: "default" | "own") {
    if (!actor.permissions.includes("leads.manage.agents") && !actor.permissions.includes("leads.view")) {
      throw new LeadsError(403);
    }
    // An agent grant always selects the source own branch, even alongside leads.view.
    const scope = actor.permissions.includes("leads.manage.agents") || requested === "own" ? "own" : "all";
    return { scope, filter: scope === "own" ? "t.assigned_to = ?" : "1=1",
      values: (scope === "own" ? [actor.externalUserId] : []) as Array<string | null> } as const;
  }
  function listPipeline(token: Token, input: unknown = {}): PipelineResult {
    return read(token, (actor) => {
      pipelineScope(actor, "default");
      const value = parse(pipelineInput, input), scoped = pipelineScope(actor, value.scope);
      const filters: string[] = [scoped.filter], values = [...scoped.values];
      if (value.agentId) {
        filters.push(value.agentId === "unassigned" ? "t.assigned_to IS NULL" : "t.assigned_to = ?");
        if (value.agentId !== "unassigned") values.push(value.agentId);
      }
      if (value.query) {
        filters.push(`(COALESCE(t.account_name,'') || ' ' || t.deal_name || ' ' ||
          COALESCE(u.username,'') || ' ' || t.status || ' ' || COALESCE((${numberExpression}),'')) LIKE ? ESCAPE '\\'`);
        values.push(escapedSearch(value.query));
      }
      const filter = filters.join(" AND ");
      const counts: Record<PipelineStage, number> = { qualification: 0, siteVisit: 0, proposal: 0, won: 0, lost: 0, other: 0 };
      for (const row of db.prepare(`SELECT (${stageExpression}) AS stage, COUNT(*) AS count ${taskFrom}
        WHERE ${filter} GROUP BY stage`).all(...values) as { stage: PipelineStage; count: number }[]) {
        counts[row.stage] = row.count;
      }
      const selected = value.stage === "all" ? "" : ` AND (${stageExpression}) = ?`;
      const selectedValues = value.stage === "all" ? values : [...values, value.stage];
      const total = value.stage === "all" ? Object.values(counts).reduce((sum, count) => sum + count, 0) : counts[value.stage];
      const items = db.prepare(`SELECT ${listProjection} ${taskFrom} WHERE ${filter}${selected}
        ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`)
        .all(...selectedValues, value.pageSize, (value.page - 1) * value.pageSize) as PipelineLead[];
      return { items, total, page: value.page, pageSize: value.pageSize, counts, scope: scoped.scope };
    });
  }
  function listAgents(token: Token, input: unknown = {}): LeadPage<PipelineAgent> {
    return read(token, (actor) => {
      pipelineScope(actor, "default");
      const value = parse(agentInput, input), scoped = pipelineScope(actor, value.scope);
      const filter = `${scoped.filter} AND u.user_id IS NOT NULL AND u.username LIKE ? ESCAPE '\\'`;
      const values = [...scoped.values, escapedSearch(value.query)];
      const total = (db.prepare(`SELECT COUNT(DISTINCT u.user_id) AS n ${taskFrom} WHERE ${filter}`)
        .get(...values) as { n: number }).n;
      const items = db.prepare(`SELECT DISTINCT u.user_id AS externalId, u.username AS name
        ${taskFrom} WHERE ${filter} ORDER BY u.username COLLATE NOCASE, u.user_id LIMIT ? OFFSET ?`)
        .all(...values, value.pageSize, (value.page - 1) * value.pageSize) as PipelineAgent[];
      return { items, total, page: value.page, pageSize: value.pageSize };
    });
  }
  function authorizedLead(actor: AuthUser, id: unknown): LeadDetail {
    const parsed = idSchema.safeParse(id);
    if (!parsed.success || !auth.canAccessTask(actor, parsed.data)) throw new LeadsError(404);
    return db.prepare(`SELECT ${detailProjection} ${taskFrom} WHERE t.id=?`).get(parsed.data) as LeadDetail;
  }
  function getLead(token: Token, id: unknown): LeadDetail {
    return read(token, (actor) => authorizedLead(actor, id));
  }
  function listNotes(token: Token, id: unknown, input: unknown = {}): LeadPage<LeadNote> {
    return read(token, (actor) => {
      const lead = authorizedLead(actor, id), value = parse(pageInput, input);
      const total = (db.prepare("SELECT COUNT(*) AS n FROM job_notes WHERE deal_id=?")
        .get(lead.externalId) as { n: number }).n;
      const items = db.prepare(`SELECT CAST(id AS TEXT) AS id, note_title AS title, note_content AS content,
        zoho_note_id AS externalNoteId, created_at AS createdAt, updated_at AS updatedAt
        FROM job_notes WHERE deal_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`)
        .all(lead.externalId, value.pageSize, (value.page - 1) * value.pageSize) as LeadNote[];
      return { items, total, page: value.page, pageSize: value.pageSize };
    });
  }
  function listStatusHistory(token: Token, id: unknown, input: unknown = {}): LeadPage<LeadStatusEvent> {
    return read(token, (actor) => {
      const lead = authorizedLead(actor, id), value = parse(pageInput, input);
      const total = (db.prepare("SELECT COUNT(*) AS n FROM tasks_status_log WHERE Task_ID=?")
        .get(lead.id) as { n: number }).n;
      const items = db.prepare(`SELECT CAST(s.id AS TEXT) AS id, s.Status AS status,
        CAST(s.User_ID AS TEXT) AS actorId, u.username AS actorName, s.Task_Log_Create_Date AS occurredAt
        FROM tasks_status_log s LEFT JOIN users u ON u.id=s.User_ID
        WHERE s.Task_ID=? ORDER BY s.Task_Log_Create_Date DESC,s.id DESC LIMIT ? OFFSET ?`)
        .all(lead.id, value.pageSize, (value.page - 1) * value.pageSize) as LeadStatusEvent[];
      return { items, total, page: value.page, pageSize: value.pageSize };
    });
  }
  return { listPipeline, listAgents, getLead, listNotes, listStatusHistory };
}
