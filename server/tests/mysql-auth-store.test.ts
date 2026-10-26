import assert from "node:assert/strict";
import { test } from "node:test";
import { hashSync } from "bcryptjs";
import { AuthError, authFailure } from "../src/auth/errors.js";
import { createMysqlAuthStore } from "../src/auth/mysql-store.js";
import { createAuthService, SESSION_LIFETIME_MS } from "../src/auth/service.js";
import type { AuthTransaction, StoredSession } from "../src/auth/store.js";
import { digest, newToken } from "../src/auth/tokens.js";
import type { MysqlAuthDatabase, MysqlAuthSqlTransaction } from "../src/db/mysql/database.js";

// Scripted wire contract only: no driver, socket, file or real database. Transaction
// callback counters below are NOT evidence of actual InnoDB commit/rollback behavior.
interface Step {
  sql: string | RegExp;
  values: readonly unknown[] | ((values: readonly unknown[]) => void);
  result?: unknown | ((values: readonly unknown[]) => unknown);
  fail?: boolean;
}
function scripted(steps: Step[] = []) {
  let commits = 0, rollbacks = 0, transactions = 0;
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const wire: MysqlAuthSqlTransaction = {
    async execute(sql, values = []) {
      calls.push({ sql, values: [...values] });
      const step = steps.shift();
      assert.ok(step, "Unexpected SQL contract operation");
      if (typeof step.sql === "string") assert.equal(sql, step.sql); else assert.match(sql, step.sql);
      if (typeof step.values === "function") step.values(values); else assert.deepEqual(values, step.values);
      if (step.fail) throw new Error("synthetic-private-driver-error");
      return [typeof step.result === "function" ? step.result(values) : step.result, []];
    },
  };
  const database: MysqlAuthDatabase = {
    async transaction<T>(work: (sql: MysqlAuthSqlTransaction) => Promise<T>): Promise<T> {
      transactions++;
      try { const result = await work(wire); commits++; return result; }
      catch (error) { rollbacks++; throw error; }
    },
  };
  return { store: createMysqlAuthStore(database), database, calls,
    stats: () => ({ commits, rollbacks, transactions }),
    done() { assert.equal(steps.length, 0, "Unconsumed SQL contract operations"); } };
}
const localId = "9007199254740993";
const timestamp = 1_780_000_000_000;
const password = "Synthetic isolated auth adapter password";
const passwordHash = hashSync(password, 4);
const storedUser = { local_id: localId, user_id: "synthetic-external-identity", username: "Synthetic fixture",
  email: "adapter@example.invalid", password: passwordHash, status: "active" };
const header = (affectedRows = 1, warningStatus = 0) => ({ affectedRows, warningStatus });
const userColumns = "CAST(id AS CHAR) AS local_id, user_id, username, email, password, status";
const userByEmail = `SELECT ${userColumns} FROM users WHERE email = ? LIMIT 2`;
const userById = `SELECT ${userColumns} FROM users WHERE id = ? LIMIT 2`;
const sessionSql = "SELECT token_hash, CAST(user_id AS CHAR) AS user_id, csrf_hash, password_fingerprint, created_at, expires_at FROM crm_sessions WHERE token_hash = ? LIMIT 2";
const grantsSql = "SELECT p.`key` FROM permissions p JOIN admin_user_permissions a ON a.permission_id = p.id WHERE a.admin_user_id = ? ORDER BY p.`key`";
const sessionToken = newToken();
const csrfToken = newToken();
const storedSession = { token_hash: digest(sessionToken), user_id: localId, csrf_hash: digest(csrfToken),
  password_fingerprint: digest(passwordHash), created_at: String(timestamp), expires_at: String(timestamp + SESSION_LIFETIME_MS) };
const sessionValue: StoredSession = { tokenHash: storedSession.token_hash, userId: localId, csrfHash: storedSession.csrf_hash,
  passwordFingerprint: storedSession.password_fingerprint, createdAt: timestamp, expiresAt: timestamp + SESSION_LIFETIME_MS };
