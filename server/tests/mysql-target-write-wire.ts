import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MysqlDatabase } from "../src/crm/db/mysql/database.js";
import type { MysqlWireConnection } from "../src/crm/db/mysql/driver.js";

export type TargetCall = { sql: string; values: readonly unknown[]; connection: number };
export type TargetReply = [unknown, unknown];
export const targetRows = (rows: unknown[]): TargetReply => [rows, []];
export const targetChanged = (affectedRows = 1, insertId = 0): TargetReply => [{ affectedRows, insertId }, []];
export const targetToken = "a".repeat(43);
export const targetNow = Date.parse("2026-10-14T12:00:00.000Z");

/** An explicit wire model, not a MySQL server. It validates application ordering,
 * parameter binding and responses to constraints; it does not certify SQL syntax,
 * InnoDB isolation or installed target constraints. All state is synthetic memory. */
export function targetFixture<State>(initial: State,
  handle: (state: State, call: TargetCall) => TargetReply | Promise<TargetReply>,
  initialGrants = ["leads.view", "leads.manage", "deals.manage", "items.write"]) {
  let state = structuredClone(initial), nextConnection = 0;
  let queue = Promise.resolve();
  const calls: TargetCall[] = [], events: { connection: number; event: string }[] = [];
  const grants = [...initialGrants];
  let sessionPresent = true, fault: { match: RegExp; code: string } | undefined;
  let commitFailure = false;
  const connect = async (): Promise<MysqlWireConnection> => {
    const id = ++nextConnection;
    let active = false, locked = false, before: State | undefined, release: (() => void) | undefined;
    const savepoints = new Map<string, State>();
    const event = (event: string) => { events.push({ connection: id, event }); };
    const finish = (rollback: boolean) => {
      if (rollback && locked && before !== undefined) state = before;
      active = false; locked = false; before = undefined; savepoints.clear(); release?.(); release = undefined;
    };
    return {
      async execute(rawSql, values = []) {
        const sql = rawSql.replace(/\s+/g, " ").trim(), call = { sql, values, connection: id };
        calls.push(call);
        if (sql === "SELECT id FROM crm_app_lock WHERE id=1 FOR UPDATE") {
          assert.equal(active, true); assert.equal(locked, false);
          const previous = queue;
          queue = new Promise<void>(resolve => { release = resolve; });
          await previous;
          locked = true; before = structuredClone(state); event("LOCK");
          return targetRows([{ id: 1 }]);
        }
        if (!sql.startsWith("SELECT ")) assert.equal(active && locked, true, "adapter mutations must remain inside the application transaction lock");
        if (fault?.match.test(sql)) throw Object.assign(new Error("private driver detail must not escape"), { code: fault.code });
        if (sql.includes("FROM crm_sessions s JOIN users")) return targetRows(sessionPresent ? [{ local_id: "1", user_id: "101",
          username: "Synthetic owner", email: "owner@example.invalid", password: "synthetic-password-hash", status: "active",
          password_fingerprint: createHash("sha256").update("synthetic-password-hash").digest("hex"), csrf_hash: "unused",
          expires_at: Number.MAX_SAFE_INTEGER }] : []);
        if (sql.startsWith("SELECT 1 FROM crm_zoho_user_bindings binding")) return targetRows([]);
        if (sql.startsWith("SELECT p.`key` FROM permissions")) return targetRows(grants.map(key => ({ key })));
        return handle(state, call);
      },
      async query(sql) {
        if (sql.startsWith("SET SESSION")) return targetRows([]);
        event(sql);
        if (sql.startsWith("SAVEPOINT ")) savepoints.set(sql.slice(10), structuredClone(state));
        else if (sql.startsWith("ROLLBACK TO SAVEPOINT ")) {
          const snapshot = savepoints.get(sql.slice(22)); assert.notEqual(snapshot, undefined); state = structuredClone(snapshot!);
        } else if (sql.startsWith("RELEASE SAVEPOINT ")) savepoints.delete(sql.slice(18));
        else assert.fail(`Unexpected transaction query: ${sql}`);
        return targetRows([]);
      },
      async beginTransaction() { assert.equal(active, false); active = true; event("BEGIN"); },
      async commit() {
        assert.equal(active && locked, true); event("COMMIT");
        if (commitFailure) throw new Error("private commit detail");
        finish(false);
      },
      async rollback() { event("ROLLBACK"); finish(true); },
      async end() { event("END"); if (active) finish(true); },
      destroy() { event("DESTROY"); if (active) finish(true); },
    };
  };
  const db = new MysqlDatabase({ provider: "mysql", environment: "test", host: "127.0.0.1", port: 3308,
    database: "crm_test_target_writes", user: "synthetic", password: "synthetic-test-only" }, { connect, verify: async () => {} });
  return { db, calls, events, grants, state: () => structuredClone(state),
    fail(match: RegExp, code: string) { fault = { match, code }; }, clearFault() { fault = undefined; },
    session(present: boolean) { sessionPresent = present; }, failCommit() { commitFailure = true; } };
}
