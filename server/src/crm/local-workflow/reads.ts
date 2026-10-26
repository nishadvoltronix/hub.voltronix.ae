import { z } from "zod";
import { PIPELINE_STAGES, type LeadDetail, type LeadNote, type LeadStatusEvent, type PipelineLead, type PipelineResult, type PipelineStage } from "@voltronix/crm-contracts";
import type { MysqlDatabase } from "../db/mysql/database.js";
import type { createLeadsService } from "../leads/service.js";
import type { createCommercialService } from "../commercial/service.js";
import { QUOTATION_SORTS, quotationListOrder } from "../commercial/list-order.js";
import type { CommercialPage, QuotationCandidate, QuotationDetail, QuotationSummary } from "../commercial/persistence-contracts.js";
import { type createLocalWorkflowService, LocalWorkflowError, localPageInput, localParse, localSearchInput } from "./service.js";
import { visibleOwnership as provenance } from "./ownership.js";
import { displayedSyncAssigneeIdSql, importedTaskSql, recordedSyncAssigneeSql, visibleSyncTaskSql } from "../zoho-sync/provenance.js";

type Token = string | null | undefined;
const escaped = (value: string) => `%${value.replace(/[!%_]/g, "!$&")}%`;
const quotationSearch = localSearchInput.extend({ sort: z.enum(QUOTATION_SORTS).default("createdAt"), direction: z.enum(["asc", "desc"]).default("desc") });
const pipelineInput = localSearchInput.extend({ stage: z.enum(["all", "qualification", "siteVisit", "proposal", "won", "lost", "other"]).default("all"),
  agentId: z.string().min(1).max(100).refine(value => Array.from(value).every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)).optional(),
  scope: z.enum(["default", "own"]).default("default") });
const stage = `CASE ${PIPELINE_STAGES.map(value => `WHEN t.status IN (${value.statuses.map(status => `'${status}'`).join(",")}) THEN '${value.key}'`).join(" ")} ELSE 'other' END`;
const number = `CASE (${stage}) WHEN 'qualification' THEN t.qual_deal_number WHEN 'siteVisit' THEN t.site_deal_number
  WHEN 'proposal' THEN t.quote_deal_number WHEN 'won' THEN t.job_deal_number WHEN 'lost' THEN t.lost_deal_number ELSE t.deal_number END`;
const from = `FROM tasks t LEFT JOIN users u ON u.user_id=t.assigned_to LEFT JOIN crm_local_tasks l ON l.task_id=t.id
  LEFT JOIN users local_owner ON local_owner.id=l.owner_user_id`;
const name = `CASE WHEN l.task_id IS NOT NULL THEN local_owner.username ELSE COALESCE(u.username,${recordedSyncAssigneeSql()}) END`;
const projection = `CAST(t.id AS CHAR) id,t.deal_name dealName,t.status,(${stage}) stage,t.account_name accountName,
  t.assigned_to assignedExternalId,${name} assignedName,t.service_charge serviceCharge,(${number}) displayNumber,
  t.created_at createdAt,t.updated_at updatedAt`;
// Positive, immutable creation evidence only. An old NULL external ID or creator
// field never gives a historical task local ownership; damaged provenance is hidden.
function count(value: number) { if (!Number.isSafeInteger(value) || value < 0) throw new LocalWorkflowError(503); return value; }

/** Compose the existing historical readers with new, positively proven MySQL
 * local records. Reads never create ownership, reprice history, or reach Zoho. */
