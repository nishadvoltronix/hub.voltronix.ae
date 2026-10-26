import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { compare } from "bcryptjs";
import { administratorPermissions, bootstrapNativeAdministrator, NativeAdminBootstrapError } from "../src/runtime/bootstrap-admin.js";
import { validateRuntimeConfiguration } from "../src/runtime/configuration.js";
import { mysqlExpectedTables } from "../src/crm/db/mysql/schema.js";

const serverUuid = "550e8400-e29b-41d4-a716-446655440000";
const config = validateRuntimeConfiguration({ version: 2,
  mysql: { provider: "mysql", environment: "production", host: "127.0.0.1", port: 3308, database: "synthetic_bootstrap", user: "synthetic_app", password: "synthetic-private-driver-value" },
  approval: { approved: true, reference: "synthetic review", provisioningReference: "synthetic provision", serverUuid },
  issuer: { company: "VOLTRONIX CONTRACTING LLC", salesperson: "TEST ONLY" } },
{ environment: "production", host: "127.0.0.1", port: 18620, appOrigin: "https://synthetic.invalid" });
const request = () => ({ version: 1, requestId: randomUUID(), reference: "synthetic operator review", target: { database: config.mysql.database, serverUuid },
  administrator: { name: "TEST ONLY administrator", email: "bootstrap@example.invalid", password: "synthetic-private-login-value" } });
function fixture(nonempty = "", failAfter = 0) {
  const statements: { sql: string; values: readonly unknown[] }[] = [];
  let closes = 0, creations = 0, commits = 0, rollbacks = 0, writes = 0;
  const empty = () => mysqlExpectedTables.filter(table => table !== "crm_app_lock").map(tableName => ({ tableName, total: tableName === nonempty ? 1 : 0 }));
  const database = {
    prepare(sql: string) { assert.match(sql, /^SELECT /); return { all: async () => { statements.push({ sql, values: [] }); return empty(); } }; },
    async authTransaction(work: (connection: { execute(sql: string, values?: readonly unknown[]): Promise<unknown[]> }) => Promise<unknown>) {
      try {
        const result = await work({ execute: async (sql, values = []) => {
          statements.push({ sql, values });
          if (sql.startsWith("SELECT ")) return [empty(), []];
          if (++writes === failAfter) throw Error("synthetic private driver detail");
          return [{ affectedRows: 1, warningStatus: 0, insertId: writes }, []];
        } }); commits++; return result;
      } catch (error) { rollbacks++; throw error; }
    },
  };
  const create = (() => { creations++; return { database, close: async () => { closes++; } }; }) as unknown as NonNullable<Parameters<typeof bootstrapNativeAdministrator>[3]>;
  return { create, statements, counts: () => ({ closes, creations, commits, rollbacks, writes }) };
}
test("OFFLINE first-admin check uses SELECT only, closes and does not seed or authenticate", async () => {
  const f = fixture();
  assert.deepEqual(await bootstrapNativeAdministrator(config, request(), "check", f.create), { status: "EMPTY_NATIVE_READY", databaseWrites: 0 });
  assert.equal(f.statements.length, 1); assert.equal(f.counts().writes, 0); assert.equal(f.counts().commits, 0); assert.equal(f.counts().closes, 1);
});
test("OFFLINE first-admin rejects wrong target, weak password and unsupported external identity before opening", async () => {
  for (const change of [
    (r: ReturnType<typeof request>) => { r.target.serverUuid = "other"; },
    (r: ReturnType<typeof request>) => { r.target.database = "another_schema"; },
    (r: ReturnType<typeof request>) => { r.administrator.password = "short"; },
    (r: ReturnType<typeof request>) => { Object.assign(r.administrator, { externalUserId: "unverified" }); },
  ]) {
    const input = request(); change(input); const f = fixture();
    await assert.rejects(bootstrapNativeAdministrator(config, input, "apply", f.create), error => error instanceof NativeAdminBootstrapError && error.code === "CONFIGURATION");
    assert.equal(f.counts().creations, 0);
  }
});
test("OFFLINE first-admin refuses any existing application table content before inserts", async () => {
  for (const table of ["users", "permissions", "products", "crm_audit_events", "crm_sessions"]) {
    for (const mode of ["check", "apply"] as const) {
      const f = fixture(table);
      await assert.rejects(bootstrapNativeAdministrator(config, request(), mode, f.create), error => error instanceof NativeAdminBootstrapError && error.code === "NOT_EMPTY");
      assert.equal(f.counts().writes, 0); assert.equal(f.counts().closes, 1);
    }
  }
});
test("OFFLINE first-admin hashes password, seeds canonical permissions, omits restrictive agent grant and audits atomically", async () => {
  const input = request(), f = fixture();
  const result = await bootstrapNativeAdministrator(config, input, "apply", f.create);
  assert.equal(result.status, "ADMINISTRATOR_CREATED"); assert.equal(f.counts().commits, 1); assert.equal(f.counts().closes, 1);
  const user = f.statements.find(value => value.sql.startsWith("INSERT INTO users"))!;
  assert.notEqual(user.values[2], input.administrator.password); assert.ok(await compare(input.administrator.password, String(user.values[2])));
  const permissions = f.statements.filter(value => value.sql.startsWith("INSERT INTO permissions"));
  assert.equal(permissions.length, 21);
  const grantKeys = f.statements.filter(value => value.sql.startsWith("INSERT INTO admin_user_permissions")).map(grant => {
    const before = f.statements.slice(0, f.statements.indexOf(grant)); return before.findLast(value => value.sql.startsWith("INSERT INTO permissions"))!.values[0];
  });
  assert.deepEqual(grantKeys, administratorPermissions); assert.equal(grantKeys.includes("leads.manage.agents"), false);
  assert.equal(f.statements.filter(value => value.sql.includes("INSERT INTO crm_audit_events")).length, 1);
  assert.ok(f.statements.every(value => !/CREATE |ALTER |DROP |GRANT |DELETE |UPDATE /u.test(value.sql)));
});
test("OFFLINE first-admin database failure rolls back, closes, redacts and never retries", async () => {
  const f = fixture("", 5);
  await assert.rejects(bootstrapNativeAdministrator(config, request(), "apply", f.create), error => {
    assert.ok(error instanceof NativeAdminBootstrapError); assert.equal(error.code, "DATABASE"); assert.doesNotMatch(error.message, /private driver/); return true;
  });
  assert.equal(f.counts().commits, 0); assert.equal(f.counts().rollbacks, 1); assert.equal(f.counts().creations, 1); assert.equal(f.counts().closes, 1);
});
test("OFFLINE first-admin close failure cannot report success or retry a completed commit", async () => {
  const f = fixture();
  await assert.rejects(bootstrapNativeAdministrator(config, request(), "apply", configuration => {
    const runtime = f.create(configuration);
    return { ...runtime, close: async () => { await runtime.close(); throw Error("synthetic private close detail"); } };
  }), error => error instanceof NativeAdminBootstrapError && error.code === "DATABASE" && !error.message.includes("private close"));
  assert.equal(f.counts().commits, 1); assert.equal(f.counts().creations, 1);
});
