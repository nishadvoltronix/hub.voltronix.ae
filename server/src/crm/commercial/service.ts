import { PRODUCT_SORTS, QUOTATION_SORTS, productListOrder, quotationListOrder } from "./list-order.js";
import { availableSyncProductSql, taskSyncSource } from "../zoho-sync/provenance.js";
import { createHash } from "node:crypto";
import { MysqlDatabaseError, type MysqlDatabase as Database } from "../db/mysql/database.js";
import { z } from "zod";
import { createAuthService, type AuthUser } from "../auth/service.js";
import { buildProductPayload } from "./products.js";
import { assertQuotationMode, calculateQuotation, calculateSavedQuotation, parseSavedQuotationInput, buildQuotedDealTransition, parseQuotationInput, type QuotationInput } from "./quotations.js";
import { executeQuotationContract } from "./quote-contract.js";
import { type CommercialTransport, parseWriteId, requestContract } from "./transport.js";
import { CommercialError, externalIdSchema, singleLine, multiLine, exactSearchPath } from "./validation.js";
import type { CommercialMutationResult, CommercialPage, ProductRecord, QuotationCandidate, QuotationCapabilities, QuotationDetail, QuotationSummary } from "./persistence-contracts.js";
import { assertNativeZohoContext, nativeZohoReference, type NativeZohoContext } from "../../integrations/zoho/native-numbering.js";
import { assertZohoActorBinding, ZohoUserBindingError } from "../../integrations/zoho/user-binding.js";
import { assertStoredZohoV8Quotation, assertZohoV8QuotationRowSelection, buildZohoV8QuotationCreate, buildZohoV8QuotationEdit, buildZohoV8QuotationReadRequest, parseZohoV8QuotationReadback } from "../../integrations/zoho/quotation-v8.js";
import { executeZohoV8Quotation } from "../../integrations/zoho/quotation-v8-execution.js";
import { buildStageFields, NATIVE_PRODUCTION_STAGE_PROFILE, stageReadbackMatches } from "../lead-mutations/stage-profile.js";
import { parseRecord } from "./transport.js";
import { validateLocalQuotationIssuer, type LocalQuotationIssuer } from "../quotation-pdf/render.js";

type Token = string | null | undefined;
type Kind = "product.create" | "quote.create" | "quote.edit";
type Parent = { id: string; externalId: string | null; assignedTo: string | null; status: string; version: number; quoteNumber: string | null; quoteExternalId: string | null };
type QuoteRow = { id: string; external_id: string; quote_number: string; header_json: string; totals_json: string;
  calculation_policy: string; version: number; remote_modified_at: string; created_at: string; updated_at: string;
  native?: true; organization_id?: string; mapping_profile?: string; snapshot_json?: string; issuer_company?: string | null; issuer_salesperson?: string | null };
type Operation = { actor: string; taskId: string | null; kind: Kind; request_hash: string; state: string; result_json: string | null };
export class CommercialPersistenceError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409 | 503) {
    super(({ 400: "Invalid commercial request.", 401: "Sign in required.", 403: "Access denied.", 404: "Record not found.",
      409: "The record changed or the operation is blocked pending review or reconciliation.",
      503: "Commercial changes are unavailable. An approved integration is required; an attempted operation may need reconciliation." })[status]);
    this.name = "CommercialPersistenceError";
  }
}
const localId = z.string().regex(/^[1-9][0-9]{0,18}$/).refine((v) => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9_223_372_036_854_775_807n);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1);
const paging = z.object({ query: singleLine(120).default(""), page: z.number().int().min(1).max(1_000_000).default(1), pageSize: z.number().int().min(1).max(100).default(25) }).strict();
const productPaging = paging.extend({ sort: z.enum(PRODUCT_SORTS).default("name"), direction: z.enum(["asc", "desc"]).default("asc") });
const quotationPaging = paging.extend({ sort: z.enum(QUOTATION_SORTS).default("createdAt"), direction: z.enum(["asc", "desc"]).default("desc") });
const productInput = z.object({ operationId: z.uuid(), name: singleLine(200).min(1), description: multiLine(10_000) }).strict();
const createInput = z.object({ operationId: z.uuid(), expectedVersion: version, quotation: z.unknown() }).strict();
const editInput = createInput.extend({ expectedQuoteVersion: version });
const nativeEditInput = editInput.extend({ remoteRowIds: z.array(externalIdSchema.nullable()).min(1).max(200) });
const productProjection = "product_id externalId,product_name name,description,unit_price unitPrice,version,created_at createdAt,updated_at updatedAt";
function parse<T>(schema: z.ZodType<T>, input: unknown): T { const value = schema.safeParse(input); if (!value.success) throw new CommercialPersistenceError(400); return value.data; }
function escaped(value: string) { return `%${value.replace(/[!%_]/g, "!$&")}%`; }