const globalBucket = `client:${digest("web")}`;
const accountBucket = `account:${digest(storedUser.email)}`;
function status(expected: number) {
  return (error: unknown) => {
    assert.equal(authFailure(error).status, expected);
    assert.equal(String(error).includes("synthetic-private"), false);
    return true;
  };
}
function sessionSteps(overrides: Record<string, unknown> = {}, userOverrides: Record<string, unknown> = {}): Step[] {
  return [
    { sql: sessionSql, values: [digest(sessionToken)], result: [{ ...storedSession, ...overrides }] },
    { sql: userById, values: [localId], result: [{ ...storedUser, ...userOverrides }] },
  ];
}
function attemptSteps(): Step[] {
  return [
    { sql: "DELETE FROM crm_login_attempts WHERE window_start <= ?", values: [timestamp - 900_000], result: header(0) },
    ...[globalBucket, accountBucket].flatMap(bucket => [
      { sql: "SELECT window_start, attempts FROM crm_login_attempts WHERE bucket = ? LIMIT 2", values: [bucket], result: [] },
      { sql: "INSERT INTO crm_login_attempts(bucket, window_start, attempts) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE attempts = attempts + 1",
        values: [bucket, timestamp], result: header() },
    ]),
  ];
}

test("offline MySQL auth adapter construction is inert and has no store fallback", () => {
  const f = scripted();
  assert.equal(typeof f.store.transaction, "function");
  assert.deepEqual(f.stats(), { commits: 0, rollbacks: 0, transactions: 0 });
  assert.deepEqual(f.calls, []);
});

test("offline user lookup keeps hostile text exclusively in the prepared values", async () => {
  const email = "' OR 1=1; DROP TABLE users; --@example.invalid";
  const f = scripted([{ sql: userByEmail, values: [email], result: [{ ...storedUser, email }] }]);
  const found = await f.store.transaction(tx => tx.findUserByEmail(email));
  assert.equal(found?.email, email);
  assert.equal(found?.localUserId, localId);
  assert.equal(found?.externalUserId, storedUser.user_id);
  assert.equal(f.calls[0]?.sql.includes(email), false);
  assert.equal(f.calls[0]?.sql.includes(passwordHash), false);
  assert.equal(f.calls[0]?.sql.includes("password ="), false);
  f.done();
});

test("offline local signed64 identity remains an exact string, including the maximum", async () => {
  for (const id of ["1", localId, "9223372036854775807"]) {
    const f = scripted([{ sql: userById, values: [id], result: [{ ...storedUser, local_id: id, user_id: null }] }]);
    assert.equal((await f.store.transaction(tx => tx.findUserById(id)))?.localUserId, id);
    f.done();
  }
});

test("offline noncanonical local IDs are refused before issuing any SQL", async () => {
  for (const invalid of ["0", "01", "-1", "1.0", "1e3", "1 OR 1=1", "9223372036854775808", 1, null, undefined]) {
    const f = scripted();
    await assert.rejects(f.store.transaction(tx => tx.findUserById(invalid as string)), status(503));
    assert.deepEqual(f.calls, []);
  }
});

test("offline absent users, sessions and attempts return null without invented records", async () => {
  const f = scripted([
    { sql: userByEmail, values: [storedUser.email], result: [] },
    { sql: userById, values: [localId], result: [] },
    { sql: sessionSql, values: [storedSession.token_hash], result: [] },
    { sql: /SELECT window_start, attempts/, values: [globalBucket], result: [] },
  ]);
  await f.store.transaction(async tx => {
    assert.equal(await tx.findUserByEmail(storedUser.email), null);
    assert.equal(await tx.findUserById(localId), null);
    assert.equal(await tx.getSession(storedSession.token_hash), null);
    assert.equal(await tx.getAttempt(globalBucket), null);
  });
  f.done();
});

