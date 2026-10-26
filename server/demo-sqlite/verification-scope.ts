import { openDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { databaseConfig } from "./storage.js";

export const FIXTURE_MUTATION_SCOPE = "fixture-writes-and-auth" as const;
export type DemoSessionPolicy = "preserve-existing" | "allow-expired-cleanup";
export interface DemoVerificationScope { mutationScope: typeof FIXTURE_MUTATION_SCOPE; sessionPolicy: DemoSessionPolicy }
export interface DemoSessionMetadata { userId: number; createdAt: number; expiresAt: number }
export class VerificationScopeError extends Error {
  constructor(readonly reason: "explicit-scope-required" | "session-preservation-at-risk") {
    super(reason === "explicit-scope-required"
      ? "Broad verification performs authenticated fixture writes. Supply --mutation-scope=fixture-writes-and-auth and an explicit --session-policy=preserve-existing or --session-policy=allow-expired-cleanup. Use status for service health or verify-anonymous for unauthenticated checks."
      : "Existing sessions are expired or too close to expiry for preservation. No authentication was attempted. Use only a separately authorized normal expired-session cleanup policy; never restore or extend session tokens.");
  }
}
export function assertDemoVerificationScope(value: unknown): asserts value is DemoVerificationScope {
  if (!value || typeof value !== "object" || !("mutationScope" in value) || !("sessionPolicy" in value)
    || value.mutationScope !== FIXTURE_MUTATION_SCOPE || !["preserve-existing", "allow-expired-cleanup"].includes(String(value.sessionPolicy))) {
    throw new VerificationScopeError("explicit-scope-required");
  }
}
/** Pure parsing happens before child processes, private credentials, SQLite or HTTP. */
export function parseDemoVerificationArguments(args: readonly string[]): DemoVerificationScope | undefined {
  if (args[0] !== "verify") return undefined;
  if (args.length !== 3 || args[1] !== `--mutation-scope=${FIXTURE_MUTATION_SCOPE}`
    || !["--session-policy=preserve-existing", "--session-policy=allow-expired-cleanup"].includes(args[2]!)) {
    throw new VerificationScopeError("explicit-scope-required");
  }
  const scope = { mutationScope: FIXTURE_MUTATION_SCOPE, sessionPolicy: args[2]!.slice("--session-policy=".length) };
  assertDemoVerificationScope(scope); return scope;
}
export function assertSessionPolicy(rows: readonly DemoSessionMetadata[], policy: DemoSessionPolicy,
  now = Date.now(), minimumRemainingMs = 120_000): void {
  if (!["preserve-existing", "allow-expired-cleanup"].includes(policy) || !Number.isSafeInteger(now)
    || !Number.isSafeInteger(minimumRemainingMs) || minimumRemainingMs < 60_000 || minimumRemainingMs > 600_000
    || rows.some(row => !Number.isSafeInteger(row.userId) || row.userId < 1 || !Number.isSafeInteger(row.createdAt)
      || !Number.isSafeInteger(row.expiresAt) || row.expiresAt <= row.createdAt)) throw new VerificationScopeError("explicit-scope-required");
  // An empty table is valid. Never invent an owner-session row to satisfy a guard.
  if (policy === "preserve-existing" && rows.some(row => row.expiresAt <= now + minimumRemainingMs)) {
    throw new VerificationScopeError("session-preservation-at-risk");
  }
}
/** Reads only actual loopback-demo session metadata, never tokens or credentials.
 * Reuse before each ordinary login; this does not perform cleanup or extend expiry. */
export function preflightDemoSessionPolicy(policy: DemoSessionPolicy, options: { minimumRemainingMs?: number } = {}) {
  const now = Date.now(), minimumRemainingMs = options.minimumRemainingMs ?? 120_000;
  assertSessionPolicy([], policy, now, minimumRemainingMs);
  const db = openDatabase(databaseConfig, { readonly: true });
  try {
    if (!db.readonly) throw new VerificationScopeError("explicit-scope-required");
    const rows = db.prepare("SELECT user_id AS userId,created_at AS createdAt,expires_at AS expiresAt FROM crm_sessions ORDER BY user_id,created_at").all() as DemoSessionMetadata[];
    assertSessionPolicy(rows, policy, now, minimumRemainingMs);
    return { policy, checkedAtUtc: new Date(now).toISOString(), minimumRemainingMs, existingSessions: rows.length,
      earliestExpiryUtc: rows.length ? new Date(Math.min(...rows.map(row => row.expiresAt))).toISOString() : null };
  } finally { db.close(); }
}