export function createCommercialService(db: Database, options: { transport?: CommercialTransport; now?: () => number; production?: NativeZohoContext; issuer?: LocalQuotationIssuer; dealPipeline?: string } = {}) {
  const production = options.production;
  if (production) assertNativeZohoContext(production);
  const issuer = options.issuer === undefined ? undefined : validateLocalQuotationIssuer(options.issuer);
  const now = options.now ?? Date.now, auth = createAuthService(db, { now }), at = () => new Date(now()).toISOString();
  async function safe<T>(work: () => Promise<T>): Promise<T> { try { return (await work()); } catch (error) {
    if (error instanceof MysqlDatabaseError && error.code === "MYSQL_CONFLICT") throw new CommercialPersistenceError(409);
    if (error instanceof CommercialPersistenceError) throw error;
    if (error instanceof ZohoUserBindingError) throw new CommercialPersistenceError(403);
    if (error instanceof CommercialError && (error.status === 400 || error.status === 409)) throw new CommercialPersistenceError(error.status);
    throw new CommercialPersistenceError(503);
  } }
  async function current(token: Token): Promise<AuthUser> { const user = (await auth.authenticate(token)); if (!user) throw new CommercialPersistenceError(401); return user; }
  async function productActor(token: Token, write = false) {
    const user = (await current(token)), permitted = write ? user.permissions.includes("items.write") :
      user.permissions.some((key) => ["items.view", "items.write", "leads.manage", "leads.manage.agents"].includes(key));
    if (!permitted) throw new CommercialPersistenceError(403);
    if (write && production) await assertZohoActorBinding(db, user, production.organizationId);
    return user;
  }
  async function quoteActor(token: Token, write = false) {
    const user = (await current(token));
    if (!user.permissions.some((key) => (write ? ["leads.manage", "leads.manage.agents"] : ["leads.view", "leads.manage", "leads.manage.agents"]).includes(key))) throw new CommercialPersistenceError(403);
    if (write && production) await assertZohoActorBinding(db, user, production.organizationId);
    return user;
  }
  async function parent(user: AuthUser, id: unknown, write = false): Promise<Parent> {
    if (!localId.safeParse(id).success) throw new CommercialPersistenceError(404);
    const row = (await db.prepare("SELECT CAST(id AS CHAR) id,zoho_crm_id externalId,assigned_to assignedTo,status,version,quote_number quoteNumber,quote_id quoteExternalId FROM tasks WHERE id=?").get(id)) as Parent | undefined;
    if (!row) throw new CommercialPersistenceError(404);
    const owns = user.externalUserId !== null && row.assignedTo === user.externalUserId;
    const canRead = user.permissions.includes("leads.manage.agents") ? owns :
      user.permissions.some((key) => ["leads.view", "leads.manage"].includes(key)) || (await auth.canAccessTask(user, row.id));
    if (!canRead) throw new CommercialPersistenceError(404);
    if (write && await taskSyncSource(db, row.id)) throw new CommercialPersistenceError(403);
    if (write && (!owns || !user.permissions.some((key) => ["leads.manage", "leads.manage.agents"].includes(key)))) throw new CommercialPersistenceError(403);
    return row;
  }
  async function quoteRow(taskId: string): Promise<QuoteRow | undefined> {
    {
      const native = await db.prepare("SELECT CAST(id AS CHAR) id,external_id,quote_number,header_json,totals_json,calculation_policy,version,remote_modified_at,created_at,updated_at,organization_id,mapping_profile,snapshot_json,issuer_company,issuer_salesperson FROM crm_zoho_quotations WHERE task_id=?").get(taskId) as QuoteRow | undefined;
      if (native) {
        if (!externalIdSchema.safeParse(native.organization_id).success || native.mapping_profile !== "voltronix-custom-quoted-items-v8"
          || (production && native.organization_id !== production.organizationId)) throw new CommercialPersistenceError(409);
        return { ...native, native: true };
      }
    }
    return (await db.prepare("SELECT CAST(id AS CHAR) id,external_id,quote_number,header_json,totals_json,calculation_policy,version,remote_modified_at,created_at,updated_at FROM crm_quotations WHERE task_id=?").get(taskId)) as QuoteRow | undefined;
  }
  async function quoteInput(row: QuoteRow, taskId: string): Promise<QuotationInput> {
    const items = (await db.prepare(`SELECT product_id productId,product_name productName,product_description description,uom,quantity,
      service_charge unitPrice,item_discount itemDiscount FROM ${row.native ? "crm_zoho_quotation_items" : "proposal_items"} WHERE quotation_id=? AND task_id=? ORDER BY position`).all(row.id, taskId));
    try { return parseSavedQuotationInput({ ...JSON.parse(row.header_json), items }, row.calculation_policy); } catch { throw new CommercialPersistenceError(503); }
  }
  async function detail(user: AuthUser, taskId: unknown): Promise<QuotationDetail> {
    const task = (await parent(user, taskId)), row = (await quoteRow(task.id)); if (!row) throw new CommercialPersistenceError(404);
    const quotation = (await quoteInput(row, task.id)), totals = calculateSavedQuotation(quotation, row.calculation_policy);
    if (JSON.stringify(totals) !== row.totals_json
      || task.quoteExternalId !== row.external_id || task.quoteNumber !== row.quote_number) throw new CommercialPersistenceError(503);
    const snapshot = (await db.prepare(`SELECT t.deal_name dealName,t.deal_number dealNumber,t.account_name accountName,t.customer_name customerName,
      t.customer_email customerEmail,t.customer_contact customerContact,t.address,t.status,t.Job_Status jobStatus,t.assigned_to assignedExternalId,
      u.username assignedName,u.company assignedCompany,u.sale_name assignedSaleName,t.created_at createdAt,t.quote_deal_date quoteDealDate,
      t.quote_deal_number quoteDealNumber,t.p_box pBox,t.trn,t.tax_total taxTotal FROM tasks t LEFT JOIN users u ON u.user_id=t.assigned_to WHERE t.id=?`).get(task.id)) as QuotationDetail["task"];
    let remoteRowIds: string[] | undefined;
    if (row.native) {
      const rows = await db.prepare("SELECT remote_row_id rowId FROM crm_zoho_quotation_items WHERE quotation_id=? AND task_id=? ORDER BY position").all(row.id, task.id) as { rowId: string }[];
      remoteRowIds = rows.map(item => item.rowId);
      if (rows.length !== quotation.items.length || new Set(remoteRowIds).size !== rows.length || remoteRowIds.some(id => !externalIdSchema.safeParse(id).success)) throw new CommercialPersistenceError(503);
      try { assertStoredZohoV8Quotation(JSON.parse(row.snapshot_json!), quotation,
        { quoteId: row.external_id, quoteNumber: row.quote_number, modifiedTime: row.remote_modified_at, dealId: task.externalId!, rowIds: remoteRowIds },
        "voltronix-custom-quoted-items-v8"); } catch { throw new CommercialPersistenceError(503); }
      snapshot.assignedCompany = row.issuer_company ?? null;
      snapshot.assignedSaleName = row.issuer_salesperson ?? null;
    }
    return { id: row.id, taskId: task.id, externalId: row.external_id, quoteNumber: row.quote_number, subject: quotation.subject,
      accountName: snapshot.accountName, dealName: snapshot.dealName, assignedName: snapshot.assignedName, subtotal: totals.subtotal, grandTotal: totals.grandTotal,
      dealNumber: snapshot.dealNumber, dealStatus: snapshot.status, ...(snapshot.jobStatus === undefined ? {} : { jobStatus: snapshot.jobStatus }),
      version: row.version, taskVersion: task.version, createdAt: row.created_at, updatedAt: row.updated_at, remoteModifiedAt: row.remote_modified_at,
      calculationPolicy: row.calculation_policy as QuotationDetail["calculationPolicy"], quotation, totals, task: snapshot,
      ...(row.native ? { persistence: "zoho" as const, remoteRowIds: remoteRowIds!, pdfAvailable: !!row.issuer_company && !!row.issuer_salesperson } : {}) };
  }
  function scope(user: AuthUser, forceOwn = false) {
    return forceOwn || user.permissions.includes("leads.manage.agents") ? { clause: "t.assigned_to=?", params: [user.externalUserId ?? ""] } : { clause: "1=1", params: [] };
  }
  async function getProduct(token: Token, id: unknown): Promise<ProductRecord> {
    return (await safe(async () => (await db.transaction(async () => { (await productActor(token)); const key = externalIdSchema.safeParse(id); if (!key.success) throw new CommercialPersistenceError(404);
      const row = (await db.prepare(`SELECT ${productProjection} FROM products WHERE product_id=? AND ${availableSyncProductSql()}`).get(key.data)) as ProductRecord | undefined;
      if (!row) throw new CommercialPersistenceError(404); return row;
    })())));
  }
  async function listProducts(token: Token, input: unknown = {}): Promise<CommercialPage<ProductRecord>> {
    return (await safe(async () => (await db.transaction(async () => { (await productActor(token)); const value = parse(productPaging, input), pattern = escaped(value.query);
      const filter = `CONCAT(product_name,' ',COALESCE(description,'')) COLLATE utf8mb4_0900_as_ci LIKE ? ESCAPE '!' AND ${availableSyncProductSql()}`;
      const total = ((await db.prepare(`SELECT COUNT(*) n FROM products WHERE ${filter}`).get(pattern)) as { n: number }).n;
      if (!Number.isSafeInteger(total) || total < 0) throw new CommercialPersistenceError(503);
      const items = (await db.prepare(`SELECT ${productProjection} FROM products WHERE ${filter} ORDER BY ${productListOrder(value.sort, value.direction)} LIMIT ? OFFSET ?`).all(pattern, value.pageSize, (value.page - 1) * value.pageSize)) as ProductRecord[];
      return { items, total, page: value.page, pageSize: value.pageSize };
    })())));
  }
  async function listQuotations(token: Token, input: unknown = {}): Promise<CommercialPage<QuotationSummary>> {
    return (await safe(async () => (await db.transaction(async () => { const user = (await quoteActor(token)), value = parse(quotationPaging, input), own = scope(user);
      const filter = `${own.clause} AND CONCAT(q.quote_number,' ',t.deal_name,' ',COALESCE(t.account_name,'')) COLLATE utf8mb4_0900_as_ci LIKE ? ESCAPE '!'`;
      const params = [...own.params, escaped(value.query)];
      const source = "(SELECT task_id,quote_number,created_at,id,totals_json FROM crm_quotations UNION ALL SELECT task_id,quote_number,created_at,id,totals_json FROM crm_zoho_quotations) q";
      const total = ((await db.prepare(`SELECT COUNT(*) n FROM ${source} JOIN tasks t ON t.id=q.task_id LEFT JOIN users u ON u.user_id=t.assigned_to WHERE ${filter}`).get(...params)) as { n: number }).n;
      if (!Number.isSafeInteger(total) || total < 0) throw new CommercialPersistenceError(503);
      const ids = (await db.prepare(`SELECT CAST(t.id AS CHAR) id FROM ${source} JOIN tasks t ON t.id=q.task_id LEFT JOIN users u ON u.user_id=t.assigned_to WHERE ${filter} ORDER BY ${quotationListOrder(value.sort, value.direction, "mysql")} LIMIT ? OFFSET ?`)
        .all(...params, value.pageSize, (value.page - 1) * value.pageSize)) as { id: string }[];
      const items: QuotationSummary[] = [];
      for (const { id } of ids) {
        const { quotation: _quotation, totals: _totals, task: _task, remoteModifiedAt: _remote, calculationPolicy: _policy, remoteRowIds: _rows, ...summary } = await detail(user, id);
        void _quotation; void _totals; void _task; void _remote; void _policy; void _rows;
        items.push(summary);
      }
      return { items, total, page: value.page, pageSize: value.pageSize };
    })())));
  }
  async function listQuotationCandidates(token: Token, input: unknown = {}): Promise<CommercialPage<QuotationCandidate>> {
    return (await safe(async () => (await db.transaction(async () => { const user = (await quoteActor(token, true)), value = parse(paging, input), own = scope(user, true);
      const filter = `${own.clause} AND COALESCE(t.quote_number,'')='' AND COALESCE(t.quote_id,'')='' AND COALESCE(t.zoho_crm_id,'')!=''
        AND NOT EXISTS(SELECT 1 FROM crm_quotations q WHERE q.task_id=t.id)
        AND NOT EXISTS(SELECT 1 FROM crm_zoho_quotations q WHERE q.task_id=t.id)
        AND CONCAT(t.deal_name,' ',COALESCE(t.deal_number,''),' ',COALESCE(t.account_name,'')) COLLATE utf8mb4_0900_as_ci LIKE ? ESCAPE '!'`;
      const params = [...own.params, escaped(value.query)];
      const total = ((await db.prepare(`SELECT COUNT(*) n FROM tasks t WHERE ${filter}`).get(...params)) as { n: number }).n;
      if (!Number.isSafeInteger(total) || total < 0) throw new CommercialPersistenceError(503);
      const items = (await db.prepare(`SELECT CAST(t.id AS CHAR) taskId,t.deal_name dealName,t.deal_number dealNumber,t.account_name accountName,t.version FROM tasks t WHERE ${filter}
        ORDER BY t.created_at DESC,t.id DESC LIMIT ? OFFSET ?`).all(...params, value.pageSize, (value.page - 1) * value.pageSize)) as QuotationCandidate[];
      return { items, total, page: value.page, pageSize: value.pageSize };
    })())));
  }
  async function operation(id: string): Promise<Operation | undefined> {
    return (await db.prepare("SELECT CAST(actor_user_id AS CHAR) actor,CAST(task_id AS CHAR) taskId,kind,request_hash,state,result_json FROM crm_commercial_operations WHERE operation_id=?").get(id)) as Operation | undefined;
  }
  async function busy(taskId: string) {
    return (await db.prepare("SELECT operation_id FROM crm_commercial_operations WHERE task_id=? AND state!='completed' UNION ALL SELECT operation_id FROM crm_lead_operations WHERE task_id=? AND state!='completed' LIMIT 1").get(taskId, taskId)) as { operation_id: string } | undefined;
  }
  async function reserve(user: AuthUser, task: Parent | null, kind: Kind, operationId: string, value: unknown): Promise<CommercialMutationResult | undefined> {
    const hash = createHash("sha256").update(JSON.stringify(production ? { input: value, production } : value)).digest("hex"), old = (await operation(operationId));
    if (old) {
      if (old.actor !== user.localUserId || old.taskId !== (task?.id ?? null) || old.kind !== kind || old.request_hash !== hash || old.state !== "completed" || !old.result_json) throw new CommercialPersistenceError(409);
      return JSON.parse(old.result_json) as CommercialMutationResult;
    }
    if (!options.transport) throw new CommercialPersistenceError(503);
    if (task ? (await busy(task.id)) : (await db.prepare("SELECT 1 FROM crm_commercial_operations WHERE actor_user_id=? AND kind='product.create' AND state!='completed'").get(user.localUserId))) throw new CommercialPersistenceError(409);
    (await db.prepare("INSERT INTO crm_commercial_operations(operation_id,actor_user_id,task_id,kind,request_hash,state,created_at,updated_at) VALUES(?,?,?,?,?,'inflight',?,?)")
      .run(operationId, user.localUserId, task?.id ?? null, kind, hash, at(), at()));
  }
  async function finish(user: AuthUser, taskId: string | null, kind: Kind, result: CommercialMutationResult, targetId: string, fields: string[]) {
    if (production) result = { ...result, persistence: "zoho", remoteVerified: true };
    (await db.prepare("INSERT INTO crm_commercial_audit_events(actor_user_id,task_id,operation_id,action,target_id,changed_fields,occurred_at) VALUES(?,?,?,?,?,?,?)")
      .run(user.localUserId, taskId, result.operationId, kind, targetId, JSON.stringify(fields), at()));
    const change = (await db.prepare("UPDATE crm_commercial_operations SET state='completed',result_json=?,updated_at=? WHERE operation_id=? AND state='inflight'").run(JSON.stringify(result), at(), result.operationId));
    if (change.changes !== 1) throw new CommercialPersistenceError(409); return result;
  }
  function transport(operationId: string, authorize: () => Promise<void>, boundary: { error?: unknown }): CommercialTransport {
    async function journal(assignments: string, values: unknown[], unchanged: string, expected: unknown[]) {
      try {
        await safe(async () => db.transaction(async () => {
          const update = await db.prepare(`UPDATE crm_commercial_operations SET ${assignments} WHERE operation_id=? AND state='inflight'`)
            .run(...values, operationId);
          if (update.changes === 1) return;
          // -FOUND_ROWS can report zero for a same-value, same-clock update.
          // A locking read proves that exact journal evidence still belongs to
          // this inflight operation, without holding a transaction over HTTP.
          if (update.changes === 0 && await db.prepare(`SELECT operation_id FROM crm_commercial_operations WHERE operation_id=? AND state='inflight' AND ${unchanged} FOR UPDATE`)
            .get(operationId, ...expected)) return;
          throw new CommercialPersistenceError(409);
        }).immediate());
      } catch (error) { boundary.error = error; throw error; }
    }
    return { async request(request) {
      try { (await safe(authorize)); } catch (error) { boundary.error = error; throw error; }
      if (!options.transport) throw new CommercialPersistenceError(503);
      if (request.method !== "GET") await journal("remote_effect_possible=1,updated_at=?", [at()], "remote_effect_possible=1", []);
      const response = await options.transport.request(request);
      if (request.method !== "GET" && response.status >= 200 && response.status < 300) {
        let id: string | undefined; try { id = parseWriteId(response.body); } catch { /* caller validates acknowledgement */ }
        const key = /^\/Contacts(?:\/\d+)?$/.test(request.path) ? "contactId" : /^\/Products(?:\/\d+)?$/.test(request.path) ? "productId" : /^\/Quotes(?:\/\d+)?$/.test(request.path) ? "quoteId" : /^\/Deals(?:\/\d+)?$/.test(request.path) ? "dealId" : null;
        if (id && key) await journal("remote_references=json_set(remote_references,?,?),updated_at=?",
          [`$.${key}`, id, at()], "JSON_UNQUOTE(JSON_EXTRACT(remote_references,?))=?", [`$.${key}`, id]);
      }
      return response;
    } };
  }
  async function guarded<T>(id: string, boundary: { error?: unknown }, work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) {
      (await safe(async () => (await db.prepare("UPDATE crm_commercial_operations SET state='reconciliation',updated_at=? WHERE operation_id=? AND state='inflight'").run(at(), id))));
      if (boundary.error instanceof CommercialPersistenceError) throw boundary.error;
      if (error instanceof CommercialPersistenceError) throw error;
      throw new CommercialPersistenceError(503);
    }
  }
  async function createProduct(token: Token, input: unknown): Promise<CommercialMutationResult> {
    const start = (await safe(async () => (await db.transaction(async () => { const user = (await productActor(token, true)), value = parse(productInput, input);
      const replay = (await reserve(user, null, "product.create", value.operationId, value)); return { user, value, replay }; }).immediate())));
    if (start.replay) return start.replay;
    const { value } = start, boundary: { error?: unknown } = {};
    return (await guarded(value.operationId, boundary, async () => {
      const port = transport(value.operationId, async () => { (await productActor(token, true)); }, boundary);
      const reply = await requestContract(port, { apiVersion: production ? "v8" : "v2.1", method: "POST", path: "/Products", body: buildProductPayload({ name: value.name, description: value.description }) });
      const id = parseWriteId(reply.body);
      if (production) {
        const row = parseRecord((await requestContract(port, { apiVersion: "v8", method: "GET", path: `/Products/${id}?fields=Product_Name,Description` })).body);
        if (row.id !== id || row.Product_Name !== value.name || (row.Description ?? "") !== value.description) throw new CommercialPersistenceError(503);
      }
      return (await safe(async () => (await db.transaction(async () => { const user = (await productActor(token, true));
        if ((await db.prepare("SELECT 1 FROM products WHERE product_id=?").get(id))) throw new CommercialPersistenceError(409);
        (await db.prepare("INSERT INTO products(product_id,product_name,description,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, value.name, value.description, at(), at()));
        return (await finish(user, null, "product.create", { operationId: value.operationId, productId: id, version: 1 }, id, ["product_name", "description"]));
      }).immediate())));
    }));
  }
  async function checkProducts(quote: QuotationInput) {
    for (const item of quote.items) {
      if (await db.prepare("SELECT 1 FROM crm_zoho_sync_records WHERE module_api_name='Products' AND external_id=? AND state!='active' LIMIT 1").get(item.productId)) throw new CommercialPersistenceError(409);
      const product = (await db.prepare("SELECT product_name FROM products WHERE product_id=?").get(item.productId)) as { product_name: string } | undefined;
      if (!product || product.product_name !== item.productName) throw new CommercialPersistenceError(400);
    }
  }
  async function mutateNativeQuotation(token: Token, taskId: unknown, input: unknown, edit: boolean): Promise<CommercialMutationResult> {
    if (!production) throw new CommercialPersistenceError(503);
    const profile = production.quotationProfile;
    const start = await safe(() => db.transaction(async () => {
      const user = await quoteActor(token, true), task = await parent(user, taskId, true);
      const value = edit ? parse(nativeEditInput, input) : parse(createInput, input);
      const remoteRowIds = edit ? parse(nativeEditInput, input).remoteRowIds : undefined;
      const quotation = parseQuotationInput(value.quotation), existing = await quoteRow(task.id), previous = await operation(value.operationId);
      if (Buffer.byteLength(JSON.stringify(value), "utf8") > 256 * 1024) throw new CommercialPersistenceError(400);
      // Validate all financial/field limits before reserving. Description lookup
      // happens separately; this validation plan is never sent or persisted.
      try { buildZohoV8QuotationCreate({ ...quotation, notes: null, items: quotation.items.map(item => ({ ...item, description: item.description || "description lookup pending" })) },
        { dealId: "1", contactId: "1" }, profile); } catch { throw new CommercialPersistenceError(400); }
      if (!/^(?:0|[1-9][0-9]{0,29})\.[0-9]{2}$/.test(calculateQuotation(quotation).subtotal)) throw new CommercialPersistenceError(400);
      if (!previous) {
        if (task.version !== value.expectedVersion || task.version >= Number.MAX_SAFE_INTEGER - 1 || !externalIdSchema.safeParse(task.externalId).success) throw new CommercialPersistenceError(409);
        if (edit) {
          if (!existing?.native || !("expectedQuoteVersion" in value) || existing.version !== value.expectedQuoteVersion || existing.version >= Number.MAX_SAFE_INTEGER - 1
            || existing.external_id !== task.quoteExternalId || existing.quote_number !== task.quoteNumber
            || remoteRowIds?.length !== quotation.items.length) throw new CommercialPersistenceError(409);
          const saved = await detail(user, task.id);
          try { assertZohoV8QuotationRowSelection(saved.quotation.items.map((item, index) => ({ productId: item.productId, rowId: saved.remoteRowIds![index]! })), quotation.items, remoteRowIds!); }
          catch { throw new CommercialPersistenceError(400); }
        } else if (existing || task.quoteNumber || task.quoteExternalId) throw new CommercialPersistenceError(409);
        await checkProducts(quotation);
      }
      const kind: Kind = edit ? "quote.edit" : "quote.create";
      const replay = await reserve(user, task, kind, value.operationId, { ...value, quotation });
      return { task, value, quotation, existing, kind, replay, remoteRowIds };
    }).immediate());
    if (start.replay) return start.replay;
    const { task, value, quotation, existing, kind, remoteRowIds } = start, boundary: { error?: unknown } = {};
    async function reauthorize() {
      return db.transaction(async () => {
        const user = await quoteActor(token, true), fresh = await parent(user, task.id, true), saved = await quoteRow(task.id);
        if (fresh.version !== task.version || fresh.externalId !== task.externalId || fresh.quoteExternalId !== task.quoteExternalId || fresh.quoteNumber !== task.quoteNumber
          || (existing ? !saved?.native || saved.version !== existing.version || saved.external_id !== existing.external_id : !!saved)) throw new CommercialPersistenceError(409);
        return user;
      })();
    }
    return guarded(value.operationId, boundary, async () => {
      const port = transport(value.operationId, async () => { await reauthorize(); }, boundary);
      const deal = parseRecord((await requestContract(port, { apiVersion: "v8", method: "GET", path: `/Deals/${task.externalId}` })).body);
      const lookupId = (value: unknown): string => {
        const parsed = z.object({ id: externalIdSchema }).safeParse(value);
        if (!parsed.success) throw new CommercialPersistenceError(409); return parsed.data.id;
      };
      if (deal.id !== task.externalId || lookupId(deal.VZ_app_user) !== task.assignedTo || lookupId(deal.$layout_id) !== production.dealLayoutId
        || !z.iso.datetime({ offset: true }).safeParse(deal.Modified_Time).success) throw new CommercialPersistenceError(409);
      const stageMatches = ["Pending", "Qualification"].includes(task.status) ? deal.Stage === "Qualification" && deal.VZ_App_Status === "Pending"
        : ["Site Visit", "Proposal/Price Quote", "Closed Won", "Closed Lost"].includes(task.status)
          && stageReadbackMatches(deal, task.status as "Site Visit" | "Proposal/Price Quote" | "Closed Won" | "Closed Lost", NATIVE_PRODUCTION_STAGE_PROFILE);
      if (!stageMatches || deal.Pipeline !== options.dealPipeline || (!edit && ["Closed Won", "Closed Lost"].includes(task.status))) throw new CommercialPersistenceError(409);
      const links = { dealId: task.externalId!, contactId: lookupId(deal.Contact_Name) };
      // Read back the actual contact relationship; Kind Attention is a preserved
      // Hub/PDF display field, never a free-text remote contact selector.
      const contact = parseRecord((await requestContract(port, { apiVersion: "v8", method: "GET", path: `/Contacts/${links.contactId}?fields=Account_Name` })).body);
      if (contact.id !== links.contactId || lookupId(contact.Account_Name) !== lookupId(deal.Account_Name)) throw new CommercialPersistenceError(409);
      const normalized = { ...quotation, items: quotation.items.map(item => ({ ...item })) };
      for (const item of normalized.items) {
        if (item.description !== "") continue;
        const product = parseRecord((await requestContract(port, { apiVersion: "v8", method: "GET", path: `/Products/${item.productId}?fields=Product_Name,Description` })).body);
        if (product.id !== item.productId || product.Product_Name !== item.productName || (product.Description !== null && typeof product.Description !== "string")) throw new CommercialPersistenceError(409);
        item.description = product.Description as string ?? "";
      }
      const remoteInput = { ...normalized, notes: null };
      let plan;
      if (existing) {
        const response = await requestContract(port, buildZohoV8QuotationReadRequest(existing.external_id, profile));
        const snapshot = parseZohoV8QuotationReadback(response.body, existing.external_id, profile);
        if (snapshot.modifiedTime !== existing.remote_modified_at || JSON.stringify(snapshot) !== existing.snapshot_json) throw new CommercialPersistenceError(409);
        if (!remoteRowIds) throw new CommercialPersistenceError(400);
        plan = buildZohoV8QuotationEdit(remoteInput, links, snapshot, remoteRowIds, profile, true);
      } else plan = buildZohoV8QuotationCreate(remoteInput, links, profile, true);
      const remote = await executeZohoV8Quotation(port, plan);
      let dealReference: string | undefined;
      if (!edit) {
        dealReference = nativeZohoReference("quote", task.externalId!, deal.QuoteDealNumber, remote.quoteNumber);
        const response = await requestContract(port, { apiVersion: "v8", method: "PUT", path: `/Deals/${task.externalId}`,
          ifUnmodifiedSince: deal.Modified_Time as string,
          body: { data: [{ ...buildStageFields("Proposal/Price Quote", NATIVE_PRODUCTION_STAGE_PROFILE), QuoteDealNumber: dealReference }] } });
        if (parseWriteId(response.body) !== task.externalId) throw new CommercialPersistenceError(503);
        const after = parseRecord((await requestContract(port, { apiVersion: "v8", method: "GET", path: `/Deals/${task.externalId}` })).body);
        if (after.id !== task.externalId || lookupId(after.VZ_app_user) !== task.assignedTo || lookupId(after.Contact_Name) !== links.contactId
          || lookupId(after.$layout_id) !== production.dealLayoutId || after.Pipeline !== options.dealPipeline
          || !stageReadbackMatches(after, "Proposal/Price Quote", NATIVE_PRODUCTION_STAGE_PROFILE) || after.QuoteDealNumber !== dealReference) throw new CommercialPersistenceError(503);
      }
      return safe(() => db.transaction(async () => {
        const user = await reauthorize(); await checkProducts(normalized);
        const totals = calculateQuotation(normalized), { items, ...header } = normalized;
        let quoteId: string;
        if (existing) {
          const change = await db.prepare("UPDATE crm_zoho_quotations SET header_json=?,totals_json=?,snapshot_json=?,version=version+1,remote_modified_at=?,updated_at=? WHERE id=? AND version=?")
            .run(JSON.stringify(header), JSON.stringify(totals), JSON.stringify(remote.snapshot), remote.modifiedTime, at(), existing.id, existing.version);
          if (change.changes !== 1) throw new CommercialPersistenceError(409); quoteId = existing.id;
          await db.prepare("DELETE FROM crm_zoho_quotation_items WHERE quotation_id=? AND task_id=?").run(quoteId, task.id);
        } else {
          quoteId = String((await db.prepare("INSERT INTO crm_zoho_quotations(task_id,organization_id,mapping_profile,external_id,quote_number,header_json,totals_json,snapshot_json,calculation_policy,remote_modified_at,issuer_company,issuer_salesperson,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'percentage-only-v2',?,?,?,?,?)")
            .run(task.id, production.organizationId, profile, remote.quoteId, remote.quoteNumber, JSON.stringify(header), JSON.stringify(totals), JSON.stringify(remote.snapshot),
              remote.modifiedTime, issuer?.company ?? null, issuer?.salesperson ?? null, at(), at())).lastInsertRowid);
        }
        const line = db.prepare("INSERT INTO crm_zoho_quotation_items(quotation_id,task_id,position,remote_row_id,product_id,product_name,product_description,uom,quantity,service_charge,item_discount,total) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
        for (const [index, item] of items.entries()) await line.run(quoteId, task.id, index, remote.snapshot.lines[index]!.rowId,
          item.productId, item.productName, item.description, item.uom, item.quantity, item.unitPrice, item.itemDiscount, totals.lineTotals[index]!);
        const updated = await db.prepare(`UPDATE tasks SET quote_id=?,quote_number=?,service_charge=?,notes=?,version=version+1,updated_at=?${edit ? "" : ",status='Proposal/Price Quote',quote_deal_number=?,quote_deal_date=?"} WHERE id=? AND version=?`)
          .run(remote.quoteId, remote.quoteNumber, totals.subtotal, normalized.notes, at(), ...(edit ? [] : [dealReference!, at()]), task.id, task.version);
        if (updated.changes !== 1) throw new CommercialPersistenceError(409);
        return finish(user, task.id, kind, { operationId: value.operationId, taskId: task.id, quoteId, version: task.version + 1, quoteVersion: (existing?.version ?? 0) + 1 }, quoteId,
          ["quotation_header", "quotation_remote_rows", "service_charge", "local_notes", ...(edit ? [] : ["status", "quote_deal_number"])]);
      }).immediate());
    });
  }
  async function mutateQuotation(token: Token, taskId: unknown, input: unknown, edit: boolean): Promise<CommercialMutationResult> {
    if (production) return mutateNativeQuotation(token, taskId, input, edit);
    const start = (await safe(async () => (await db.transaction(async () => {
      const user = (await quoteActor(token, true)), task = (await parent(user, taskId, true)), value = edit ? parse(editInput, input) : parse(createInput, input);
      const quotation = parseQuotationInput(value.quotation), existing = (await quoteRow(task.id)), previous = (await operation(value.operationId));
      if (Buffer.byteLength(JSON.stringify(value), "utf8") > 256 * 1024) throw new CommercialPersistenceError(400);
      // The shared task amount is consumed by dashboard/report decimal readers.
      // Bound the computed result before external effects, not just each input.
      if (!/^(?:0|[1-9][0-9]{0,29})\.[0-9]{2}$/.test(calculateQuotation(quotation, "percentage").subtotal)) throw new CommercialPersistenceError(400);
      exactSearchPath("Contacts", "Last_Name", quotation.kindAttention);
      if (!previous) {
        if (task.version !== value.expectedVersion || !Number.isSafeInteger(task.version) || task.version >= Number.MAX_SAFE_INTEGER - 1) throw new CommercialPersistenceError(409);
        if (!externalIdSchema.safeParse(task.externalId).success) throw new CommercialPersistenceError(409);
        if (edit) {
          if (!existing || !("expectedQuoteVersion" in value) || existing.version !== value.expectedQuoteVersion || existing.version >= Number.MAX_SAFE_INTEGER - 1
            || task.quoteExternalId !== existing.external_id || task.quoteNumber !== existing.quote_number) throw new CommercialPersistenceError(409);
          if (existing.calculation_policy !== "percentage-only-v2") throw new CommercialPersistenceError(409);
          assertQuotationMode(quotation, { operation: "edit", quoteId: existing.external_id });
        } else if (existing || task.quoteNumber || task.quoteExternalId) throw new CommercialPersistenceError(409);
        (await checkProducts(quotation));
      }
      const normalized = { ...value, quotation }, kind: Kind = edit ? "quote.edit" : "quote.create";
      // Frozen MySQL schema and Zoho header mapping need a separate approved v2 migration.
      if (quotation.discountType === "percentage") throw new CommercialPersistenceError(503);
      const replay = (await reserve(user, task, kind, value.operationId, normalized));
      return { task, value, quotation, existing, replay, kind };
    }).immediate())));
    if (start.replay) return start.replay;
    const { task, value, quotation, existing, kind } = start, boundary: { error?: unknown } = {};
    async function reauthorize() {
      return db.transaction(async () => {
        const user = (await quoteActor(token, true)), fresh = (await parent(user, task.id, true)), live = (await quoteRow(task.id));
        if (fresh.version !== task.version || fresh.externalId !== task.externalId || fresh.quoteExternalId !== task.quoteExternalId || fresh.quoteNumber !== task.quoteNumber
          || (existing ? live?.version !== existing.version || live.external_id !== existing.external_id : !!live)) throw new CommercialPersistenceError(409);
        if (edit && live && live.calculation_policy !== "percentage-only-v2") throw new CommercialPersistenceError(409);
        return user;
      })();
    }
    return (await guarded(value.operationId, boundary, async () => {
      const remote = await executeQuotationContract(transport(value.operationId, async () => { (await reauthorize()); }, boundary), quotation, task.externalId!,
        existing ? { operation: "edit", quoteId: existing.external_id } : { operation: "create" });
      if (boundary.error) throw boundary.error;
      if (remote.dealTransition === "requires-reconciliation") throw new CommercialPersistenceError(503);
      return (await safe(async () => (await db.transaction(async () => {
        const user = (await reauthorize()), normalized = { ...quotation, items: remote.normalizedItems };
        (await checkProducts(normalized));
        const totals = calculateQuotation(normalized, "percentage"), { items, ...header } = normalized;
        let quoteId: string;
        if (existing) {
          const changed = (await db.prepare("UPDATE crm_quotations SET quote_number=?,header_json=?,totals_json=?,calculation_policy='percentage-only-v2',version=version+1,remote_modified_at=?,updated_at=? WHERE id=? AND version=?")
            .run(remote.quoteNumber, JSON.stringify(header), JSON.stringify(totals), remote.modifiedTime, at(), existing.id, existing.version));
          if (changed.changes !== 1) throw new CommercialPersistenceError(409); quoteId = existing.id;
          (await db.prepare("DELETE FROM proposal_items WHERE quotation_id=? AND task_id=?").run(quoteId, task.id));
        } else {
          quoteId = String((await db.prepare("INSERT INTO crm_quotations(task_id,external_id,quote_number,header_json,totals_json,calculation_policy,remote_modified_at,created_at,updated_at) VALUES(?,?,?,?,?,'percentage-only-v2',?,?,?)")
            .run(task.id, remote.quoteId, remote.quoteNumber, JSON.stringify(header), JSON.stringify(totals), remote.modifiedTime, at(), at())).lastInsertRowid);
        }
        const saveLine = db.prepare("INSERT INTO proposal_items(quotation_id,task_id,position,product_id,product_name,product_description,uom,quantity,service_charge,item_discount,total) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
        for (const [index, item] of items.entries()) {
          await saveLine.run(quoteId, task.id, index, item.productId, item.productName, item.description, item.uom, item.quantity, item.unitPrice, item.itemDiscount, totals.lineTotals[index]!);
        }
        const transition = buildQuotedDealTransition(task.externalId!, remote.quoteNumber);
        const updated = (await db.prepare(`UPDATE tasks SET quote_id=?,quote_number=?,service_charge=?,notes=?,version=version+1,updated_at=?${edit ? "" : ",status='Proposal/Price Quote',quote_deal_number=?"} WHERE id=? AND version=?`)
          .run(remote.quoteId, remote.quoteNumber, totals.subtotal, normalized.notes, remote.modifiedTime,
            ...(edit ? [] : [transition.localQuoteDealNumber]), task.id, task.version));
        if (updated.changes !== 1) throw new CommercialPersistenceError(409);
        return (await finish(user, task.id, kind, { operationId: value.operationId, taskId: task.id, quoteId, version: task.version + 1, quoteVersion: (existing?.version ?? 0) + 1 }, quoteId,
          ["quotation_header", "proposal_items", "service_charge", ...(edit ? [] : ["status", "quote_deal_number"])]));
      }).immediate())));
    }));
  }
  async function quotationCapabilities(token: Token, taskId: unknown): Promise<QuotationCapabilities> {
    return (await safe(async () => (await db.transaction(async () => { const user = (await current(token)), task = (await parent(user, taskId)), row = (await quoteRow(task.id));
      let bound = true;
      if (production) { try { await assertZohoActorBinding(db, user, production.organizationId); } catch { bound = false; } }
      const canWrite = bound && (!row?.native || !!production) && user.externalUserId !== null && task.assignedTo === user.externalUserId && user.permissions.some((key) => ["leads.manage", "leads.manage.agents"].includes(key));
      const blocked = (await busy(task.id)), discountBlocked = row ? row.calculation_policy !== "percentage-only-v2" || (!!production && !row.native) : false;
      return { taskVersion: task.version, quoteVersion: row?.version ?? null, canCreate: canWrite && !row && !task.quoteNumber && !task.quoteExternalId && !blocked,
        canEdit: canWrite && !!row && !discountBlocked && !blocked, discountedEditBlocked: discountBlocked,
        integrationAvailable: !!production && !!options.transport,
        ...(production || row?.native ? { persistence: "zoho" as const, pdfAvailable: !!row?.issuer_company && !!row.issuer_salesperson } : {}),
        ...(blocked ? { blockedOperationId: blocked.operation_id } : {}) };
    })())));
  }
  return { listProducts, getProduct, createProduct, listQuotations, listQuotationCandidates, quotationCapabilities,
    getQuotation: async (token: Token, taskId: unknown) => (await safe(async () => (await db.transaction(async () => (await detail((await current(token)), taskId)))()))),
    getCapabilities: async (token: Token) => (await safe(async () => { const user = (await current(token)); return { integrationAvailable: !!options.transport,
      canCreateProduct: user.permissions.includes("items.write"), canCreateQuotation: user.permissions.some((key) => ["leads.manage", "leads.manage.agents"].includes(key)) && user.externalUserId !== null }; })),
    createQuotation: async (token: Token, taskId: unknown, input: unknown) => (await mutateQuotation(token, taskId, input, false)),
    updateQuotation: async (token: Token, taskId: unknown, input: unknown) => (await mutateQuotation(token, taskId, input, true)) };
}
