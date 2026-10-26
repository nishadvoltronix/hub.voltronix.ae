import { AsyncLocalStorage } from "node:async_hooks";
import { hashSync } from "bcryptjs";
import { createAuthService, type AuthOptions } from "../../src/auth/service.js";
import type { AuthStore, AuthTransaction, LoginAttempt, StoredSession, StoredUser } from "../../src/auth/store.js";

/** Transient synthetic fixtures only. No filesystem, database, environment or network access. */
export interface FixtureState {
  users: Map<string, StoredUser>;
  grants: Map<string, string[]>;
  sessions: Map<string, StoredSession>;
  attempts: Map<string, LoginAttempt>;
}
export type FixtureOperation = keyof AuthTransaction | "transaction";
const copy = <T>(value: T): T => structuredClone(value);

export class MemoryAuthStore implements AuthStore {
  private state: FixtureState;
  private queue: Promise<void> = Promise.resolve();
  private readonly owner = new AsyncLocalStorage<boolean>();
  private readonly failures = new Map<FixtureOperation, number>();
  readonly calls: FixtureOperation[] = [];

  constructor(initial: FixtureState) { this.state = copy(initial); }
  snapshot(): FixtureState { return copy(this.state); }
  failNext(operation: FixtureOperation): void {
    this.failures.set(operation, (this.failures.get(operation) ?? 0) + 1);
  }
  private operation(name: FixtureOperation): void {
    this.calls.push(name);
    const remaining = this.failures.get(name) ?? 0;
    if (remaining) {
      this.failures.set(name, remaining - 1);
      throw new Error("synthetic-private-store-failure");
    }
  }
  private serialized<T>(work: (draft: FixtureState) => Promise<T>): Promise<T> {
    if (this.owner.getStore()) return Promise.reject(new Error("Nested or escaped fixture transaction refused."));
    const result = this.queue.then(async () => {
      const draft = copy(this.state);
      const answer = await this.owner.run(true, () => work(draft));
      this.state = copy(draft);
      return answer;
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  /** Test-only state change. It participates in the same serialization boundary. */
  mutate(work: (state: FixtureState) => void | Promise<void>): Promise<void> {
    return this.serialized(async state => { await work(state); });
  }
  transaction<T>(work: (transaction: AuthTransaction) => Promise<T>): Promise<T> {
    return this.serialized(async state => {
      this.operation("transaction");
      let active = true;
      const check = (name: FixtureOperation) => {
        if (!active) throw new Error("Expired fixture transaction refused.");
        this.operation(name);
      };
      const tx: AuthTransaction = {
        async findUserByEmail(email) {
          check("findUserByEmail");
          return copy([...state.users.values()].find(user => user.email === email) ?? null);
        },
        async findUserById(id) { check("findUserById"); return copy(state.users.get(id) ?? null); },
        async permissionsFor(id) { check("permissionsFor"); return copy(state.grants.get(id) ?? []); },
        async getSession(tokenHash) { check("getSession"); return copy(state.sessions.get(tokenHash) ?? null); },
        async insertSession(session) {
          check("insertSession");
          if (state.sessions.has(session.tokenHash)) throw new Error("Duplicate synthetic token hash.");
          state.sessions.set(session.tokenHash, copy(session));
        },
        async deleteSession(tokenHash) { check("deleteSession"); state.sessions.delete(tokenHash); },
        async deleteExpiredSessions(cutoff) {
          check("deleteExpiredSessions");
          for (const [key, value] of state.sessions) if (value.expiresAt <= cutoff) state.sessions.delete(key);
        },
        async updateSessionCsrf(tokenHash, csrfHash) {
          check("updateSessionCsrf");
          const session = state.sessions.get(tokenHash);
          if (!session) throw new Error("Synthetic session disappeared.");
          session.csrfHash = csrfHash;
        },
        async pruneAttempts(cutoff) {
          check("pruneAttempts");
          for (const [key, value] of state.attempts) if (value.windowStart <= cutoff) state.attempts.delete(key);
        },
        async getAttempt(bucket) { check("getAttempt"); return copy(state.attempts.get(bucket) ?? null); },
        async incrementAttempt(bucket, windowStart) {
          check("incrementAttempt");
          const attempt = state.attempts.get(bucket);
          if (attempt) attempt.attempts++;
          else state.attempts.set(bucket, { attempts: 1, windowStart });
        },
      };
      try { return await work(tx); }
      finally { active = false; }
    });
  }
}

export interface FixtureOptions {
  password?: string;
  user?: Partial<StoredUser>;
  grants?: readonly string[];
  now?: number;
  verifyPassword?: AuthOptions["verifyPassword"];
}
export function createFixture(options: FixtureOptions = {}) {
  const password = options.password ?? "Synthetic password Å-42";
  const user: StoredUser = {
    localUserId: "9007199254740993", externalUserId: "synthetic-external-user",
    username: "Synthetic test identity", email: "fixture@example.invalid",
    passwordHash: hashSync(password, 4), status: "active", ...options.user,
  };
  const store = new MemoryAuthStore({ users: new Map([[user.localUserId, user]]),
    grants: new Map([[user.localUserId, [...(options.grants ?? ["leads.view"])]]]),
    sessions: new Map(), attempts: new Map() });
  let currentTime = options.now ?? 1_800_000_000_000;
  const service = createAuthService(store, { now: () => currentTime,
    ...(options.verifyPassword ? { verifyPassword: options.verifyPassword } : {}) });
  return { store, service, user: copy(user), password,
    snapshot: () => store.snapshot(),
    mutate: (work: (state: FixtureState) => void | Promise<void>) => store.mutate(work),
    failNext: (operation: FixtureOperation) => store.failNext(operation),
    setNow: (value: number) => { currentTime = value; },
    now: () => currentTime,
    advance: (milliseconds: number) => { currentTime += milliseconds; },
    patchUser: (patch: Partial<StoredUser>) => store.mutate(state => {
      const current = state.users.get(user.localUserId);
      if (!current) throw new Error("Missing synthetic test identity.");
      Object.assign(current, patch);
    }),
    setGrants: (grants: readonly string[]) => store.mutate(state => {
      state.grants.set(user.localUserId, [...grants]);
    }),
  };
}
