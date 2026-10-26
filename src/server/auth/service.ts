import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { MysqlDatabase } from "../db/mysql/database";
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

export function createAuthService(db: MysqlDatabase, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const selectUser = db.prepare(`SELECT CAST(id AS CHAR) AS local_id, user_id,
    username, email, password, status FROM users WHERE email = ?`);
  const selectSession = db.prepare(`SELECT CAST(u.id AS CHAR) AS local_id, u.user_id,
    u.username, u.email, u.password, u.status, s.csrf_hash, s.password_fingerprint, s.expires_at
    FROM crm_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`);
  const grants = db.prepare(`SELECT p.\`key\` FROM permissions p
    JOIN admin_user_permissions a ON a.permission_id = p.id
    WHERE a.admin_user_id = ? ORDER BY p.\`key\``);

  async function userFromRow(row: UserRow): Promise<AuthUser> {
    return { localUserId: row.local_id, externalUserId: row.user_id,
      username: row.username, email: row.email,
      permissions: (await grants.all(row.local_id) as { key: string }[]).map((value) => value.key) };
  }
  async function currentSession(sessionToken: string | undefined | null): Promise<SessionRow | null> {
    if (typeof sessionToken !== "string" || !opaqueToken.test(sessionToken)) return null;
    const tokenHash = digest(sessionToken);
    const row = await selectSession.get(tokenHash) as SessionRow | undefined;
    if (!row) return null;
    if (row.status !== "active" || row.expires_at <= now() || row.password_fingerprint !== digest(row.password)) {
      // Once invalidity is observed this session cannot revive on account reactivation.
      // Future account-management mutations must revoke all affected sessions atomically.
      await db.prepare("DELETE FROM crm_sessions WHERE token_hash = ?").run(tokenHash);
      return null;
    }
    return row;
  }
  async function authenticate(sessionToken: string | undefined | null): Promise<AuthUser | null> {
    if (typeof sessionToken !== "string" || !opaqueToken.test(sessionToken)) return null;
    return db.transaction(async () => {
      const row = await currentSession(sessionToken);
      return row ? userFromRow(row) : null;
    })();
  }

  const reserveAttempt = db.transaction(async (email: string, clientKey: string) => {
    const timestamp = now();
    await db.prepare("DELETE FROM crm_login_attempts WHERE window_start <= ?")
      .run(timestamp - LOGIN_WINDOW_MS);
    // The web adapter passes a constant server-defined key: no spoofable IP headers.
    // A global limit bounds bcrypt work and also bounds account-bucket creation.
    const buckets = [[`client:${digest(clientKey)}`, 100], [`account:${digest(email)}`, 5]] as const;
    for (const [bucket, limit] of buckets) {
      const row = await db.prepare("SELECT attempts FROM crm_login_attempts WHERE bucket = ?")
        .get(bucket) as { attempts: number } | undefined;
      if (row && row.attempts >= limit) return false;
      await db.prepare(`INSERT INTO crm_login_attempts(bucket, window_start, attempts) VALUES (?, ?, 1)
        ON DUPLICATE KEY UPDATE attempts = attempts + 1`).run(bucket, timestamp);
    }
    return true;
  });

  async function login(email: unknown, password: unknown, clientKey: string) {
    const input = loginInput.safeParse({ email, password });
    if (!input.success) throw new AuthError(401);
    if (!await reserveAttempt.immediate(input.data.email, clientKey)) throw new AuthError(429);
    const row = await selectUser.get(input.data.email) as UserRow | undefined;
    const supported = !!row && /^\$2[aby]\$(0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$/.test(row.password);
    const valid = await compare(input.data.password,
      row?.status === "active" && supported ? row.password : getDummyHash());
    if (!valid || !row || row.status !== "active" || !supported) throw new AuthError(401);

    // Password verification yields to the event loop. Recheck before issuing a session
    // so an intervening disable or password update cannot authorize the stale account.
    return db.transaction(async () => {
      const fresh = await selectUser.get(input.data.email) as UserRow | undefined;
      if (!fresh || fresh.status !== "active" || fresh.password !== row.password || fresh.local_id !== row.local_id) {
        throw new AuthError(401);
      }
      const sessionToken = token();
      const csrfToken = token();
      const createdAt = now();
      const expiresAt = createdAt + SESSION_LIFETIME_MS;
      await db.prepare("DELETE FROM crm_sessions WHERE expires_at <= ?").run(createdAt);
      await db.prepare(`INSERT INTO crm_sessions(token_hash, user_id, csrf_hash, password_fingerprint, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(digest(sessionToken), fresh.local_id,
        digest(csrfToken), digest(fresh.password), createdAt, expiresAt);
      return { sessionToken, csrfToken, user: await userFromRow(fresh), expiresAt };
    }).immediate();
  }

  async function logout(sessionToken: string | undefined | null): Promise<void> {
    if (typeof sessionToken === "string" && opaqueToken.test(sessionToken)) {
      await db.transaction(async () => {
        await db.prepare("DELETE FROM crm_sessions WHERE token_hash = ?").run(digest(sessionToken));
      }).immediate();
    }
  }
  async function verifySessionCsrf(sessionToken: string | undefined | null, csrfToken: string | undefined | null): Promise<boolean> {
    if (typeof csrfToken !== "string" || !opaqueToken.test(csrfToken)) return false;
    return db.transaction(async () => {
      const row = await currentSession(sessionToken);
      return !!row && /^[a-f0-9]{64}$/.test(row.csrf_hash) &&
        timingSafeEqual(Buffer.from(row.csrf_hash, "hex"), Buffer.from(digest(csrfToken), "hex"));
    })();
  }
  async function setSessionCsrf(sessionToken: string, csrfToken: string): Promise<boolean> {
    if (!opaqueToken.test(csrfToken)) return false;
    return db.transaction(async () => {
      if (!await currentSession(sessionToken)) return false;
      await db.prepare("UPDATE crm_sessions SET csrf_hash = ? WHERE token_hash = ?")
        .run(digest(csrfToken), digest(sessionToken));
      return true;
    }).immediate();
  }

  async function canAccessTask(user: AuthUser, taskId: string): Promise<boolean> {
    if (!identifier.safeParse(taskId).success) return false;
    const task = await db.prepare("SELECT assigned_to FROM tasks WHERE id = ?").get(taskId) as
      { assigned_to: string | null } | undefined;
    if (!task) return false;
    // Admincrm::Pipeline_Dashboard selects the agent branch even when other lead
    // grants coexist. The broad reader cannot bypass that source-observed branch.
    if (user.permissions.includes("leads.manage.agents")) {
      if (user.externalUserId !== null && task.assigned_to === user.externalUserId) return true;
    } else if (user.permissions.includes("leads.view")) return true;
    const assignments = await db.prepare(`SELECT a.department FROM departments_assign a
      WHERE a.task_id = ? AND a.user_id = ? AND a.id = (
        SELECT MAX(latest.id) FROM departments_assign latest
        WHERE latest.task_id = a.task_id AND latest.department = a.department)`)
      .all(taskId, user.localUserId) as { department: string }[];
    return assignments.some(({ department }) => {
      const required = DEPARTMENT_PERMISSIONS[department as keyof typeof DEPARTMENT_PERMISSIONS];
      return required !== undefined && user.permissions.includes(required);
    });
  }
  async function getAuthorizedTask(sessionToken: string | undefined | null, taskId: string): Promise<TaskSummary> {
    return db.transaction(async () => {
      const user = await authenticate(sessionToken);
      if (!user) throw new AuthError(401, "Sign in required.");
      if (!await canAccessTask(user, taskId)) throw new AuthError(404);
      return await db.prepare(`SELECT CAST(id AS CHAR) AS id, deal_name AS dealName, status
        FROM tasks WHERE id = ?`).get(taskId) as TaskSummary;
    })();
  }

  return { login, authenticate, logout, verifySessionCsrf, setSessionCsrf, canAccessTask, getAuthorizedTask };
}
