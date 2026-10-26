import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { AuthError } from "../src/auth/errors.js";
import type { AuthStore, AuthTransaction } from "../src/auth/store.js";

/** One owner serializes reference-service calls and asynchronous auth callbacks
 * on the same real SQLite connection. No callback can accidentally join another
 * request's transaction while password/session work yields to the event loop. */
export function createSqliteExecutor(db: SqliteDatabase) {
  const context = new AsyncLocalStorage<{ active: boolean; refused: boolean }>();
  let accepting = true, tail: Promise<unknown> = Promise.resolve(), stopping: Promise<void> | undefined;
  return {
    run<T>(work: () => T | Promise<T>): Promise<T> {
      const current = context.getStore();
      if (current) { current.refused = true; return Promise.reject(new AuthError("unavailable")); }
      if (!accepting) return Promise.reject(new AuthError("unavailable"));
      const result = tail.then(() => context.run({ active: true, refused: false }, async () => {
        const owned = context.getStore()!;
        try { return await work(); } finally { owned.active = false; }
      }));
      tail = result.then(() => undefined, () => undefined); return result;
    },
    assertOwned() {
      const owned = context.getStore();
      if (!owned?.active || owned.refused) throw new AuthError("unavailable");
    },
    close(): Promise<void> {
      if (!stopping) { accepting = false; stopping = tail.then(() => { if (db.open) db.close(); }); }
      return stopping;
    },
  };
}
export type SqliteExecutor = ReturnType<typeof createSqliteExecutor>;
const id = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => BigInt(value) <= 9_223_372_036_854_775_807n);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const cutoff = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const bucket = z.string().regex(/^(client|account):[a-f0-9]{64}$/);
const user = z.object({ localUserId: id, externalUserId: z.string().max(100).nullable(), username: z.string().min(1).max(120),
  email: z.string().min(1).max(254), passwordHash: z.string().min(1).max(255), status: z.enum(["active", "inactive"]) }).strict();
const session = z.object({ tokenHash: digest, userId: id, csrfHash: digest, passwordFingerprint: digest,
  createdAt: integer, expiresAt: integer }).strict().refine(value => value.expiresAt > value.createdAt);
const attempt = z.object({ windowStart: integer, attempts: integer.max(2_147_483_647) }).strict();

/** Real parameterized SQLite store for the existing backend authentication
 * service. Transactions are explicit because better-sqlite3's synchronous
 * transaction helper must never receive an async callback. */
export function createSqliteAuthStore(db: SqliteDatabase, executor: SqliteExecutor): AuthStore {
  const columns = "CAST(id AS TEXT) AS localUserId,user_id AS externalUserId,username,email,password AS passwordHash,status";
  const byEmail = db.prepare(`SELECT ${columns} FROM users WHERE email=? COLLATE NOCASE`);
  const byId = db.prepare(`SELECT ${columns} FROM users WHERE id=?`);
  const permissions = db.prepare('SELECT p."key" FROM permissions p JOIN admin_user_permissions a ON a.permission_id=p.id WHERE a.admin_user_id=? ORDER BY p."key"');
  const getSession = db.prepare("SELECT token_hash AS tokenHash,CAST(user_id AS TEXT) AS userId,csrf_hash AS csrfHash,password_fingerprint AS passwordFingerprint,created_at AS createdAt,expires_at AS expiresAt FROM crm_sessions WHERE token_hash=?");
  const insertSession = db.prepare("INSERT INTO crm_sessions(token_hash,user_id,csrf_hash,password_fingerprint,created_at,expires_at) VALUES(?,?,?,?,?,?)");
  const deleteSession = db.prepare("DELETE FROM crm_sessions WHERE token_hash=?");
  const deleteExpired = db.prepare("DELETE FROM crm_sessions WHERE expires_at<=?");
  const updateCsrf = db.prepare("UPDATE crm_sessions SET csrf_hash=? WHERE token_hash=?");
  const prune = db.prepare("DELETE FROM crm_login_attempts WHERE window_start<=?");
  const getAttempt = db.prepare("SELECT window_start AS windowStart,attempts FROM crm_login_attempts WHERE bucket=?");
  const increment = db.prepare("INSERT INTO crm_login_attempts(bucket,window_start,attempts) VALUES(?,?,1) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1");
  return {
    async transaction<T>(work: (transaction: AuthTransaction) => Promise<T>): Promise<T> {
      try {
        return await executor.run(async () => {
          if (db.inTransaction) throw new AuthError("unavailable");
          let active = true;
          const check = () => { executor.assertOwned(); if (!active) throw new AuthError("unavailable"); };
          const transaction: AuthTransaction = {
            async findUserByEmail(value) { check(); const row = byEmail.get(z.string().max(254).parse(value)); return row === undefined ? null : user.parse(row); },
            async findUserById(value) { check(); const row = byId.get(id.parse(value)); return row === undefined ? null : user.parse(row); },
            async permissionsFor(value) {
              check(); const keys = z.array(z.object({ key: z.string().min(1).max(120) }).strict()).parse(permissions.all(id.parse(value))).map(row => row.key);
              if (new Set(keys).size !== keys.length) throw new AuthError("unavailable"); return keys;
            },
            async getSession(value) { check(); const row = getSession.get(digest.parse(value)); return row === undefined ? null : session.parse(row); },
            async insertSession(value) {
              check(); const selected = session.parse(value);
              if (insertSession.run(selected.tokenHash, selected.userId, selected.csrfHash, selected.passwordFingerprint, selected.createdAt, selected.expiresAt).changes !== 1) throw new AuthError("unavailable");
            },
            async deleteSession(value) { check(); deleteSession.run(digest.parse(value)); },
            async deleteExpiredSessions(value) { check(); deleteExpired.run(cutoff.parse(value)); },
            async updateSessionCsrf(token, csrf) { check(); updateCsrf.run(digest.parse(csrf), digest.parse(token)); },
            async pruneAttempts(value) { check(); prune.run(cutoff.parse(value)); },
            async getAttempt(value) { check(); const row = getAttempt.get(bucket.parse(value)); return row === undefined ? null : attempt.parse(row); },
            async incrementAttempt(value, timestamp) { check(); increment.run(bucket.parse(value), integer.parse(timestamp)); },
          };
          db.exec("BEGIN IMMEDIATE");
          try {
            const result = await work(transaction); check(); active = false; db.exec("COMMIT"); return result;
          } catch (error) {
            active = false;
            if (db.inTransaction) db.exec("ROLLBACK");
            throw error;
          } finally { active = false; }
        });
      } catch (error) {
        if (error instanceof AuthError) throw error;
        throw new AuthError("unavailable");
      }
    },
  };
}
