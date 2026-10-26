/** Private persistence contract, never a wire DTO or a runtime in-memory fallback. */
export interface StoredUser {
  localUserId: string;
  externalUserId: string | null;
  username: string;
  email: string;
  passwordHash: string;
  status: string;
}
export interface StoredSession {
  tokenHash: string;
  userId: string;
  csrfHash: string;
  passwordFingerprint: string;
  createdAt: number;
  expiresAt: number;
}
export interface LoginAttempt { windowStart: number; attempts: number }

/** Values are detached snapshots; mutations occur only through these methods.
 * A future driver must decode canonical string IDs and safe integer millisecond
 * timestamps/attempt counters and reject invalid rows; never trust Number coercion
 * of BIGINT identifiers. Offline fixtures are not evidence for that driver.
 */
export interface AuthTransaction {
  findUserByEmail(email: string): Promise<StoredUser | null>;
  findUserById(id: string): Promise<StoredUser | null>;
  permissionsFor(userId: string): Promise<string[]>;
  getSession(tokenHash: string): Promise<StoredSession | null>;
  insertSession(session: StoredSession): Promise<void>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteExpiredSessions(atOrBefore: number): Promise<void>;
  updateSessionCsrf(tokenHash: string, csrfHash: string): Promise<void>;
  pruneAttempts(atOrBefore: number): Promise<void>;
  getAttempt(bucket: string): Promise<LoginAttempt | null>;
  incrementAttempt(bucket: string, initialWindowStart: number): Promise<void>;
}
export interface AuthStore {
  /** Serialize auth operations; commit on success, rollback all writes on rejection.
   * Callbacks must not escape or nest a second transaction. The future MySQL adapter
   * must prove lease/lock/rollback semantics; no such adapter exists in this increment.
   */
  transaction<T>(work: (transaction: AuthTransaction) => Promise<T>): Promise<T>;
}