export function createLocalWorkflowReads(db: MysqlDatabase, workflow: ReturnType<typeof createLocalWorkflowService>,
  leads: ReturnType<typeof createLeadsService>, commercial: ReturnType<typeof createCommercialService>) {
  async function read<T>(work: () => Promise<T>): Promise<T> {
    try { return await db.transaction(work)(); }
    catch (error) { if (error instanceof LocalWorkflowError) throw error; throw new LocalWorkflowError(503); }
  }
  async function getLead(token: Token, id: unknown): Promise<LeadDetail> {
    if (!await workflow.isLocal(id)) return leads.getLead(token, id);
    return read(async () => {
      const user = await workflow.current(token), local = await workflow.task(user, id);
      const row = await db.prepare(`SELECT ${projection},t.zoho_crm_id externalId,t.customer_name customerName,t.customer_email customerEmail,
        t.customer_contact customerContact,t.address,t.complaint_info description,t.remark,t.notes,t.assign_notes assignmentNotes,
        t.owner_id ownerExternalId,CAST(t.deal_crm_created_by AS CHAR) createdByLocalId,t.Job_Status jobStatus,t.deal_number dealNumber,
        t.enq_number enquiryNumber,t.qual_deal_number qualificationNumber,t.site_deal_number siteNumber,t.quote_deal_number quotationNumber,
        t.job_deal_number jobNumber,t.lost_deal_number lostNumber,t.quote_number quoteId,t.enq_deal_date enquiryDate,
        t.qual_deal_date qualificationDate,t.site_deal_date siteDate,t.quote_deal_date quotationDate,t.job_deal_date jobDate,t.lost_deal_date lostDate
        ${from} WHERE t.id=?`).get(local.id) as LeadDetail | undefined;
      if (!row) throw new LocalWorkflowError(404);
      return { ...row, persistence: "local-mysql" as const, localOwnerId: local.ownerId };
    });
  }
  async function listPipeline(token: Token, input: unknown = {}): Promise<PipelineResult> {
    return read(async () => {
      const user = await workflow.current(token);
      if (!user.permissions.includes("leads.view") && !user.permissions.includes("leads.manage.agents")) throw new LocalWorkflowError(403);
      const value = localParse(pipelineInput, input), own = user.permissions.includes("leads.manage.agents") || value.scope === "own";
      const filters = [provenance, visibleSyncTaskSql(), own ? "((l.task_id IS NULL AND t.assigned_to=?) OR l.owner_user_id=?)" : "1=1"];
      const params: (string | null | number)[] = own ? [user.externalUserId, user.localUserId] : [];
      if (value.agentId) {
        const assignment = own ? "t.assigned_to" : displayedSyncAssigneeIdSql();
        filters.push(value.agentId === "unassigned" ? `${assignment} IS NULL AND l.task_id IS NULL` : `${assignment}=? AND l.task_id IS NULL`);
        if (value.agentId !== "unassigned") params.push(value.agentId);
      }
      if (value.query) { filters.push(`CONCAT(COALESCE(t.account_name,''),' ',t.deal_name,' ',COALESCE(${name},''),' ',t.status,' ',COALESCE((${number}),'')) COLLATE utf8mb4_0900_as_ci LIKE ? ESCAPE '!'`); params.push(escaped(value.query)); }
      const filter = filters.join(" AND "), counts: Record<PipelineStage, number> = { qualification: 0, siteVisit: 0, proposal: 0, won: 0, lost: 0, other: 0 };
      for (const row of await db.prepare(`SELECT (${stage}) stage,COUNT(*) count ${from} WHERE ${filter} GROUP BY stage`).all(...params) as { stage: PipelineStage; count: number }[]) counts[row.stage] = count(row.count);
      const chosen = value.stage === "all" ? "" : ` AND (${stage})=?`, args = value.stage === "all" ? params : [...params, value.stage];
      const rows = await db.prepare(`SELECT ${projection},CAST(l.owner_user_id AS CHAR) localOwnerId ${from} WHERE ${filter}${chosen}
        ORDER BY t.created_at DESC,t.id DESC LIMIT ? OFFSET ?`).all(...args, value.pageSize, (value.page - 1) * value.pageSize) as (PipelineLead & { localOwnerId: string | null })[];
      const items = rows.map(({ localOwnerId, ...row }) => localOwnerId ? { ...row, persistence: "local-mysql" as const, localOwnerId } : row);
      return { items, total: count(value.stage === "all" ? Object.values(counts).reduce((a, b) => a + b, 0) : counts[value.stage]),
        page: value.page, pageSize: value.pageSize, counts, scope: own ? "own" as const : "all" as const };
    });
  }
  async function listNotes(token: Token, id: unknown, input: unknown = {}) {
    if (!await workflow.isLocal(id)) return leads.listNotes(token, id, input);
    return read(async () => {
      const row = await workflow.task(await workflow.current(token), id), value = localParse(localPageInput, input);
      const total = count((await db.prepare("SELECT COUNT(*) n FROM crm_local_notes WHERE task_id=?").get(row.id) as { n: number }).n);
      const items = await db.prepare(`SELECT CAST(id AS CHAR) id,title,content,NULL externalNoteId,created_at createdAt,updated_at updatedAt
        FROM crm_local_notes WHERE task_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(row.id, value.pageSize, (value.page - 1) * value.pageSize) as LeadNote[];
      return { items, total, page: value.page, pageSize: value.pageSize };
    });
  }
  async function listStatusHistory(token: Token, id: unknown, input: unknown = {}) {
    if (!await workflow.isLocal(id)) return leads.listStatusHistory(token, id, input);
    return read(async () => {
      const row = await workflow.task(await workflow.current(token), id), value = localParse(localPageInput, input);
      const total = count((await db.prepare("SELECT COUNT(*) n FROM tasks_status_log WHERE Task_ID=?").get(row.id) as { n: number }).n);
      const items = await db.prepare(`SELECT CAST(s.id AS CHAR) id,s.Status status,CAST(s.User_ID AS CHAR) actorId,u.username actorName,s.Task_Log_Create_Date occurredAt
        FROM tasks_status_log s LEFT JOIN users u ON u.id=s.User_ID WHERE s.Task_ID=? ORDER BY s.Task_Log_Create_Date DESC,s.id DESC LIMIT ? OFFSET ?`)
        .all(row.id, value.pageSize, (value.page - 1) * value.pageSize) as LeadStatusEvent[];
      return { items, total, page: value.page, pageSize: value.pageSize };
    });
  }
  async function getQuotation(token: Token, id: unknown): Promise<QuotationDetail> {
    return await workflow.isLocal(id) ? workflow.getQuotation(token, id) : commercial.getQuotation(token, id);
  }
  async function listQuotations(token: Token, input: unknown = {}): Promise<CommercialPage<QuotationSummary>> {
    return read(async () => {
      const user = await workflow.current(token), value = localParse(quotationSearch, input);
      if (!user.permissions.some(key => ["leads.view", "leads.manage", "leads.manage.agents"].includes(key))) throw new LocalWorkflowError(403);
      const scope = user.permissions.includes("leads.manage.agents") ? "((l.task_id IS NULL AND t.assigned_to=?) OR l.owner_user_id=?)" : "1=1";
      const params: (string | null | number)[] = user.permissions.includes("leads.manage.agents") ? [user.externalUserId, user.localUserId] : [];
      const source = `(SELECT task_id,quote_number,created_at,id,totals_json,'remote' origin FROM crm_quotations
        UNION ALL SELECT task_id,quote_number,created_at,id,totals_json,'remote' origin FROM crm_zoho_quotations
        UNION ALL SELECT task_id,quote_number,created_at,id,totals_json,'percentage' origin FROM crm_percentage_quotations) q`;
      const filter = `${provenance} AND ${scope} AND CONCAT(q.quote_number,' ',t.deal_name,' ',COALESCE(t.account_name,'')) COLLATE utf8mb4_0900_as_ci LIKE ? ESCAPE '!'`;
      params.push(escaped(value.query));
      const joined = `FROM ${source} JOIN tasks t ON t.id=q.task_id LEFT JOIN crm_local_tasks l ON l.task_id=t.id LEFT JOIN users u ON u.user_id=t.assigned_to LEFT JOIN users local_owner ON local_owner.id=l.owner_user_id`;
      const total = count((await db.prepare(`SELECT COUNT(*) n ${joined} WHERE ${filter}`).get(...params) as { n: number }).n);
      const ids = await db.prepare(`SELECT CAST(t.id AS CHAR) id ${joined} WHERE ${filter} ORDER BY ${quotationListOrder(value.sort, value.direction, "mysql", true)} LIMIT ? OFFSET ?`)
        .all(...params, value.pageSize, (value.page - 1) * value.pageSize) as { id: string }[];
      const items: QuotationSummary[] = [];
      // MysqlDatabase forbids sibling transactions sharing savepoints; sequential
      // detail calls also keep authorization and stored-value checks in one snapshot.
      for (const { id } of ids) {
        const { quotation, totals, task, remoteModifiedAt, calculationPolicy, remoteRowIds, ...summary } = await getQuotation(token, id);
        void quotation; void totals; void task; void remoteModifiedAt; void calculationPolicy; void remoteRowIds; items.push(summary);
      }
      return { items, total, page: value.page, pageSize: value.pageSize };
    });
  }
  async function listQuotationCandidates(token: Token, input: unknown = {}): Promise<CommercialPage<QuotationCandidate>> {
    return read(async () => {
      const user = await workflow.current(token), value = localParse(localSearchInput, input);
      if (!user.permissions.some(key => ["leads.manage", "leads.manage.agents"].includes(key))) throw new LocalWorkflowError(403);
      const filter = `${provenance} AND ${visibleSyncTaskSql()} AND NOT ${importedTaskSql()} AND ((l.task_id IS NULL AND t.assigned_to=? AND COALESCE(t.zoho_crm_id,'')!='') OR l.owner_user_id=?)
        AND COALESCE(t.quote_number,'')='' AND COALESCE(t.quote_id,'')=''
        AND NOT EXISTS(SELECT 1 FROM crm_quotations q WHERE q.task_id=t.id)
        AND NOT EXISTS(SELECT 1 FROM crm_percentage_quotations q WHERE q.task_id=t.id)
        AND NOT EXISTS(SELECT 1 FROM crm_zoho_quotations q WHERE q.task_id=t.id)
        AND CONCAT(t.deal_name,' ',COALESCE(t.deal_number,''),' ',COALESCE(t.account_name,'')) COLLATE utf8mb4_0900_as_ci LIKE ? ESCAPE '!'`;
      const params = [user.externalUserId, user.localUserId, escaped(value.query)];
      const total = count((await db.prepare(`SELECT COUNT(*) n ${from} WHERE ${filter}`).get(...params) as { n: number }).n);
      const items = await db.prepare(`SELECT CAST(t.id AS CHAR) taskId,t.deal_name dealName,t.deal_number dealNumber,t.account_name accountName,t.version,
        CAST(l.owner_user_id AS CHAR) localOwnerId ${from} WHERE ${filter} ORDER BY t.created_at DESC,t.id DESC LIMIT ? OFFSET ?`)
        .all(...params, value.pageSize, (value.page - 1) * value.pageSize) as (QuotationCandidate & { localOwnerId: string | null })[];
      return { items: items.map(({ localOwnerId, ...row }) => localOwnerId ? { ...row, localOwnerId, persistence: "local-mysql" as const } : row), total, page: value.page, pageSize: value.pageSize };
    });
  }
  return { getLead, listPipeline, listNotes, listStatusHistory, getQuotation, listQuotations, listQuotationCandidates };
}
