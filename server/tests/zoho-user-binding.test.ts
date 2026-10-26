import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { readVerifiedZohoAppUser, ZohoAppUserError } from "../src/integrations/zoho/app-users.js";
import { assertZohoActorBinding, ZohoUserBindingError } from "../src/integrations/zoho/user-binding.js";
import { bindZohoApplicationUser, ZohoUserBindingOperatorError } from "../src/operations/zoho-user-binding.js";
import { validateRuntimeConfiguration } from "../src/runtime/configuration.js";
import type { MysqlDatabase } from "../src/crm/db/mysql/database.js";

const row = { id: "4001", Name: "TEST ONLY operator", Email: "Operator@Example.invalid", user_status: "active", Modified_Time: "2026-10-19T08:00:00+04:00" };
const remote = { externalId: row.id, name: row.Name, email: row.Email.toLowerCase(), status: "active" as const, modifiedTime: row.Modified_Time };
test("OFFLINE custom-user read is one exact v8 GET and requires the same active record", async () => {
  let calls = 0;
  const value = await readVerifiedZohoAppUser({ request: async request => {
    calls++; assert.deepEqual(request, { apiVersion: "v8", method: "GET", path: "/VZ_app_users/4001?fields=Name,Modified_Time,Email,user_status" });
    return { status: 200, body: { data: [row] } };
  } }, row.id);
  assert.equal(calls, 1); assert.deepEqual(value, remote); assert.ok(Object.isFrozen(value));
});
test("OFFLINE custom-user read refuses standard users, status coercion, mismatched IDs and unbounded/error envelopes", async () => {
  for (const body of [{ users: [row] }, { data: [] }, { data: [row, row] }, { data: [row], info: {} },
    ...[true, 1, "enabled", "Active", "inactive", undefined].map(user_status => ({ data: [{ ...row, user_status }] })),
    { data: [{ ...row, id: "4002" }] }, { data: [{ ...row, Email: "invalid" }] }, { data: [{ ...row, Modified_Time: "today" }] }]) {
    await assert.rejects(readVerifiedZohoAppUser({ request: async () => ({ status: 200, body }) }, row.id), ZohoAppUserError);
  }
  let sent = false;
  await assert.rejects(readVerifiedZohoAppUser({ request: async () => { sent = true; throw Error("private provider detail"); } }, "../users"), ZohoAppUserError);
  assert.equal(sent, false);
  await assert.rejects(readVerifiedZohoAppUser({ request: async () => { throw Error("private provider detail"); } }, row.id), error => error instanceof ZohoAppUserError && !error.message.includes("private"));
});

test("OFFLINE transaction-bound actor verification refuses cross-org, stale identity/email and inactive local users", async () => {
  const valid = { organizationId: "3001", moduleName: "VZ_app_users", externalId: "4001", boundEmail: "operator@example.invalid",
    currentExternalId: "4001", currentEmail: "Operator@example.invalid", status: "active" };
  const database = (value: unknown, blockedDirectory = false) => ({ prepare: (sql: string) => ({ get: async (...ids: string[]) => {
    if (sql.startsWith("SELECT 1 FROM crm_zoho_sync_records WHERE organization_id=?")) {
      assert.match(sql, /module_api_name='VZ_app_users'.*state!='active'/);
      assert.deepEqual(ids, ["3001", "4001"]); return blockedDirectory ? { 1: 1 } : undefined;
    }
    assert.match(sql, /FROM crm_zoho_user_bindings b JOIN users/); assert.deepEqual(ids, ["1"]); return value;
  } }) }) as unknown as MysqlDatabase;
  const user = { localUserId: "1", externalUserId: "4001" };
  await assertZohoActorBinding(database(valid), user, "3001");
  for (const invalid of [undefined, ...[{ organizationId: "3002" }, { moduleName: "users" }, { externalId: "4002" },
    { currentExternalId: "4002" }, { currentEmail: "other@example.invalid" }, { status: "inactive" }].map(change => ({ ...valid, ...change }))]) {
    await assert.rejects(assertZohoActorBinding(database(invalid), user, "3001"), ZohoUserBindingError);
  }
  await assert.rejects(assertZohoActorBinding(database(valid), { ...user, externalUserId: null }, "3001"), ZohoUserBindingError);
  await assert.rejects(assertZohoActorBinding(database(valid, true), user, "3001"), ZohoUserBindingError,
    "a previously verified actor loses outbound eligibility when the synchronized directory records a deletion or conflict");
});

const serverUuid = "550e8400-e29b-41d4-a716-446655440000";
const config = validateRuntimeConfiguration({ version: 2,
  mysql: { provider: "mysql", environment: "production", host: "127.0.0.1", port: 3308, database: "synthetic_binding", user: "synthetic_app", password: "synthetic-private-driver-value" },
  approval: { approved: true, reference: "synthetic review", provisioningReference: "synthetic provision", serverUuid },
  issuer: { company: "VOLTRONIX CONTRACTING LLC", salesperson: "TEST ONLY" } },
{ environment: "production", host: "127.0.0.1", port: 18620, appOrigin: "https://synthetic.invalid" });
const request = () => ({ version: 1, requestId: randomUUID(), reference: "synthetic operator review",
  target: { database: config.mysql.database, serverUuid, organizationId: "3001" }, actorUserId: "1", localUserId: "1", externalUserId: "4001", expectedVersion: 1 });
