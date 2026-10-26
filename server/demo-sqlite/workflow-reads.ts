import { z } from "zod";
import { QUOTATION_SORTS, quotationListOrder } from "../src/crm/commercial/list-order.js";
import { PIPELINE_STAGES, type LeadDetail, type LeadNote, type LeadStatusEvent, type PipelineLead, type PipelineResult, type PipelineStage } from "@voltronix/crm-contracts";
import type { SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import type { createLeadsService } from "../../tests/sqlite-reference/leads/service.js";
import type { createCommercialService } from "../../tests/sqlite-reference/commercial/service.js";
import type { CommercialPage, QuotationCandidate, QuotationDetail, QuotationSummary } from "../src/crm/commercial/persistence-contracts.js";
import { type createLocalWorkflowService, LocalWorkflowError, localPageInput, localParse, localSearchInput } from "./workflow-service.js";

type Token = string | null | undefined;
const escaped = (value: string) => `%${value.replace(/[!%_]/g, "!$&")}%`;
const quotationSearch = localSearchInput.extend({ sort: z.enum(QUOTATION_SORTS).default("createdAt"), direction: z.enum(["asc", "desc"]).default("desc") });
const pipelineInput = localSearchInput.extend({ stage: z.enum(["all", "qualification", "siteVisit", "proposal", "won", "lost", "other"]).default("all"),
  agentId: z.string().min(1).max(100).refine(value => Array.from(value).every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)).optional(),
  scope: z.enum(["default", "own"]).default("default") });
const stage = `CASE ${PIPELINE_STAGES.map(value => `WHEN t.status IN (${value.statuses.map(status => `'${status}'`).join(",")}) THEN '${value.key}'`).join(" ")} ELSE 'other' END`;
const number = `CASE (${stage}) WHEN 'qualification' THEN t.qual_deal_number WHEN 'siteVisit' THEN t.site_deal_number
  WHEN 'proposal' THEN t.quote_deal_number WHEN 'won' THEN t.job_deal_number WHEN 'lost' THEN t.lost_deal_number ELSE t.deal_number END`;
const from = `FROM tasks t LEFT JOIN users u ON u.user_id=t.assigned_to LEFT JOIN crm_demo_local_tasks l ON l.task_id=t.id
  LEFT JOIN users local_owner ON local_owner.id=l.owner_user_id`;
const name = "CASE WHEN l.task_id IS NOT NULL THEN local_owner.username ELSE u.username END";
const projection = `CAST(t.id AS TEXT) id,t.deal_name dealName,t.status,(${stage}) stage,t.account_name accountName,
  t.assigned_to assignedExternalId,${name} assignedName,t.service_charge serviceCharge,(${number}) displayNumber,
  t.created_at createdAt,t.updated_at updatedAt`;

/** Read composition with the original filters and pagination, plus the explicit
 * immutable local ownership relation. No older record receives local ownership. */