test("offline duplicate singleton query results fail closed instead of choosing a row", async () => {
  const scenarios: { sql: RegExp; values: unknown[]; result: unknown[]; work: (tx: AuthTransaction) => Promise<unknown> }[] = [
    { sql: /FROM users WHERE email/, values: [storedUser.email], result: [storedUser, storedUser], work: tx => tx.findUserByEmail(storedUser.email) },
    { sql: /FROM users WHERE id/, values: [localId], result: [storedUser, storedUser], work: tx => tx.findUserById(localId) },
    { sql: /FROM crm_sessions/, values: [storedSession.token_hash], result: [storedSession, storedSession], work: tx => tx.getSession(storedSession.token_hash) },
    { sql: /FROM crm_login_attempts/, values: [globalBucket], result: [{ window_start: timestamp, attempts: 1 }, { window_start: timestamp, attempts: 1 }], work: tx => tx.getAttempt(globalBucket) },
  ];
  for (const scenario of scenarios) {
    const f = scripted([scenario]);
    await assert.rejects(f.store.transaction(scenario.work), status(503));
    assert.equal(f.stats().rollbacks, 1);
    f.done();
  }
});

test("offline malformed user rows and changed lookup identities fail closed", async () => {
  const invalidRows = [null, 1, [], {}, { ...storedUser, local_id: 9007199254740992 },
    { ...storedUser, local_id: "1" }, { ...storedUser, local_id: "9223372036854775808" },
    { ...storedUser, user_id: 1 }, { ...storedUser, username: null }, { ...storedUser, email: 1 },
    { ...storedUser, password: Buffer.from("synthetic-private") }, { ...storedUser, status: "admin" },
    { ...storedUser, username: "x".repeat(121) }, { ...storedUser, email: "bad\0email" }];
  for (const row of invalidRows) {
    const f = scripted([{ sql: userById, values: [localId], result: [row] }]);
    await assert.rejects(f.store.transaction(tx => tx.findUserById(localId)), status(503));
    f.done();
  }
});

test("offline session decoding accepts safe BIGINT string timestamps and rejects corruption", async () => {
  const valid = scripted([{ sql: sessionSql, values: [storedSession.token_hash], result: [storedSession] }]);
  assert.deepEqual(await valid.store.transaction(tx => tx.getSession(storedSession.token_hash)), sessionValue);
  valid.done();
  for (const changed of [{ user_id: 1 }, { created_at: "9007199254740992" }, { created_at: "01" },
    { created_at: "1e3" }, { created_at: -1 }, { created_at: 1.1 }, { expires_at: timestamp },
    { expires_at: Number.POSITIVE_INFINITY }, { csrf_hash: "bad" }, { password_fingerprint: null },
    { token_hash: "a".repeat(64) }]) {
    const f = scripted([{ sql: sessionSql, values: [storedSession.token_hash], result: [{ ...storedSession, ...changed }] }]);
    await assert.rejects(f.store.transaction(tx => tx.getSession(storedSession.token_hash)), status(503));
    f.done();
  }
});