function fixture(options: { grants?: string[]; existing?: boolean; wrongRemoteEmail?: boolean; race?: boolean; failAudit?: boolean; closeFailure?: boolean } = {}) {
  const statements: { sql: string; values: unknown[] }[] = [];
  let closes = 0, reads = 0, writes = 0, transactions = 0, commits = 0, rollbacks = 0;
  const database = { prepare(sql: string) { return {
    get: async () => sql.includes("CAST(id AS CHAR)") ? { id: "1", email: "operator@example.invalid", externalId: null, status: "active", version: options.race && reads ? 2 : 1 } : { status: "active" },
    all: async () => sql.includes("FROM permissions") ? (options.grants ?? ["users.write", "permissions.manage"]).map(permissionKey => ({ permissionKey })) : options.existing ? [{ local_user_id: "1" }] : [],
    run: async (...values: unknown[]) => { writes++; statements.push({ sql, values }); if (options.failAudit && sql.includes("INSERT INTO crm_zoho_user_binding_audit")) throw Error("private SQL detail"); return { changes: 1, lastInsertRowid: 1n }; },
  }; }, transaction(work: () => Promise<unknown>) {
    const invoke = async () => { transactions++; try { const result = await work(); commits++; return result; } catch (error) { rollbacks++; throw error; } };
    return Object.assign(invoke, { immediate: invoke });
  } };
  const create = (() => ({ database, close: async () => { closes++; if (options.closeFailure) throw Error("private close detail"); } })) as unknown as NonNullable<Parameters<typeof bindZohoApplicationUser>[4]>;
  const session = { organization: { id: "3001", environment: "production" as const }, readAppUser: async () => { reads++; return { ...remote, ...(options.wrongRemoteEmail ? { email: "other@example.invalid" } : {}) }; } };
  return { create, session, statements, counts: () => ({ closes, reads, writes, transactions, commits, rollbacks }) };
}
test("OFFLINE binding check verifies local authority then exact custom user without writes", async () => {
  const f = fixture(); assert.deepEqual(await bindZohoApplicationUser(config, request(), f.session, "check", f.create),
    { status: "VERIFIED_CUSTOM_USER_READY", databaseWrites: 0, remoteWrites: 0 });
  assert.deepEqual(f.counts(), { closes: 1, reads: 1, writes: 0, transactions: 2, commits: 2, rollbacks: 0 });
});
test("OFFLINE binding refuses invalid targets before construction, insufficient authority before remote read, and email/version races before writes", async () => {
  const bad = request(); bad.target.organizationId = "3002";
  await assert.rejects(bindZohoApplicationUser(config, bad, fixture().session, "apply", () => assert.fail()), error => error instanceof ZohoUserBindingOperatorError && error.code === "CONFIGURATION");
  const sandbox = { ...fixture().session, organization: { id: "3001", environment: "sandbox" as const } };
  await assert.rejects(bindZohoApplicationUser(config, request(), sandbox, "apply", () => assert.fail()), error => error instanceof ZohoUserBindingOperatorError && error.code === "CONFIGURATION");
  for (const options of [{ grants: ["users.write"] }, { existing: true }, { wrongRemoteEmail: true }, { race: true }]) {
    const f = fixture(options); await assert.rejects(bindZohoApplicationUser(config, request(), f.session, "apply", f.create), ZohoUserBindingOperatorError);
    assert.equal(f.counts().writes, 0); assert.equal(f.counts().closes, 1);
    if (options.grants || options.existing) assert.equal(f.counts().reads, 0);
  }
});
test("OFFLINE binding apply atomically pins identity, immutable verification audit and revokes current sessions", async () => {
  const f = fixture(); assert.deepEqual(await bindZohoApplicationUser(config, request(), f.session, "apply", f.create),
    { status: "VERIFIED_CUSTOM_USER_BOUND", version: 2, remoteWrites: 0, sessionsRevoked: true });
  assert.equal(f.counts().writes, 4); assert.equal(f.counts().commits, 2); assert.equal(f.counts().reads, 1); assert.equal(f.counts().closes, 1);
  assert.match(f.statements[0]!.sql, /UPDATE users SET user_id=\?,version=version\+1/);
  assert.match(f.statements[1]!.sql, /INSERT INTO crm_zoho_user_bindings/);
  assert.match(f.statements[2]!.sql, /INSERT INTO crm_zoho_user_binding_audit/);
  assert.match(String(f.statements[2]!.values[6]), /"module":"VZ_app_users"/);
  assert.deepEqual(f.statements[3], { sql: "DELETE FROM crm_sessions WHERE user_id=?", values: ["1"] });
});
test("OFFLINE failed binding audit rolls back and redacts, close failure cannot report successful apply", async () => {
  for (const options of [{ failAudit: true }, { closeFailure: true }]) {
    const f = fixture(options);
    await assert.rejects(bindZohoApplicationUser(config, request(), f.session, "apply", f.create), error => error instanceof ZohoUserBindingOperatorError && error.code === "DATABASE" && !error.message.includes("private"));
    assert.equal(f.counts().reads, 1);
    if (options.failAudit) { assert.equal(f.counts().rollbacks, 1); assert.equal(f.counts().writes, 3); }
  }
});
