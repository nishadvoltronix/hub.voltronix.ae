import type { MysqlAuthDatabase, MysqlAuthSqlTransaction } from "../db/mysql/database.js";
import { AuthError } from "./errors.js";
import type { AuthStore, AuthTransaction, LoginAttempt, StoredSession, StoredUser } from "./store.js";

// Static statements only. Values never become identifiers, clauses or SQL fragments.
const userColumns = "CAST(id AS CHAR) AS local_id, user_id, username, email, password, status";
const statements = {
  userByEmail: `SELECT ${userColumns} FROM users WHERE email = ? LIMIT 2`,
  userById: `SELECT ${userColumns} FROM users WHERE id = ? LIMIT 2`,
  permissions: "SELECT p.`key` FROM permissions p JOIN admin_user_permissions a ON a.permission_id = p.id WHERE a.admin_user_id = ? ORDER BY p.`key`",
  session: "SELECT token_hash, CAST(user_id AS CHAR) AS user_id, csrf_hash, password_fingerprint, created_at, expires_at FROM crm_sessions WHERE token_hash = ? LIMIT 2",
  insertSession: "INSERT INTO crm_sessions(token_hash, user_id, csrf_hash, password_fingerprint, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  deleteSession: "DELETE FROM crm_sessions WHERE token_hash = ?",
  expiredSessions: "DELETE FROM crm_sessions WHERE expires_at <= ?",
  sessionCsrf: "UPDATE crm_sessions SET csrf_hash = ? WHERE token_hash = ?",
  pruneAttempts: "DELETE FROM crm_login_attempts WHERE window_start <= ?",
  attempt: "SELECT window_start, attempts FROM crm_login_attempts WHERE bucket = ? LIMIT 2",
  incrementAttempt: "INSERT INTO crm_login_attempts(bucket, window_start, attempts) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE attempts = attempts + 1",
} as const;

function unavailable(): never { throw new AuthError("unavailable"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) return unavailable();
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)
    || BigInt(value) > 9_223_372_036_854_775_807n) return unavailable();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return unavailable();
  return value;
}
function safeInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  // mysql2 returns BIGINT strings with bigNumberStrings. Never accept coercible junk,
  // rounded Number IDs, floating point timestamps, or a lossy BIGINT conversion.
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) value = Number(value);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) return unavailable();
  return value;
}
function bucket(value: unknown): string {
  if (typeof value !== "string" || !/^(client|account):[a-f0-9]{64}$/.test(value)) return unavailable();
  return value;
}
function user(value: unknown): StoredUser {
  const row = record(value);
  if (row.status !== "active" && row.status !== "inactive") return unavailable();
  return { localUserId: identifier(row.local_id),
    externalUserId: row.user_id === null ? null : text(row.user_id, 100),
    username: text(row.username, 120), email: text(row.email, 254),
    passwordHash: text(row.password, 255), status: row.status };
}
function session(value: unknown): StoredSession {
  const row = record(value);
  const createdAt = safeInteger(row.created_at), expiresAt = safeInteger(row.expires_at);
  if (expiresAt <= createdAt) return unavailable();
  return { tokenHash: hash(row.token_hash), userId: identifier(row.user_id), csrfHash: hash(row.csrf_hash),
    passwordFingerprint: hash(row.password_fingerprint), createdAt, expiresAt };
}
function insertValues(value: StoredSession): unknown[] {
  const checked = session({ token_hash: value.tokenHash, user_id: value.userId, csrf_hash: value.csrfHash,
    password_fingerprint: value.passwordFingerprint, created_at: value.createdAt, expires_at: value.expiresAt });
  return [checked.tokenHash, checked.userId, checked.csrfHash, checked.passwordFingerprint, checked.createdAt, checked.expiresAt];
}

