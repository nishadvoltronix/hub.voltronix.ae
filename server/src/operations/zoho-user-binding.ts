import { z } from "zod";
import { createCrmRuntime } from "../runtime/composition.js";
import { assertValidatedRuntimeConfiguration, type RuntimeConfiguration } from "../runtime/configuration.js";
import type { VerifiedZohoAppUser } from "../integrations/zoho/app-users.js";

const localId = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => BigInt(value) <= 9_223_372_036_854_775_807n);
const externalId = z.string().regex(/^[1-9][0-9]{0,29}$/);
const requestSchema = z.object({ version: z.literal(1), requestId: z.uuid(),
  reference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$/),
  target: z.object({ database: z.string(), serverUuid: z.string(), organizationId: externalId }).strict(),
  actorUserId: localId, localUserId: localId, externalUserId: externalId,
  expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1),
}).strict();
export const zohoUserBindingRequestPath = ".local-data/operators/zoho-user-binding.json";
export class ZohoUserBindingOperatorError extends Error {
  constructor(readonly code: "CONFIGURATION" | "LOCAL_USER" | "CONFLICT" | "REMOTE_USER" | "DATABASE") {
    super("Custom Zoho application-user binding refused; no identity fallback or automatic retry was attempted.");
  }
}
export interface ZohoAppUserSession {
  organization: { id: string; environment: "production" | "sandbox" };
  readAppUser(id: string): Promise<VerifiedZohoAppUser>;
}
export function validateZohoBindingRequest(config: RuntimeConfiguration, organizationId: string, input: unknown) {
  try {
    assertValidatedRuntimeConfiguration(config);
    const value = requestSchema.parse(input);
    if (value.target.database !== config.mysql.database || value.target.serverUuid !== config.serverUuid
      || value.target.organizationId !== organizationId) throw new Error();
    return value;
  } catch { throw new ZohoUserBindingOperatorError("CONFIGURATION"); }
}
type Runtime = Pick<ReturnType<typeof createCrmRuntime>, "database" | "close">;
type LocalUser = { id: string; email: string; externalId: string | null; status: string; version: number };
/** Remote operation is GET only. A separate private operator request authorizes
 * local binding; runtime startup never binds a user or discovers one by name. */
export async function bindZohoApplicationUser(config: RuntimeConfiguration, input: unknown, session: ZohoAppUserSession,
  mode: "check" | "apply", createRuntime: (config: RuntimeConfiguration) => Runtime = createCrmRuntime) {
  const request = validateZohoBindingRequest(config, session.organization.id, input);
  if (session.organization.environment !== "production" || !["check", "apply"].includes(mode)) throw new ZohoUserBindingOperatorError("CONFIGURATION");
  let runtime: Runtime | undefined;
  try {
    runtime = createRuntime(config);
    const db = runtime.database;
    const inspect = async () => {
      const actor = await db.prepare("SELECT status FROM users WHERE id=?").get(request.actorUserId) as { status: string } | undefined;
      const grants = await db.prepare(`SELECT p.\`key\` permissionKey FROM permissions p JOIN admin_user_permissions a
        ON a.permission_id=p.id WHERE a.admin_user_id=?`).all(request.actorUserId) as { permissionKey: string }[];
      if (actor?.status !== "active" || !["users.write", "permissions.manage"].every(key => grants.some(grant => grant.permissionKey === key))) throw new ZohoUserBindingOperatorError("LOCAL_USER");
      const local = await db.prepare("SELECT CAST(id AS CHAR) id,email,user_id externalId,status,version FROM users WHERE id=?").get(request.localUserId) as LocalUser | undefined;
      if (!local || local.status !== "active") throw new ZohoUserBindingOperatorError("LOCAL_USER");
      if (local.version !== request.expectedVersion || (local.externalId !== null && local.externalId !== request.externalUserId)) throw new ZohoUserBindingOperatorError("CONFLICT");
      const existing = await db.prepare(`SELECT local_user_id FROM crm_zoho_user_bindings WHERE local_user_id=?
        OR (organization_id=? AND external_user_id=?)`).all(request.localUserId, request.target.organizationId, request.externalUserId);
      if (existing.length) throw new ZohoUserBindingOperatorError("CONFLICT");
      return local;
    };
    // Fail local authorization before sending even a read to the provider.
    const initial = await db.transaction(inspect)();
    let remote: VerifiedZohoAppUser;
    try { remote = await session.readAppUser(request.externalUserId); }
    catch { throw new ZohoUserBindingOperatorError("REMOTE_USER"); }
    if (remote.externalId !== request.externalUserId || remote.status !== "active" || remote.email.toLowerCase() !== initial.email.toLowerCase()) throw new ZohoUserBindingOperatorError("REMOTE_USER");
    const verifiedAt = new Date().toISOString();
    const result = await db.transaction(async () => {
      const local = await inspect();
      if (local.email.toLowerCase() !== remote.email.toLowerCase() || Date.now() - Date.parse(verifiedAt) > 30_000) throw new ZohoUserBindingOperatorError("CONFLICT");
      if (mode === "check") return { status: "VERIFIED_CUSTOM_USER_READY" as const, databaseWrites: 0, remoteWrites: 0 };
      const changed = await db.prepare("UPDATE users SET user_id=?,version=version+1,updated_at=? WHERE id=? AND version=?")
        .run(remote.externalId, verifiedAt, request.localUserId, request.expectedVersion);
      if (changed.changes !== 1) throw new ZohoUserBindingOperatorError("CONFLICT");
      await db.prepare(`INSERT INTO crm_zoho_user_bindings(local_user_id,organization_id,module_api_name,external_user_id,
        record_name,record_email,remote_modified_at,verified_at,created_at) VALUES(?,?,'VZ_app_users',?,?,?,?,?,?)`)
        .run(request.localUserId, request.target.organizationId, remote.externalId, remote.name, remote.email, remote.modifiedTime, verifiedAt, verifiedAt);
      await db.prepare(`INSERT INTO crm_zoho_user_binding_audit(request_id,actor_user_id,local_user_id,organization_id,external_user_id,
        action,reference,verification_json,occurred_at) VALUES(?,?,?,?,?,'users.zoho.bind',?,?,?)`)
        .run(request.requestId, request.actorUserId, request.localUserId, request.target.organizationId, remote.externalId,
          request.reference, JSON.stringify({ module: "VZ_app_users", status: remote.status, modifiedTime: remote.modifiedTime, emailMatched: true }), verifiedAt);
      await db.prepare("DELETE FROM crm_sessions WHERE user_id=?").run(request.localUserId);
      return { status: "VERIFIED_CUSTOM_USER_BOUND" as const, version: request.expectedVersion + 1, remoteWrites: 0, sessionsRevoked: true };
    }).immediate();
    await runtime.close(); return result;
  } catch (error) {
    try { await runtime?.close(); } catch { /* safe refusal retained */ }
    if (error instanceof ZohoUserBindingOperatorError) throw error;
    throw new ZohoUserBindingOperatorError("DATABASE");
  }
}
