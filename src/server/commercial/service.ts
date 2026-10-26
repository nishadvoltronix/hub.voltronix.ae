import { PRODUCT_SORTS, QUOTATION_SORTS, productListOrder, quotationListOrder } from "./list-order";
import { createHash } from "node:crypto";
import { MysqlDatabaseError, type MysqlDatabase as Database } from "../db/mysql/database";
import { z } from "zod";
import { createAuthService, type AuthUser } from "../auth/service";
import { buildProductPayload } from "./products";
import { assertQuotationMode, calculateQuotation, calculateSavedQuotation, parseSavedQuotationInput, buildQuotedDealTransition, parseQuotationInput, type QuotationInput } from "./quotations";
import { executeQuotationContract } from "./quote-contract";
import { type CommercialTransport, parseWriteId, requestContract } from "./transport";
import { CommercialError, externalIdSchema, singleLine, multiLine, exactSearchPath } from "./validation";
import type { CommercialMutationResult, CommercialPage, ProductRecord, QuotationCandidate, QuotationCapabilities, QuotationDetail, QuotationSummary } from "./persistence-contracts";

type Token = string | null | undefined;
type Kind = "product.create" | "quote.create" | "quote.edit";
type Parent = { id: string; externalId: string | null; assignedTo: string | null; version: number; quoteNumber: string | null; quoteExternalId: string | null };
type QuoteRow = { id: string; external_id: string; quote_number: string; header_json: string; totals_json: string;
  calculation_policy: string; version: number; remote_modified_at: string; created_at: string; updated_at: string };
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
const productProjection = "product_id externalId,product_name name,description,unit_price unitPrice,version,created_at createdAt,updated_at updatedAt";
function parse<T>(schema: z.ZodType<T>, input: unknown): T { const value = schema.safeParse(input); if (!value.success) throw new CommercialPersistenceError(400); return value.data; }
function escaped(value: string) { return `%${value.replace(/[!%_]/g, "!$&")}%`; }