function transaction(sql: MysqlAuthSqlTransaction): AuthTransaction {
  async function execute(statement: string, values: readonly unknown[]): Promise<unknown> {
    try {
      const result = await sql.execute(statement, values);
      if (!Array.isArray(result) || result.length !== 2) return unavailable();
      return result[0];
    } catch { return unavailable(); }
  }
  async function rows(statement: string, values: readonly unknown[]): Promise<Record<string, unknown>[]> {
    const result = await execute(statement, values);
    if (!Array.isArray(result)) return unavailable();
    return result.map(record);
  }
  async function one(statement: string, values: readonly unknown[]): Promise<Record<string, unknown> | null> {
    const result = await rows(statement, values);
    if (result.length > 1) return unavailable();
    return result[0] ?? null;
  }
  async function mutation(statement: string, values: readonly unknown[], minimum: number, maximum: number): Promise<void> {
    const result = record(await execute(statement, values));
    safeInteger(result.affectedRows, minimum, maximum);
    // Strict SQL mode is also required by the connection layer. A warning is not
    // accepted as a successful credential/session/throttle write.
    if (result.warningStatus !== 0) return unavailable();
  }
  return {
    async findUserByEmail(email) {
      const row = await one(statements.userByEmail, [text(email, 254)]);
      return row === null ? null : user(row);
    },
    async findUserById(id) {
      const expected = identifier(id), row = await one(statements.userById, [expected]);
      if (row === null) return null;
      const found = user(row);
      if (found.localUserId !== expected) return unavailable();
      return found;
    },
    async permissionsFor(userId) {
      const result = await rows(statements.permissions, [identifier(userId)]);
      const permissions = result.map(row => text(row.key, 120));
      if (permissions.some(key => key.length === 0) || new Set(permissions).size !== permissions.length) return unavailable();
      return permissions;
    },
    async getSession(tokenHash) {
      const expected = hash(tokenHash), row = await one(statements.session, [expected]);
      if (row === null) return null;
      const found = session(row);
      if (found.tokenHash !== expected) return unavailable();
      return found;
    },
    async insertSession(value) { await mutation(statements.insertSession, insertValues(value), 1, 1); },
    async deleteSession(tokenHash) { await mutation(statements.deleteSession, [hash(tokenHash)], 0, 1); },
    async deleteExpiredSessions(atOrBefore) {
      await mutation(statements.expiredSessions, [safeInteger(atOrBefore, -Number.MAX_SAFE_INTEGER)], 0, Number.MAX_SAFE_INTEGER);
    },
    async updateSessionCsrf(tokenHash, csrfHash) { await mutation(statements.sessionCsrf, [hash(csrfHash), hash(tokenHash)], 0, 1); },
    async pruneAttempts(atOrBefore) {
      await mutation(statements.pruneAttempts, [safeInteger(atOrBefore, -Number.MAX_SAFE_INTEGER)], 0, Number.MAX_SAFE_INTEGER);
    },
    async getAttempt(value): Promise<LoginAttempt | null> {
      const row = await one(statements.attempt, [bucket(value)]);
      return row === null ? null : { windowStart: safeInteger(row.window_start), attempts: safeInteger(row.attempts, 0, 2_147_483_647) };
    },
    async incrementAttempt(value, initialWindowStart) {
      await mutation(statements.incrementAttempt, [bucket(value), safeInteger(initialWindowStart)], 1, 2);
    },
  };
}

/** Real SQL adapter, but construction performs no I/O. The supplied MySQL database
 * owns the pinned connection, technical lock, transaction, lease and rollback.
 * Password verification stays in createAuthService (bcrypt); no passwords are
 * persisted or compared in SQL. No MySQL connection or fallback is selected here.
 */
export function createMysqlAuthStore(database: MysqlAuthDatabase): AuthStore {
  return {
    async transaction<T>(work: (tx: AuthTransaction) => Promise<T>): Promise<T> {
      try { return await database.transaction(sql => work(transaction(sql))); }
      catch (error) {
        if (error instanceof AuthError) throw error;
        return unavailable();
      }
    },
  };
}
