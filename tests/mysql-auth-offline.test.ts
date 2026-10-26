import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { MysqlDatabase } from "../src/server/db/mysql/database";
import type { MysqlWireConnection } from "../src/server/db/mysql/driver";
import { createAuthService } from "../src/server/auth/service";
import { createSettingsService, SettingsError } from "../src/server/settings/service";
import { createQuotationPdfService } from "../src/server/quotation-pdf/service";
import { quotationPdfFixture } from "./helpers/quotation-pdf-fixture";

// Offline adapter contract tests only: the injected connector never opens a socket.
// These synthetic identities are not inserted into any MySQL or SQLite database.
const token = "x".repeat(43), csrf = "y".repeat(43), now = Date.now();
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
const config = { provider: "mysql" as const, environment: "test" as const, host: "127.0.0.1" as const,
  port: 3308, database: "crm_test_offline", user: "isolated_test", password: "synthetic-unused-fixture" };

function fixture(options: { permissions?: string[]; session?: boolean; changes?: number; auditFailure?: boolean; invalidSession?: boolean } = {}) {
  const trace: string[] = [];
  const permissions = options.permissions ?? ["users.write", "permissions.manage"];
  const user = { local_id: "9007199254740993", user_id: "synthetic-external", username: "Synthetic actor",
    email: "fixture@example.invalid", password: "synthetic-hash", status: options.invalidSession ? "inactive" : "active",
    csrf_hash: fingerprint(csrf), password_fingerprint: fingerprint("synthetic-hash"), expires_at: now + 100_000 };
  const target = { id: "2", name: "Synthetic target", email: "target@example.invalid", status: "active",
    externalUserId: null, departmentRole: null, departmentAssignedBy: null, departmentAssignedAt: null, version: 1 };
  const connection: MysqlWireConnection = {
    async execute(sql) {
      await Promise.resolve();
      trace.push(sql);
      if (sql.includes("FROM crm_app_lock")) return [[{ id: 1 }], []];
      if (sql.includes("FROM crm_sessions s JOIN users")) return [options.session === false ? [] : [user], []];
      if (sql.includes("JOIN admin_user_permissions")) return [permissions.map((key) => ({ key })), []];
      if (sql.includes("FROM users WHERE id=?")) return [[target], []];
      if (sql.startsWith("UPDATE users SET status=")) {
        if ((options.changes ?? 1) === 1) { target.status = "inactive"; target.version++; }
        return [{ affectedRows: options.changes ?? 1, insertId: 0 }, []];
      }
      if (sql.startsWith("INSERT INTO crm_audit_events") && options.auditFailure) throw new Error("synthetic private driver detail");
      if (sql.startsWith("INSERT INTO crm_audit_events") || sql.startsWith("DELETE FROM crm_sessions") || sql.startsWith("UPDATE crm_sessions")) {
        return [{ affectedRows: 1, insertId: 0 }, []];
      }
      throw new Error("Unexpected offline fixture statement.");
    },
    async query(sql) { trace.push(sql); return [[], []]; },
    async beginTransaction() { trace.push("BEGIN"); },
    async commit() { trace.push("COMMIT"); },
    async rollback() { trace.push("ROLLBACK"); },
    async end() { trace.push("END"); },
    destroy() { trace.push("DESTROY"); },
  };
  const db = new MysqlDatabase(config, { connect: async () => connection, verify: async () => {} });
  return { db, trace, auth: createAuthService(db, { now: () => now }), settings: createSettingsService(db) };
}

test("offline MySQL auth awaits session/grants and preserves large string identity", async () => {
  const f = fixture();
  const user = await f.auth.authenticate(token);
  assert.equal(user?.localUserId, "9007199254740993");
  assert.deepEqual(user?.permissions, ["users.write", "permissions.manage"]);
  assert.equal(await f.auth.verifySessionCsrf(token, csrf), true);
  assert.equal(await f.auth.verifySessionCsrf(token, "z".repeat(43)), false);
  assert.ok(f.trace.some((sql) => sql.includes("FOR UPDATE")));
  assert.ok(f.trace.includes("COMMIT"));
});

test("offline MySQL auth invalid-session revocation completes before returning", async () => {
  const f = fixture({ invalidSession: true });
  assert.equal(await f.auth.authenticate(token), null);
  assert.ok(f.trace.some((sql) => sql.startsWith("DELETE FROM crm_sessions")));
  assert.equal(await f.auth.verifySessionCsrf(token, csrf), false);
});

test("offline MySQL settings await missing session and live permission denial before validation", async () => {
  const missing = fixture({ session: false });
  await assert.rejects(missing.settings.setUserStatus(token, "invalid", {}),
    (error: unknown) => error instanceof SettingsError && error.status === 401);
  const denied = fixture({ permissions: ["users.write"] });
  await assert.rejects(denied.settings.setUserStatus(token, "invalid", {}),
    (error: unknown) => error instanceof SettingsError && error.status === 403);
  assert.equal(denied.trace.some((sql) => sql.startsWith("UPDATE users")), false);
});

test("offline MySQL settings rejects lost optimistic update without revocation or audit", async () => {
  const f = fixture({ changes: 0 });
  await assert.rejects(f.settings.setUserStatus(token, "2", { version: 1, status: "inactive" }),
    (error: unknown) => error instanceof SettingsError && error.status === 409);
  assert.equal(f.trace.some((sql) => sql.startsWith("INSERT INTO crm_audit_events")), false);
  assert.equal(f.trace.some((sql) => sql.startsWith("DELETE FROM crm_sessions")), false);
  assert.ok(f.trace.includes("ROLLBACK"));
});

test("offline MySQL settings awaits atomic revocation/audit and rejects audit failure safely", async () => {
  const passed = fixture();
  const result = await passed.settings.setUserStatus(token, "2", { version: 1, status: "inactive" });
  assert.equal(result.status, "inactive");
  const revoked = passed.trace.findIndex((sql) => sql.startsWith("DELETE FROM crm_sessions"));
  const audited = passed.trace.findIndex((sql) => sql.startsWith("INSERT INTO crm_audit_events"));
  assert.ok(revoked >= 0 && audited > revoked && passed.trace.lastIndexOf("COMMIT") > audited);
  const failed = fixture({ auditFailure: true });
  await assert.rejects(failed.settings.setUserStatus(token, "2", { version: 1, status: "inactive" }),
    (error: unknown) => error instanceof SettingsError && error.status === 503 && !error.message.includes("driver detail"));
  assert.ok(failed.trace.includes("ROLLBACK"));
  assert.equal(failed.trace.includes("COMMIT"), false);
});

test("offline asynchronous PDF authorization waits for both reads and blocks revoked access", async () => {
  const detail = quotationPdfFixture();
  let reads = 0, rendered = false;
  const service = createQuotationPdfService({ async getQuotation() {
    await Promise.resolve();
    if (++reads === 2) throw new SettingsError(403);
    return detail;
  } }, async (value) => {
    assert.equal(value, detail); rendered = true;
    return { bytes: Buffer.from("isolated synthetic PDF bytes"), filename: "fixture.pdf", pages: 1 };
  });
  await assert.rejects(service.download(token, "1"), (error: unknown) => error instanceof SettingsError && error.status === 403);
  assert.equal(rendered, true);
  assert.equal(reads, 2);
});
