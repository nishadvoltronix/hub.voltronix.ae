import { createHash } from "node:crypto";
import { z } from "zod";
import type { CrmWriteCapabilities, LocalPersistenceResult } from "@voltronix/crm-contracts";
import type { MysqlDatabase } from "../db/mysql/database.js";
import { createAuthService } from "../auth/service.js";
import type { CommercialMutationResult } from "../commercial/persistence-contracts.js";
import { singleLine, multiLine } from "../commercial/validation.js";
import { guardedLocal, LocalWorkflowError } from "./service.js";

type Token = string | null | undefined;
type ProductResult = CommercialMutationResult & LocalPersistenceResult;
const productInput = z.object({ operationId: z.uuid(), name: singleLine(200).min(1), description: multiLine(10_000) }).strict();
const savedResult = z.object({ operationId: z.uuid(), productId: z.string().regex(/^9[0-9]{39}$/),
  version: z.literal(1), persistence: z.literal("local-mysql") }).strict();
// Existing numeric product wire namespace, explicitly local in its journal/result.
// This is not a fabricated Zoho acknowledgement or historical ownership mapping.
const productId = (uuid: string) => "9" + BigInt("0x" + uuid.replaceAll("-", "")).toString().padStart(39, "0");
type Operation = { actor: string; taskId: string | null; kind: string; request_hash: string; state: string;
  remote_effect_possible: number; remote_references: string; result_json: string | null };

/** Native MySQL implementation of the existing local product transaction.
 * No transport, profile reads, schema changes or startup connections. */
export function createLocalMysqlWrites(db: MysqlDatabase, options: { now?: () => number } = {}) {
  const auth = createAuthService(db, options), now = options.now ?? Date.now;
  async function current(token: Token) {
    const user = await auth.authenticate(token); if (!user) throw new LocalWorkflowError(401); return user;
  }
  async function capabilities(token: Token): Promise<CrmWriteCapabilities> {
    return db.transaction(async (): Promise<CrmWriteCapabilities> => {
      const user = await current(token);
      return { persistence: "local-mysql", productCreate: user.permissions.includes("items.write"),
        leadNotes: user.permissions.some(key => ["leads.manage", "leads.manage.agents"].includes(key)),
        localWorkflow: true, dealCreate: user.permissions.includes("deals.manage"), integrationAvailable: false };
    })();
  }
  async function createProduct(token: Token, input: unknown): Promise<ProductResult> {
    return db.transaction(async () => {
      const user = await current(token); if (!user.permissions.includes("items.write")) throw new LocalWorkflowError(403);
      const parsed = productInput.safeParse(input); if (!parsed.success) throw new LocalWorkflowError(400);
      const value = parsed.data, kind = "product.create";
      const requestHash = createHash("sha256").update(JSON.stringify({ persistence: "local-mysql", kind, input: value })).digest("hex");
      if (await db.prepare("SELECT 1 FROM crm_lead_operations WHERE operation_id=? UNION ALL SELECT 1 FROM crm_local_operations WHERE operation_id=?").get(value.operationId, value.operationId)) throw new LocalWorkflowError(409);
      const old = await db.prepare(`SELECT CAST(actor_user_id AS CHAR) actor,CAST(task_id AS CHAR) taskId,kind,request_hash,state,
        remote_effect_possible,remote_references,result_json FROM crm_commercial_operations WHERE operation_id=?`).get(value.operationId) as Operation | undefined;
      if (old) {
        if (old.actor !== user.localUserId || old.taskId !== null || old.kind !== kind || old.request_hash !== requestHash || old.state !== "completed"
          || old.remote_effect_possible !== 0 || old.remote_references !== "{}" || !old.result_json) throw new LocalWorkflowError(409);
        let result: z.infer<typeof savedResult>;
        try { result = savedResult.parse(JSON.parse(old.result_json)); } catch { throw new LocalWorkflowError(409); }
        if (result.operationId !== value.operationId || result.productId !== productId(value.operationId)) throw new LocalWorkflowError(409);
        return result;
      }
      if (await db.prepare("SELECT 1 FROM crm_commercial_operations WHERE actor_user_id=? AND kind='product.create' AND state!='completed'").get(user.localUserId)) throw new LocalWorkflowError(409);
      const id = productId(value.operationId), timestamp = new Date(now()).toISOString();
      if (await db.prepare("SELECT 1 FROM products WHERE product_id=?").get(id)) throw new LocalWorkflowError(409);
      await db.prepare("INSERT INTO crm_commercial_operations(operation_id,actor_user_id,kind,request_hash,state,created_at,updated_at) VALUES(?,?,?,?,'inflight',?,?)")
        .run(value.operationId, user.localUserId, kind, requestHash, timestamp, timestamp);
      await db.prepare("INSERT INTO products(product_id,product_name,description,created_at,updated_at) VALUES(?,?,?,?,?)")
        .run(id, value.name, value.description, timestamp, timestamp);
      const result: ProductResult = { operationId: value.operationId, productId: id, version: 1, persistence: "local-mysql" };
      await db.prepare("INSERT INTO crm_commercial_audit_events(actor_user_id,operation_id,action,target_id,changed_fields,occurred_at) VALUES(?,?,?,?,?,?)")
        .run(user.localUserId, value.operationId, kind, id, JSON.stringify(["product_name", "description"]), timestamp);
      if ((await db.prepare("UPDATE crm_commercial_operations SET state='completed',result_json=?,updated_at=? WHERE operation_id=? AND state='inflight'")
        .run(JSON.stringify(result), timestamp, value.operationId)).changes !== 1) throw new LocalWorkflowError(409);
      return result;
    }).immediate();
  }
  return { capabilities: guardedLocal(capabilities), createProduct: guardedLocal(createProduct) };
}