export function createLocalWorkflowReads(db: SqliteDatabase, workflow: ReturnType<typeof createLocalWorkflowService>,
  leads: ReturnType<typeof createLeadsService>, commercial: ReturnType<typeof createCommercialService>) {
  function getLead(token: Token, id: unknown): LeadDetail {
    if (!workflow.isLocal(id)) return leads.getLead(token, id);
    return db.transaction(() => {
      const user = workflow.current(token), local = workflow.task(user, id);
      const row = db.prepare(`SELECT ${projection},t.zoho_crm_id externalId,t.customer_name customerName,t.customer_email customerEmail,
        t.customer_contact customerContact,t.address,t.complaint_info description,t.remark,t.notes,t.assign_notes assignmentNotes,
        t.owner_id ownerExternalId,CAST(t.deal_crm_created_by AS TEXT) createdByLocalId,t.Job_Status jobStatus,t.deal_number dealNumber,
        t.enq_number enquiryNumber,t.qual_deal_number qualificationNumber,t.site_deal_number siteNumber,t.quote_deal_number quotationNumber,
        t.job_deal_number jobNumber,t.lost_deal_number lostNumber,t.quote_number quoteId,t.enq_deal_date enquiryDate,
        t.qual_deal_date qualificationDate,t.site_deal_date siteDate,t.quote_deal_date quotationDate,t.job_deal_date jobDate,t.lost_deal_date lostDate
        ${from} WHERE t.id=?`).get(local.id) as LeadDetail;
      return { ...row, persistence: "local-demo" as const, localOwnerId: local.ownerId };
    })();
  }
  function listPipeline(token: Token, input: unknown = {}): PipelineResult {
    if (!workflow.enabled) return leads.listPipeline(token, input);
    return db.transaction(() => {
      const user = workflow.current(token);
      if (!user.permissions.includes("leads.view") && !user.permissions.includes("leads.manage.agents")) throw new LocalWorkflowError(403);
      const value = localParse(pipelineInput, input), own = user.permissions.includes("leads.manage.agents") || value.scope === "own";
      const filters = [own ? "((l.task_id IS NULL AND t.assigned_to=?) OR l.owner_user_id=?)" : "1=1"];
      const params: (string | null | number)[] = own ? [user.externalUserId, user.localUserId] : [];
      if (value.agentId) {
        filters.push(value.agentId === "unassigned" ? "t.assigned_to IS NULL AND l.task_id IS NULL" : "t.assigned_to=? AND l.task_id IS NULL");
        if (value.agentId !== "unassigned") params.push(value.agentId);
      }
      if (value.query) { filters.push(`(COALESCE(t.account_name,'') || ' ' || t.deal_name || ' ' || COALESCE(${name},'') || ' ' || t.status || ' ' || COALESCE((${number}),'')) LIKE ? ESCAPE '!'`); params.push(escaped(value.query)); }
      const filter = filters.join(" AND "), counts: Record<PipelineStage, number> = { qualification: 0, siteVisit: 0, proposal: 0, won: 0, lost: 0, other: 0 };
      for (const row of db.prepare(`SELECT (${stage}) stage,COUNT(*) count ${from} WHERE ${filter} GROUP BY stage`).all(...params) as { stage: PipelineStage; count: number }[]) counts[row.stage] = row.count;
      const chosen = value.stage === "all" ? "" : ` AND (${stage})=?`, args = value.stage === "all" ? params : [...params, value.stage];
      const rows = db.prepare(`SELECT ${projection},CAST(l.owner_user_id AS TEXT) localOwnerId ${from} WHERE ${filter}${chosen}
        ORDER BY t.created_at DESC,t.id DESC LIMIT ? OFFSET ?`).all(...args, value.pageSize, (value.page - 1) * value.pageSize) as (PipelineLead & { localOwnerId: string | null })[];
      const items = rows.map(({ localOwnerId, ...row }) => localOwnerId ? { ...row, persistence: "local-demo" as const, localOwnerId } : row);
      return { items, total: value.stage === "all" ? Object.values(counts).reduce((a, b) => a + b, 0) : counts[value.stage],
        page: value.page, pageSize: value.pageSize, counts, scope: own ? "own" as const : "all" as const };
    })();
  }
  function listNotes(token: Token, id: unknown, input: unknown = {}) {
    if (!workflow.isLocal(id)) return leads.listNotes(token, id, input);
    return db.transaction(() => {
      const row = workflow.task(workflow.current(token), id), value = localParse(localPageInput, input);
      const total = (db.prepare("SELECT COUNT(*) n FROM crm_demo_local_notes WHERE task_id=?").get(row.id) as { n: number }).n;
      const items = db.prepare(`SELECT CAST(id AS TEXT) id,title,content,NULL externalNoteId,created_at createdAt,updated_at updatedAt
        FROM crm_demo_local_notes WHERE task_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(row.id, value.pageSize, (value.page - 1) * value.pageSize) as LeadNote[];
      return { items, total, page: value.page, pageSize: value.pageSize };
    })();
  }
  function listStatusHistory(token: Token, id: unknown, input: unknown = {}) {
    if (!workflow.isLocal(id)) return leads.listStatusHistory(token, id, input);
    return db.transaction(() => {
      const row = workflow.task(workflow.current(token), id), value = localParse(localPageInput, input);
      const total = (db.prepare("SELECT COUNT(*) n FROM tasks_status_log WHERE Task_ID=?").get(row.id) as { n: number }).n;
      const items = db.prepare(`SELECT CAST(s.id AS TEXT) id,s.Status status,CAST(s.User_ID AS TEXT) actorId,u.username actorName,s.Task_Log_Create_Date occurredAt
        FROM tasks_status_log s LEFT JOIN users u ON u.id=s.User_ID WHERE s.Task_ID=? ORDER BY s.Task_Log_Create_Date DESC,s.id DESC LIMIT ? OFFSET ?`)
        .all(row.id, value.pageSize, (value.page - 1) * value.pageSize) as LeadStatusEvent[];
      return { items, total, page: value.page, pageSize: value.pageSize };
    })();
  }
  function getQuotation(token: Token, id: unknown): QuotationDetail {
    return workflow.isLocal(id) ? workflow.getQuotation(token, id) : commercial.getQuotation(token, id);
  }
  function listQuotations(token: Token, input: unknown = {}): CommercialPage<QuotationSummary> {
    if (!workflow.enabled) return commercial.listQuotations(token, input);
    return db.transaction(() => {
      const user = workflow.current(token), value = localParse(quotationSearch, input);
      if (!user.permissions.some(key => ["leads.view", "leads.manage", "leads.manage.agents"].includes(key))) throw new LocalWorkflowError(403);
      const scope = user.permissions.includes("leads.manage.agents") ? "((l.task_id IS NULL AND t.assigned_to=?) OR l.owner_user_id=?)" : "1=1";
      const params: (string | null | number)[] = user.permissions.includes("leads.manage.agents") ? [user.externalUserId, user.localUserId] : [];
      const source = `(SELECT task_id,quote_number,created_at,id,totals_json,'remote' origin FROM crm_quotations UNION ALL SELECT task_id,quote_number,created_at,id,totals_json,'local' origin FROM crm_demo_local_quotations${workflow.percentageEnabled ? " UNION ALL SELECT task_id,quote_number,created_at,id,totals_json,'percentage' origin FROM crm_demo_percentage_quotations" : ""}) q`;
      const filter = `${scope} AND (q.quote_number || ' ' || t.deal_name || ' ' || COALESCE(t.account_name,'')) LIKE ? ESCAPE '!'`;
      params.push(escaped(value.query));
      const joined = `FROM ${source} JOIN tasks t ON t.id=q.task_id LEFT JOIN crm_demo_local_tasks l ON l.task_id=t.id LEFT JOIN users u ON u.user_id=t.assigned_to LEFT JOIN users local_owner ON local_owner.id=l.owner_user_id`;
      const total = (db.prepare(`SELECT COUNT(*) n ${joined} WHERE ${filter}`).get(...params) as { n: number }).n;
      const ids = db.prepare(`SELECT CAST(t.id AS TEXT) id ${joined} WHERE ${filter} ORDER BY ${quotationListOrder(value.sort, value.direction, "sqlite", true)} LIMIT ? OFFSET ?`)
        .all(...params, value.pageSize, (value.page - 1) * value.pageSize) as { id: string }[];
      const items = ids.map(({ id }) => {
        const { quotation, totals, task, remoteModifiedAt, calculationPolicy, ...summary } = getQuotation(token, id);
        void quotation; void totals; void task; void remoteModifiedAt; void calculationPolicy; return summary;
      });
      return { items, total, page: value.page, pageSize: value.pageSize };
    })();
  }
  function listQuotationCandidates(token: Token, input: unknown = {}): CommercialPage<QuotationCandidate> {
    if (!workflow.enabled) return commercial.listQuotationCandidates(token, input);
    return db.transaction(() => {
      const user = workflow.current(token), value = localParse(localSearchInput, input);
      if (!user.permissions.some(key => ["leads.manage", "leads.manage.agents"].includes(key))) throw new LocalWorkflowError(403);
      const filter = `((l.task_id IS NULL AND t.assigned_to=? AND COALESCE(t.zoho_crm_id,'')!='') OR l.owner_user_id=?)
        AND COALESCE(t.quote_number,'')='' AND COALESCE(t.quote_id,'')=''
        AND NOT EXISTS(SELECT 1 FROM crm_quotations q WHERE q.task_id=t.id)
        AND NOT EXISTS(SELECT 1 FROM crm_demo_local_quotations q WHERE q.task_id=t.id)
        ${workflow.percentageEnabled ? "AND NOT EXISTS(SELECT 1 FROM crm_demo_percentage_quotations q WHERE q.task_id=t.id)" : ""}
        AND (t.deal_name || ' ' || COALESCE(t.deal_number,'') || ' ' || COALESCE(t.account_name,'')) LIKE ? ESCAPE '!'`;
      const params = [user.externalUserId, user.localUserId, escaped(value.query)];
      const total = (db.prepare(`SELECT COUNT(*) n ${from} WHERE ${filter}`).get(...params) as { n: number }).n;
      const items = db.prepare(`SELECT CAST(t.id AS TEXT) taskId,t.deal_name dealName,t.deal_number dealNumber,t.account_name accountName,t.version,
        CAST(l.owner_user_id AS TEXT) localOwnerId ${from} WHERE ${filter} ORDER BY t.created_at DESC,t.id DESC LIMIT ? OFFSET ?`)
        .all(...params, value.pageSize, (value.page - 1) * value.pageSize) as (QuotationCandidate & { localOwnerId: string | null })[];
      return { items: items.map(({ localOwnerId, ...row }) => localOwnerId ? { ...row, localOwnerId, persistence: "local-demo" as const } : row), total, page: value.page, pageSize: value.pageSize };
    })();
  }
  return { getLead, listPipeline, listNotes, listStatusHistory, getQuotation, listQuotations, listQuotationCandidates };
}
