import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "better-sqlite3";
import { compare, hashSync } from "bcryptjs";
import { z } from "zod";
import { DEPARTMENT_PERMISSIONS, type PermissionKey } from "./permissions";

export const SESSION_LIFETIME_MS = 2 * 60 * 60 * 1_000;
export const LOGIN_WINDOW_MS = 15 * 60 * 1_000;
const opaqueToken = /^[A-Za-z0-9_-]{43}$/;
const loginInput = z.object({
  email: z.email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(1024).refine((value) => !value.includes("\0")),
});
const identifier = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n);
// Same costly verification path when an account is absent, disabled, or unsupported.
// This is an unprivileged random dummy, never a provisioned account or shared password.
let dummyHash: string | undefined;
function getDummyHash() {
  return dummyHash ??= hashSync(randomBytes(32).toString("base64url"), 12);
}
function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
function token() { return randomBytes(32).toString("base64url"); }

export class AuthError extends Error {
  constructor(public readonly status: 401 | 403 | 404 | 429, message?: string) {
    super(message ?? ({ 401: "Invalid email or password.", 403: "Access denied.",
      404: "Record not found.", 429: "Unable to sign in. Try again later." })[status]);
    this.name = "AuthError";
  }
}

export interface AuthUser {
  localUserId: string;
  externalUserId: string | null;
  username: string;
  email: string;
  permissions: string[];
}
interface UserRow {
  local_id: string; user_id: string | null; username: string; email: string;
  password: string; status: string;
}
interface SessionRow extends UserRow { csrf_hash: string; password_fingerprint: string; expires_at: number }
export interface TaskSummary { id: string; dealName: string | null; status: string | null }

export function requirePermission(user: AuthUser, permission: PermissionKey): void {
  if (!user.permissions.includes(permission)) throw new AuthError(403);
}

