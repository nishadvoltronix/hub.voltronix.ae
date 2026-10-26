import { compare, hashSync } from "bcryptjs";
import { z } from "zod";
import type { AuthUser } from "@voltronix/crm-contracts";
import { AuthError } from "./errors.js";
import { requirePermissions, type PermissionKey } from "./permissions.js";
import { digest, matchesCsrfHash, newToken, validToken } from "./tokens.js";
import type { AuthStore, AuthTransaction, StoredSession, StoredUser } from "./store.js";

export const SESSION_LIFETIME_MS = 7_200_000;
export const LOGIN_WINDOW_MS = 900_000;
const loginInput = z.object({
  email: z.email().max(254).transform(value => value.toLowerCase()),
  password: z.string().min(1).max(1024).refine(value => !value.includes("\0")),
});
let dummyHash: string | undefined;
function getDummyHash() { return dummyHash ??= hashSync(newToken(), 12); }
export interface AuthOptions {
  now?: () => number;
  /** Narrow injection for deterministic race/error tests, never environment selected. */
  verifyPassword?: (password: string, hash: string) => Promise<boolean>;
}

export function createAuthService(store: AuthStore, options: AuthOptions = {}) {
  const now = options.now ?? Date.now;
  const verify = options.verifyPassword ?? compare;
  async function userFromRow(tx: AuthTransaction, user: StoredUser): Promise<AuthUser> {
    return { localUserId: user.localUserId, externalUserId: user.externalUserId,
      username: user.username, email: user.email, permissions: await tx.permissionsFor(user.localUserId) };
  }
  async function currentSession(tx: AuthTransaction, token: unknown): Promise<{ session: StoredSession; user: StoredUser } | null> {
    if (!validToken(token)) return null;
    const tokenHash = digest(token);
    const session = await tx.getSession(tokenHash);
    if (!session) return null;
    const user = await tx.findUserById(session.userId);
    if (!user || user.status !== "active" || session.expiresAt <= now()
      || session.passwordFingerprint !== digest(user.passwordHash)) {
      await tx.deleteSession(tokenHash);
      return null;
    }
    return { session, user };
  }
  async function authenticate(sessionToken: unknown): Promise<AuthUser | null> {
    if (!validToken(sessionToken)) return null;
    return store.transaction(async tx => {
      const current = await currentSession(tx, sessionToken);
      return current ? userFromRow(tx, current.user) : null;
    });
  }
  async function reserveAttempt(email: string): Promise<boolean> {
    return store.transaction(async tx => {
      const timestamp = now();
      await tx.pruneAttempts(timestamp - LOGIN_WINDOW_MS);
      for (const [bucket, limit] of [[`client:${digest("web")}`, 100], [`account:${digest(email)}`, 5]] as const) {
        const attempt = await tx.getAttempt(bucket);
        if (attempt && attempt.attempts >= limit) return false;
        await tx.incrementAttempt(bucket, timestamp);
      }
      return true;
    });
  }
  async function login(email: unknown, password: unknown, previousSession?: unknown) {
    const input = loginInput.safeParse({ email, password });
    if (!input.success) throw new AuthError("credentials");
    if (!await reserveAttempt(input.data.email)) throw new AuthError("throttled");
    const user = await store.transaction(tx => tx.findUserByEmail(input.data.email));
    const supported = !!user && /^\$2[aby]\$(0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$/.test(user.passwordHash);
    const valid = await verify(input.data.password, user?.status === "active" && supported ? user.passwordHash : getDummyHash());
    if (!valid || !user || user.status !== "active" || !supported) throw new AuthError("credentials");
    return store.transaction(async tx => {
      const fresh = await tx.findUserByEmail(input.data.email);
      if (!fresh || fresh.status !== "active" || fresh.localUserId !== user.localUserId || fresh.passwordHash !== user.passwordHash) {
        throw new AuthError("credentials");
      }
      const sessionToken = newToken(), csrfToken = newToken(), createdAt = now();
      const expiresAt = createdAt + SESSION_LIFETIME_MS;
      await tx.deleteExpiredSessions(createdAt);
      await tx.insertSession({ tokenHash: digest(sessionToken), userId: fresh.localUserId,
        csrfHash: digest(csrfToken), passwordFingerprint: digest(fresh.passwordHash), createdAt, expiresAt });
      // Atomic replacement closes the prior Next create-then-revoke failure window.
      if (validToken(previousSession)) await tx.deleteSession(digest(previousSession));
      return { sessionToken, csrfToken, user: await userFromRow(tx, fresh), expiresAt };
    });
  }
  async function logout(sessionToken: unknown): Promise<void> {
    if (validToken(sessionToken)) await store.transaction(tx => tx.deleteSession(digest(sessionToken)));
  }
  async function verifySessionCsrf(sessionToken: unknown, csrfToken: unknown): Promise<boolean> {
    if (!validToken(csrfToken) || !validToken(sessionToken)) return false;
    return store.transaction(async tx => {
      const current = await currentSession(tx, sessionToken);
      return !!current && matchesCsrfHash(csrfToken, current.session.csrfHash);
    });
  }
  async function setSessionCsrf(sessionToken: unknown, csrfToken: unknown): Promise<boolean> {
    if (!validToken(sessionToken) || !validToken(csrfToken)) return false;
    return store.transaction(async tx => {
      if (!await currentSession(tx, sessionToken)) return false;
      await tx.updateSessionCsrf(digest(sessionToken), digest(csrfToken));
      return true;
    });
  }
  async function authorize(sessionToken: unknown, permissions: readonly PermissionKey[]): Promise<AuthUser> {
    const user = await authenticate(sessionToken);
    if (!user) throw new AuthError("authentication");
    requirePermissions(user, permissions);
    return user;
  }
  return { login, authenticate, logout, setSessionCsrf, verifySessionCsrf, authorize };
}
export type AuthService = ReturnType<typeof createAuthService>;