export function createCommercialService(db: Database, options: { transport?: CommercialTransport; now?: () => number } = {}) {
  const now = options.now ?? Date.now, auth = createAuthService(db, { now }), at = () => new Date(now()).toISOString();
  async function safe<T>(work: () => Promise<T>): Promise<T> { try { return (await work()); } catch (error) {
    if (error instanceof MysqlDatabaseError && error.code === "MYSQL_CONFLICT") throw new CommercialPersistenceError(409);
    if (error instanceof CommercialPersistenceError) throw error;
    if (error instanceof CommercialError && (error.status === 400 || error.status === 409)) throw new CommercialPersistenceError(error.status);
    throw new CommercialPersistenceError(503);
  } }
  async function current(token: Token): Promise<AuthUser> { const user = (await auth.authenticate(token)); if (!user) throw new CommercialPersistenceError(401); return user; }
  async function productActor(token: Token, write = false) {
    const user = (await current(token)), permitted = write ? user.permissions.includes("items.write") :
      user.permissions.some((key) => ["items.view", "items.write", "leads.manage", "leads.manage.agents"].includes(key));
    if (!permitted) throw new CommercialPersistenceError(403); return user;
  }
  async function quoteActor(token: Token, write = false) {
    const user = (await current(token));
    if (!user.permissions.some((key) => (write ? ["leads.manage", "leads.manage.agents"] : ["leads.view", "leads.manage", "leads.manage.agents"]).includes(key))) throw new CommercialPersistenceError(403);
    return user;
  }
  async function parent(user: AuthUser, id: unknown, write = false): Promise<Parent> {
    if (!localId.safeParse(id).success) throw new CommercialPersistenceError(404);
    const row = (await db.prepare("SELECT CAST(id AS CHAR) id,zoho_crm_id externalId,assigned_to assignedTo,version,quote_number quoteNumber,quote_id quoteExternalId FROM tasks WHERE id=?").get(id)) as Parent | undefined;
    if (!row) throw new CommercialPersistenceError(404);
    const owns = user.externalUserId !== null && row.assignedTo === user.externalUserId;
    const canRead = user.permissions.includes("leads.manage.agents") ? owns :
      user.permissions.some((key) => ["leads.view", "leads.manage"].includes(key)) || (await auth.canAccessTask(user, row.id));
    if (!canRead) throw new CommercialPersistenceError(404);
    if (write && (!owns || !user.permissions.some((key) => ["leads.manage", "leads.manage.agents"].includes(key)))) throw new CommercialPersistenceError(403);
    return row;
  }
  async function quoteRow(taskId: string): Promise<QuoteRow | undefined> {
    return (await db.prepare("SELECT CAST(id AS CHAR) id,external_id,quote_number,header_json,totals_json,calculation_policy,version,remote_modified_at,created_at,updated_at FROM crm_quotations WHERE task_id=?").get(taskId)) as QuoteRow | undefined;
  }
  async function quoteInput(row: QuoteRow, taskId: string): Promise<QuotationInput> {
    const items = (await db.prepare(`SELECT product_id productId,product_name productName,product_description description,uom,quantity,
      service_charge unitPrice,item_discount itemDiscount FROM proposal_items WHERE quotation_id=? AND task_id=? ORDER BY position`).all(row.id, taskId));
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
    return { id: row.id, taskId: task.id, externalId: row.external_id, quoteNumber: row.quote_number, subject: quotation.subject,
      accountName: snapshot.accountName, dealName: snapshot.dealName, assignedName: snapshot.assignedName, subtotal: totals.subtotal, grandTotal: totals.grandTotal,
      dealNumber: snapshot.dealNumber, dealStatus: snapshot.status, ...(snapshot.jobStatus === undefined ? {} : { jobStatus: snapshot.jobStatus }),
      version: row.version, taskVersion: task.version, createdAt: row.created_at, updatedAt: row.updated_at, remoteModifiedAt: row.remote_modified_at,
      calculationPolicy: row.calculation_policy as QuotationDetail["calculationPolicy"], quotation, totals, task: snapshot };
  }
  function scope(user: AuthUser, forceOwn = false) {
    return forceOwn || user.permissions.includes("leads.manage.agents") ? { clause: "t.assigned_to=?", params: [user.externalUserId ?? ""] } : { clause: "1=1", params: [] };
  }
  async function getProduct(token: Token, id: unknown): Promise<ProductRecord> {
    return (await safe(async () => (await db.transaction(async () => { (await productActor(token)); const key = externalIdSchema.safeParse(id); if (!key.success) throw new CommercialPersistenceError(404);
      const row = (await db.prepare(`SELECT ${productProjection} FROM products WHERE product_id=?`).get(key.data)) as ProductRecord | undefined;
      if (!row) throw new CommercialPersistenceError(404); return row;
    })())));
  }
  async function listProducts(token: Token, input: unknown = {}): Promise<CommercialPage<ProductRecord>> {
    return (await safe(async () => (await db.transaction(async () => { (await productActor(token)); const value = parse(productPaging, input), pattern = escaped(value.query);
      const filter = "CONCAT(product_name,' ',COALESCE(description,'')) COLLATE utf8mb4_0900_as_ci LIKE ? ESCAPE '!'";
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
      const total = ((await db.prepare(`SELECT COUNT(*) n FROM crm_quotations q JOIN tasks t ON t.id=q.task_id LEFT JOIN users u ON u.user_id=t.assigned_to WHERE ${filter}`).get(...params)) as { n: number }).n;
      if (!Number.isSafeInteger(total) || total < 0) throw new CommercialPersistenceError(503);
      const ids = (await db.prepare(`SELECT CAST(t.id AS CHAR) id FROM crm_quotations q JOIN tasks t ON t.id=q.task_id LEFT JOIN users u ON u.user_id=t.assigned_to WHERE ${filter} ORDER BY ${quotationListOrder(value.sort, value.direction, "mysql")} LIMIT ? OFFSET ?`)
        .all(...params, value.pageSize, (value.page - 1) * value.pageSize)) as { id: string }[];
      const items: QuotationSummary[] = [];
      for (const { id } of ids) {
        const { quotation: _quotation, totals: _totals, task: _task, remoteModifiedAt: _remote, calculationPolicy: _policy, ...summary } = await detail(user, id);
        void _quotation; void _totals; void _task; void _remote; void _policy;
        items.push(summary);
      }
      return { items, total, page: value.page, pageSize: value.pageSize };
    })())));
  }
  async function listQuotationCandidates(token: Token, input: unknown = {}): Promise<CommercialPage<QuotationCandidate>> {
    return (await safe(async () => (await db.transaction(async () => { const user = (await quoteActor(token, true)), value = parse(paging, input), own = scope(user, true);
      const filter = `${own.clause} AND COALESCE(t.quote_number,'')='' AND COALESCE(t.quote_id,'')='' AND COALESCE(t.zoho_crm_id,'')!=''
        AND NOT EXISTS(SELECT 1 FROM crm_quotations q WHERE q.task_id=t.id)
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
    const hash = createHash("sha256").update(JSON.stringify(value)).digest("hex"), old = (await operation(operationId));
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
    (await db.prepare("INSERT INTO crm_commercial_audit_events(actor_user_id,task_id,operation_id,action,target_id,changed_fields,occurred_at) VALUES(?,?,?,?,?,?,?)")
      .run(user.localUserId, taskId, result.operationId, kind, targetId, JSON.stringify(fields), at()));
    const change = (await db.prepare("UPDATE crm_commercial_operations SET state='completed',result_json=?,updated_at=? WHERE operation_id=? AND state='inflight'").run(JSON.stringify(result), at(), result.operationId));
    if (change.changes !== 1) throw new CommercialPersistenceError(409); return result;
  }
  function transport(operationId: string, authorize: () => Promise<void>, boundary: { error?: unknown }): CommercialTransport {
    return { async request(request) {
      try { (await safe(authorize)); } catch (error) { boundary.error = error; throw error; }
      if (!options.transport) throw new CommercialPersistenceError(503);
      if (request.method !== "GET") (await safe(async () => {
        const update = (await db.prepare("UPDATE crm_commercial_operations SET remote_effect_possible=1,updated_at=? WHERE operation_id=? AND state='inflight'").run(at(), operationId));
        if (update.changes !== 1) throw new CommercialPersistenceError(409);
      }));
      const response = await options.transport.request(request);
      if (request.method !== "GET" && response.status >= 200 && response.status < 300) {
        let id: string | undefined; try { id = parseWriteId(response.body); } catch { /* caller validates acknowledgement */ }
        const key = request.path === "/Contacts" ? "contactId" : request.path === "/Products" ? "productId" : request.path === "/Quotes" ? "quoteId" : request.path === "/Deals" ? "dealId" : null;
        if (id && key) (await safe(async () => (await db.prepare("UPDATE crm_commercial_operations SET remote_references=json_set(remote_references,?,?),updated_at=? WHERE operation_id=? AND state='inflight'").run(`$.${key}`, id, at(), operationId))));
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
      const reply = await requestContract(port, { apiVersion: "v2.1", method: "POST", path: "/Products", body: buildProductPayload({ name: value.name, description: value.description }) });
      const id = parseWriteId(reply.body);
      return (await safe(async () => (await db.transaction(async () => { const user = (await productActor(token, true));
        if ((await db.prepare("SELECT 1 FROM products WHERE product_id=?").get(id))) throw new CommercialPersistenceError(409);
        (await db.prepare("INSERT INTO products(product_id,product_name,description,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, value.name, value.description, at(), at()));
        return (await finish(user, null, "product.create", { operationId: value.operationId, productId: id, version: 1 }, id, ["product_name", "description"]));
      }).immediate())));
    }));
  }
  async function checkProducts(quote: QuotationInput) {
    for (const item of quote.items) {
      const product = (await db.prepare("SELECT product_name FROM products WHERE product_id=?").get(item.productId)) as { product_name: string } | undefined;
      if (!product || product.product_name !== item.productName) throw new CommercialPersistenceError(400);
    }
  }
  async function mutateQuotation(token: Token, taskId: unknown, input: unknown, edit: boolean): Promise<CommercialMutationResult> {
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
      const canWrite = user.externalUserId !== null && task.assignedTo === user.externalUserId && user.permissions.some((key) => ["leads.manage", "leads.manage.agents"].includes(key));
      const blocked = (await busy(task.id)), discountBlocked = row ? row.calculation_policy !== "percentage-only-v2" : false;
      return { taskVersion: task.version, quoteVersion: row?.version ?? null, canCreate: canWrite && !row && !task.quoteNumber && !task.quoteExternalId && !blocked,
        canEdit: canWrite && !!row && !discountBlocked && !blocked, discountedEditBlocked: discountBlocked,
        integrationAvailable: false, ...(blocked ? { blockedOperationId: blocked.operation_id } : {}) };
    })())));
  }
  return { listProducts, getProduct, createProduct, listQuotations, listQuotationCandidates, quotationCapabilities,
    getQuotation: async (token: Token, taskId: unknown) => (await safe(async () => (await db.transaction(async () => (await detail((await current(token)), taskId)))()))),
    getCapabilities: async (token: Token) => (await safe(async () => { const user = (await current(token)); return { integrationAvailable: !!options.transport,
      canCreateProduct: user.permissions.includes("items.write"), canCreateQuotation: user.permissions.some((key) => ["leads.manage", "leads.manage.agents"].includes(key)) && user.externalUserId !== null }; })),
    createQuotation: async (token: Token, taskId: unknown, input: unknown) => (await mutateQuotation(token, taskId, input, false)),
    updateQuotation: async (token: Token, taskId: unknown, input: unknown) => (await mutateQuotation(token, taskId, input, true)) };
}