export function createAuthService(db: Database, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const selectUser = db.prepare(`SELECT CAST(id AS TEXT) AS local_id, user_id,
    username, email, password, status FROM users WHERE email = ? COLLATE NOCASE`);
  const selectSession = db.prepare(`SELECT CAST(u.id AS TEXT) AS local_id, u.user_id,
    u.username, u.email, u.password, u.status, s.csrf_hash, s.password_fingerprint, s.expires_at
    FROM crm_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`);
  const grants = db.prepare(`SELECT p."key" FROM permissions p
    JOIN admin_user_permissions a ON a.permission_id = p.id
    WHERE a.admin_user_id = ? ORDER BY p."key"`);

  function userFromRow(row: UserRow): AuthUser {
    return { localUserId: row.local_id, externalUserId: row.user_id,
      username: row.username, email: row.email,
      permissions: (grants.all(row.local_id) as { key: string }[]).map((value) => value.key) };
  }
  function currentSession(sessionToken: string | undefined | null): SessionRow | null {
    if (typeof sessionToken !== "string" || !opaqueToken.test(sessionToken)) return null;
    const tokenHash = digest(sessionToken);
    const row = selectSession.get(tokenHash) as SessionRow | undefined;
    if (!row) return null;
    if (row.status !== "active" || row.expires_at <= now() || row.password_fingerprint !== digest(row.password)) {
      // Once invalidity is observed this session cannot revive on account reactivation.
      // Future account-management mutations must revoke all affected sessions atomically.
      db.prepare("DELETE FROM crm_sessions WHERE token_hash = ?").run(tokenHash);
      return null;
    }
    return row;
  }
  function authenticate(sessionToken: string | undefined | null): AuthUser | null {
    const row = currentSession(sessionToken);
    return row ? userFromRow(row) : null;
  }

  const reserveAttempt = db.transaction((email: string, clientKey: string) => {
    const timestamp = now();
    db.prepare("DELETE FROM crm_login_attempts WHERE window_start <= ?")
      .run(timestamp - LOGIN_WINDOW_MS);
    // The web adapter passes a constant server-defined key: no spoofable IP headers.
    // A global limit bounds bcrypt work and also bounds account-bucket creation.
    const buckets = [[`client:${digest(clientKey)}`, 100], [`account:${digest(email)}`, 5]] as const;
    for (const [bucket, limit] of buckets) {
      const row = db.prepare("SELECT attempts FROM crm_login_attempts WHERE bucket = ?")
        .get(bucket) as { attempts: number } | undefined;
      if (row && row.attempts >= limit) return false;
      db.prepare(`INSERT INTO crm_login_attempts(bucket, window_start, attempts) VALUES (?, ?, 1)
        ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1`).run(bucket, timestamp);
    }
    return true;
  });

  async function login(email: unknown, password: unknown, clientKey: string) {
    const input = loginInput.safeParse({ email, password });
    if (!input.success) throw new AuthError(401);
    if (!reserveAttempt.immediate(input.data.email, clientKey)) throw new AuthError(429);
    const row = selectUser.get(input.data.email) as UserRow | undefined;
    const supported = !!row && /^\$2[aby]\$(0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$/.test(row.password);
    const valid = await compare(input.data.password,
      row?.status === "active" && supported ? row.password : getDummyHash());
    if (!valid || !row || row.status !== "active" || !supported) throw new AuthError(401);

    // Password verification yields to the event loop. Recheck before issuing a session
    // so an intervening disable or password update cannot authorize the stale account.
    return db.transaction(() => {
      const fresh = selectUser.get(input.data.email) as UserRow | undefined;
      if (!fresh || fresh.status !== "active" || fresh.password !== row.password || fresh.local_id !== row.local_id) {
        throw new AuthError(401);
      }
      const sessionToken = token();
      const csrfToken = token();
      const createdAt = now();
      const expiresAt = createdAt + SESSION_LIFETIME_MS;
      db.prepare("DELETE FROM crm_sessions WHERE expires_at <= ?").run(createdAt);
      db.prepare(`INSERT INTO crm_sessions(token_hash, user_id, csrf_hash, password_fingerprint, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(digest(sessionToken), fresh.local_id,
        digest(csrfToken), digest(fresh.password), createdAt, expiresAt);
      return { sessionToken, csrfToken, user: userFromRow(fresh), expiresAt };
    }).immediate();
  }

  function logout(sessionToken: string | undefined | null): void {
    if (typeof sessionToken === "string" && opaqueToken.test(sessionToken)) {
      db.prepare("DELETE FROM crm_sessions WHERE token_hash = ?").run(digest(sessionToken));
    }
  }
  function verifySessionCsrf(sessionToken: string | undefined | null, csrfToken: string | undefined | null): boolean {
    if (typeof csrfToken !== "string" || !opaqueToken.test(csrfToken)) return false;
    const row = currentSession(sessionToken);
    return !!row && /^[a-f0-9]{64}$/.test(row.csrf_hash) &&
      timingSafeEqual(Buffer.from(row.csrf_hash, "hex"), Buffer.from(digest(csrfToken), "hex"));
  }
  function setSessionCsrf(sessionToken: string, csrfToken: string): boolean {
    if (!opaqueToken.test(csrfToken)) return false;
    return db.transaction(() => {
      if (!currentSession(sessionToken)) return false;
      db.prepare("UPDATE crm_sessions SET csrf_hash = ? WHERE token_hash = ?")
        .run(digest(csrfToken), digest(sessionToken));
      return true;
    }).immediate();
  }

  function canAccessTask(user: AuthUser, taskId: string): boolean {
    if (!identifier.safeParse(taskId).success) return false;
    const task = db.prepare("SELECT assigned_to FROM tasks WHERE id = ?").get(taskId) as
      { assigned_to: string | null } | undefined;
    if (!task) return false;
    // Admincrm::Pipeline_Dashboard selects the agent branch even when other lead
    // grants coexist. The broad reader cannot bypass that source-observed branch.
    if (user.permissions.includes("leads.manage.agents")) {
      if (user.externalUserId !== null && task.assigned_to === user.externalUserId) return true;
    } else if (user.permissions.includes("leads.view")) return true;
    const assignments = db.prepare(`SELECT a.department FROM departments_assign a
      WHERE a.task_id = ? AND a.user_id = ? AND a.id = (
        SELECT MAX(latest.id) FROM departments_assign latest
        WHERE latest.task_id = a.task_id AND latest.department = a.department)`)
      .all(taskId, user.localUserId) as { department: string }[];
    return assignments.some(({ department }) => {
      const required = DEPARTMENT_PERMISSIONS[department as keyof typeof DEPARTMENT_PERMISSIONS];
      return required !== undefined && user.permissions.includes(required);
    });
  }
  function getAuthorizedTask(sessionToken: string | undefined | null, taskId: string): TaskSummary {
    return db.transaction(() => {
      const user = authenticate(sessionToken);
      if (!user) throw new AuthError(401, "Sign in required.");
      if (!canAccessTask(user, taskId)) throw new AuthError(404);
      return db.prepare(`SELECT CAST(id AS TEXT) AS id, deal_name AS dealName, status
        FROM tasks WHERE id = ?`).get(taskId) as TaskSummary;
    })();
  }

  return { login, authenticate, logout, verifySessionCsrf, setSessionCsrf, canAccessTask, getAuthorizedTask };
}