test("offline session creation sends only hashes, exact string ID and fixed timestamps", async () => {
  const f = scripted([{ sql: "INSERT INTO crm_sessions(token_hash, user_id, csrf_hash, password_fingerprint, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    values: [sessionValue.tokenHash, localId, sessionValue.csrfHash, sessionValue.passwordFingerprint, timestamp, timestamp + SESSION_LIFETIME_MS], result: header() }]);
  await f.store.transaction(tx => tx.insertSession(sessionValue));
  assert.equal(JSON.stringify(f.calls).includes(sessionToken), false);
  assert.equal(JSON.stringify(f.calls).includes(csrfToken), false);
  assert.equal(JSON.stringify(f.calls).includes(passwordHash), false);
  f.done();
});

test("offline invalid session input, token hashes and throttle buckets issue no SQL", async () => {
  const work: ((tx: AuthTransaction) => Promise<unknown>)[] = [
    tx => tx.insertSession({ ...sessionValue, expiresAt: timestamp }),
    tx => tx.insertSession({ ...sessionValue, userId: "01" }),
    tx => tx.insertSession({ ...sessionValue, csrfHash: csrfToken }),
    tx => tx.getSession(sessionToken), tx => tx.deleteSession("A".repeat(64)),
    tx => tx.updateSessionCsrf(sessionValue.tokenHash, "bad"),
    tx => tx.getAttempt("arbitrary-user-input"), tx => tx.incrementAttempt(globalBucket, -1),
    tx => tx.deleteExpiredSessions(Number.NaN), tx => tx.pruneAttempts(Number.POSITIVE_INFINITY),
  ];
  for (const operation of work) {
    const f = scripted();
    await assert.rejects(f.store.transaction(operation), status(503));
    assert.deepEqual(f.calls, []);
  }
});

test("offline session revocation is idempotent and expiry cleanup uses the inclusive cutoff", async () => {
  const f = scripted([
    { sql: "DELETE FROM crm_sessions WHERE token_hash = ?", values: [sessionValue.tokenHash], result: header() },
    { sql: "DELETE FROM crm_sessions WHERE token_hash = ?", values: [sessionValue.tokenHash], result: header(0) },
    { sql: "DELETE FROM crm_sessions WHERE expires_at <= ?", values: [timestamp], result: header(4) },
  ]);
  await f.store.transaction(async tx => {
    await tx.deleteSession(sessionValue.tokenHash);
    await tx.deleteSession(sessionValue.tokenHash);
    await tx.deleteExpiredSessions(timestamp);
  });
  f.done();
});

test("offline CSRF rotation updates only its hash and never extends session expiry", async () => {
  const replacement = digest(newToken());
  const f = scripted([{ sql: "UPDATE crm_sessions SET csrf_hash = ? WHERE token_hash = ?", values: [replacement, sessionValue.tokenHash], result: header() }]);
  await f.store.transaction(tx => tx.updateSessionCsrf(sessionValue.tokenHash, replacement));
  assert.equal(f.calls[0]?.sql.includes("expires_at"), false);
  f.done();
});

test("offline attempts decode safe counts and upsert preserves the original window", async () => {
  const f = scripted([
    { sql: "DELETE FROM crm_login_attempts WHERE window_start <= ?", values: [timestamp - 900_000], result: header(2) },
    { sql: "SELECT window_start, attempts FROM crm_login_attempts WHERE bucket = ? LIMIT 2", values: [accountBucket], result: [{ window_start: String(timestamp), attempts: 4 }] },
    { sql: "INSERT INTO crm_login_attempts(bucket, window_start, attempts) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE attempts = attempts + 1", values: [accountBucket, timestamp + 100], result: header(2) },
  ]);
  await f.store.transaction(async tx => {
    await tx.pruneAttempts(timestamp - 900_000);
    assert.deepEqual(await tx.getAttempt(accountBucket), { windowStart: timestamp, attempts: 4 });
    await tx.incrementAttempt(accountBucket, timestamp + 100);
  });
  assert.equal(f.calls[2]?.sql.split("ON DUPLICATE KEY UPDATE")[1]?.includes("window_start"), false);
  f.done();
});

test("offline invalid attempt counters and window metadata fail closed", async () => {
  for (const changed of [{ attempts: -1 }, { attempts: 1.5 }, { attempts: "01" }, { attempts: 2_147_483_648 },
    { attempts: null }, { window_start: "9007199254740992" }, { window_start: "1.0" }, { window_start: -1 }]) {
    const f = scripted([{ sql: /SELECT window_start, attempts/, values: [globalBucket], result: [{ window_start: timestamp, attempts: 1, ...changed }] }]);
    await assert.rejects(f.store.transaction(tx => tx.getAttempt(globalBucket)), status(503));
    f.done();
  }
});

test("offline permissions use local-user prepared joins and return fresh detached grant lists", async () => {
  const source = [{ key: "leads.view" }, { key: "unknown.policy" }];
  const f = scripted([{ sql: grantsSql, values: [localId], result: source }, { sql: grantsSql, values: [localId], result: [] }]);
  const first = await f.store.transaction(tx => tx.permissionsFor(localId));
  first.push("users.write");
  assert.equal(source.length, 2);
  assert.deepEqual(await f.store.transaction(tx => tx.permissionsFor(localId)), []);
  f.done();
});

test("offline corrupt, duplicate and ambiguous grant rows fail closed", async () => {
  for (const result of [[{ key: "leads.view" }, { key: "leads.view" }], [{ key: "" }], [{ key: null }], [{ key: 1 }], [{ key: "x".repeat(121) }], [null], header()]) {
    const f = scripted([{ sql: grantsSql, values: [localId], result }]);
    await assert.rejects(f.store.transaction(tx => tx.permissionsFor(localId)), status(503));
    f.done();
  }
});

test("offline mutation row counts and SQL warnings are not accepted as successful writes", async () => {
  for (const result of [null, [], {}, header(2), header(-1), header(0), header(1.5), header(1, 1)]) {
    const f = scripted([{ sql: /^INSERT INTO crm_sessions/, values: () => {}, result }]);
    await assert.rejects(f.store.transaction(tx => tx.insertSession(sessionValue)), status(503));
    assert.equal(f.stats().rollbacks, 1);
    f.done();
  }
  const f = scripted([{ sql: /^DELETE FROM crm_sessions/, values: [sessionValue.tokenHash], result: header(2) }]);
  await assert.rejects(f.store.transaction(tx => tx.deleteSession(sessionValue.tokenHash)), status(503));
  f.done();
});

test("offline driver failures and malformed result containers become opaque unavailable errors", async () => {
  for (const step of [{ fail: true }, { result: header() }, { result: "synthetic-private" }]) {
    const f = scripted([{ sql: userByEmail, values: [storedUser.email], ...step }]);
    await assert.rejects(f.store.transaction(tx => tx.findUserByEmail(storedUser.email)), status(503));
    assert.equal(f.stats().commits, 0);
    assert.equal(f.stats().rollbacks, 1);
    f.done();
  }
});

test("offline transaction failure is sanitized while sealed service denials keep their status", async () => {
  const unavailable = createMysqlAuthStore({ async transaction() { throw new Error("synthetic-private-connection-password"); } });
  await assert.rejects(unavailable.transaction(async () => null), status(503));
  const f = scripted();
  await assert.rejects(f.store.transaction(async () => { throw new AuthError("denied"); }), status(403));
  await assert.rejects(f.store.transaction(async () => { throw new Error("synthetic-private-callback"); }), status(503));
  assert.equal(f.stats().rollbacks, 2);
});

test("offline real bcrypt service issues session through MySQL adapter and atomically requests prior revocation", async () => {
  let inserted: readonly unknown[] | undefined;
  const oldToken = newToken();
  const f = scripted([...attemptSteps(),
    { sql: userByEmail, values: [storedUser.email], result: [storedUser] },
    { sql: userByEmail, values: [storedUser.email], result: [storedUser] },
    { sql: "DELETE FROM crm_sessions WHERE expires_at <= ?", values: [timestamp], result: header(0) },
    { sql: /^INSERT INTO crm_sessions/, values: values => { inserted = [...values]; }, result: header() },
    { sql: "DELETE FROM crm_sessions WHERE token_hash = ?", values: [digest(oldToken)], result: header() },
    { sql: grantsSql, values: [localId], result: [{ key: "leads.view" }] },
  ]);
  const result = await createAuthService(f.store, { now: () => timestamp }).login(storedUser.email, password, oldToken);
  assert.equal(result.user.localUserId, localId);
  assert.deepEqual(result.user.permissions, ["leads.view"]);
  assert.equal(result.expiresAt, timestamp + SESSION_LIFETIME_MS);
  assert.notEqual(result.sessionToken, oldToken);
  assert.deepEqual(inserted, [digest(result.sessionToken), localId, digest(result.csrfToken), digest(passwordHash), timestamp, result.expiresAt]);
  assert.deepEqual(f.stats(), { commits: 3, rollbacks: 0, transactions: 3 });
  f.done();
});

test("offline MySQL adapter service denies bad credentials without issuing sessions", async () => {
  const f = scripted([...attemptSteps(), { sql: userByEmail, values: [storedUser.email], result: [storedUser] }]);
  await assert.rejects(createAuthService(f.store, { now: () => timestamp }).login(storedUser.email, "Wrong synthetic password"), status(401));
  assert.equal(f.calls.some(call => call.sql.includes("INSERT INTO crm_sessions")), false);
  f.done();
});

test("offline MySQL adapter service checks fresh grants and denies revoked permission", async () => {
  const f = scripted([...sessionSteps(), { sql: grantsSql, values: [localId], result: [{ key: "leads.view" }] },
    ...sessionSteps(), { sql: grantsSql, values: [localId], result: [] }]);
  const service = createAuthService(f.store, { now: () => timestamp + 1 });
  assert.equal((await service.authorize(sessionToken, ["leads.view"])).localUserId, localId);
  await assert.rejects(service.authorize(sessionToken, ["leads.view"]), status(403));
  f.done();
});

test("offline MySQL adapter service rejects expired, disabled and changed-password sessions and revokes them", async () => {
  for (const scenario of [{ now: timestamp + SESSION_LIFETIME_MS, user: {} },
    { now: timestamp, user: { status: "inactive" } }, { now: timestamp, user: { password: "unsupported-changed-hash" } }]) {
    const f = scripted([...sessionSteps({}, scenario.user),
      { sql: "DELETE FROM crm_sessions WHERE token_hash = ?", values: [storedSession.token_hash], result: header() }]);
    assert.equal(await createAuthService(f.store, { now: () => scenario.now }).authenticate(sessionToken), null);
    assert.equal(f.calls.some(call => call.sql === grantsSql), false);
    f.done();
  }
});

test("offline MySQL adapter service validates bound CSRF and logout replay becomes unauthenticated", async () => {
  const f = scripted([...sessionSteps(), ...sessionSteps(),
    { sql: "DELETE FROM crm_sessions WHERE token_hash = ?", values: [storedSession.token_hash], result: header() },
    { sql: sessionSql, values: [storedSession.token_hash], result: [] }]);
  const service = createAuthService(f.store, { now: () => timestamp });
  assert.equal(await service.verifySessionCsrf(sessionToken, csrfToken), true);
  assert.equal(await service.verifySessionCsrf(sessionToken, newToken()), false);
  await service.logout(sessionToken);
  assert.equal(await service.authenticate(sessionToken), null);
  f.done();
});

test("offline MySQL adapter service returns unavailable for late grant failure after insert/revoke requests", async () => {
  const f = scripted([...attemptSteps(),
    { sql: userByEmail, values: [storedUser.email], result: [storedUser] },
    { sql: userByEmail, values: [storedUser.email], result: [storedUser] },
    { sql: "DELETE FROM crm_sessions WHERE expires_at <= ?", values: [timestamp], result: header(0) },
    { sql: /^INSERT INTO crm_sessions/, values: () => {}, result: header() },
    { sql: "DELETE FROM crm_sessions WHERE token_hash = ?", values: [digest(sessionToken)], result: header() },
    { sql: grantsSql, values: [localId], fail: true },
  ]);
  await assert.rejects(createAuthService(f.store, { now: () => timestamp }).login(storedUser.email, password, sessionToken), status(503));
  assert.deepEqual(f.stats(), { commits: 2, rollbacks: 1, transactions: 3 });
  f.done();
});
