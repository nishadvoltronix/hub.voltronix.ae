/** Gated-runner helpers only. Importing this module opens no socket and changes no
 * data. The outer runner proves approval, fresh schema, accounts and full DDL.
 * No fixture is an administrator, a runtime seed, or historical CRM data. */
import { randomBytes } from "node:crypto";
import { hash } from "bcryptjs";
import { authFailure } from "../../src/auth/errors.js";
import { createMysqlAuthStore } from "../../src/auth/mysql-store.js";
import { createAuthService, LOGIN_WINDOW_MS, SESSION_LIFETIME_MS } from "../../src/auth/service.js";
import { digest, newToken } from "../../src/auth/tokens.js";
import { validateMysqlAuthConfig, type MysqlAuthConfig } from "../../src/db/mysql/config.js";
import { createMysqlAuthDatabase } from "../../src/db/mysql/database.js";
import { connectMysqlAuth, type MysqlAuthConnector, type MysqlAuthWireConnection } from "../../src/db/mysql/driver.js";
import { mysqlExpectedTables } from "../../src/db/mysql/schema.js";

const fixtureNames = ["allowed", "denied", "bcryptA", "bcryptY", "concurrent", "httpAllowed", "httpDenied"] as const;
type FixtureName = typeof fixtureNames[number];
type Row = Record<string, unknown>;
export interface FixtureUser { readonly id: string; readonly email: string }
export type SyntheticFixture = Readonly<Record<FixtureName, FixtureUser> & {
  fixtureId: string; database: string; password: string; permissionId: string;
}>;
interface Ownership {
  database: string; marker: string; consumed: boolean;
  users: Map<string, Row>; permission: Row; grants: Map<string, Row>;
  sessions: Map<string, readonly unknown[]>; attempts: Map<string, { window: number; count: number }>;
  allowedBuckets: Set<string>;
}
const owners = new WeakMap<SyntheticFixture, Ownership>();
const refusal = () => new Error("Synthetic authentication fixture refused; preserve the isolated target for review.");
function ensure(value: unknown): asserts value { if (!value) throw refusal(); }
function rows(value: unknown): Row[] {
  ensure(Array.isArray(value) && value.every(row => row && typeof row === "object" && !Array.isArray(row)));
  return value as Row[];
}
async function select(connection: MysqlAuthWireConnection, sql: string, values: readonly unknown[] = []) {
  try { return rows((await connection.execute(sql, values))[0]); }
  catch { throw refusal(); }
}
function id(value: unknown): string {
  const text = String(value);
  ensure(/^[1-9][0-9]{0,18}$/.test(text) && BigInt(text) <= 9_223_372_036_854_775_807n);
  return text;
}
function fingerprint(row: Row): string {
  return JSON.stringify(Object.keys(row).sort().map(key => [key, row[key]]));
}
function ownership(fixture: SyntheticFixture): Ownership {
  const owner = owners.get(fixture);
  ensure(owner && !owner.consumed);
  return owner;
}
async function target(connection: MysqlAuthWireConnection, database: string): Promise<void> {
  const found = await select(connection, "SELECT DATABASE() AS selected_database");
  ensure(found.length === 1 && found[0]?.selected_database === database);
}
async function lock(connection: MysqlAuthWireConnection): Promise<void> {
  const found = await select(connection, "SELECT id FROM crm_app_lock WHERE id=1 FOR UPDATE");
  ensure(found.length === 1 && String(found[0]?.id) === "1");
}
async function count(connection: MysqlAuthWireConnection, table: typeof mysqlExpectedTables[number]): Promise<number> {
  // The identifier comes exclusively from the immutable compiled schema allowlist.
  const found = await select(connection, `SELECT COUNT(*) AS total FROM \`${table}\``);
  ensure(found.length === 1 && /^(0|[1-9][0-9]*)$/.test(String(found[0]?.total)));
  const value = Number(found[0]?.total);
  ensure(Number.isSafeInteger(value));
  return value;
}
async function changed(connection: MysqlAuthWireConnection, sql: string, values: readonly unknown[]): Promise<void> {
  const [result] = await connection.execute(sql, values);
  ensure(result && typeof result === "object" && !Array.isArray(result)
    && (result as Row).affectedRows === 1 && (result as Row).warningStatus === 0);
}

/** Requires the freshly migrated target to contain ONLY its technical singleton.
 * DML is transactional; this function performs no DDL. Lost commit acknowledgments
 * retain the target; there is no cleanup/retry recovery without this live capability. */
export async function createSyntheticFixture(connection: MysqlAuthWireConnection, fixtureId: string): Promise<SyntheticFixture> {
  ensure(/^[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/.test(fixtureId));
  const database = `crm_local_auth_${fixtureId}`;
  await target(connection, database);
  const marker = `synthetic-auth:${fixtureId}:${randomBytes(12).toString("hex")}`;
  const password = randomBytes(32).toString("base64url");
  const passwordHash = await hash(password, 4); // Synthetic speed-only cost; no production password writes.
  const users = new Map<string, Row>(), grants = new Map<string, Row>();
  const identities = {} as Record<FixtureName, FixtureUser>;
  let commitStarted = false;
  await connection.beginTransaction();
  try {
    await lock(connection);
    for (const table of mysqlExpectedTables) ensure(await count(connection, table) === (table === "crm_app_lock" ? 1 : 0));
    for (const name of fixtureNames) {
      const email = `${name.toLowerCase()}.${fixtureId}@example.invalid`;
      const externalId = `auth-fixture:${fixtureId}:${name}`;
      const username = `${marker}:${name}`;
      const storedHash = name === "bcryptA" ? passwordHash.replace("$2b$", "$2a$")
        : name === "bcryptY" ? passwordHash.replace("$2b$", "$2y$") : passwordHash;
      await changed(connection,
        "INSERT INTO users(user_id,username,email,password,status,role) VALUES(?,?,?,?,'active','fixture-nonadmin')",
        [externalId, username, email, storedHash]);
      const found = await select(connection, "SELECT * FROM users WHERE user_id=? AND email=? AND username=?", [externalId, email, username]);
      ensure(found.length === 1);
      const userId = id(found[0]!.id);
      users.set(userId, found[0]!);
      identities[name] = Object.freeze({ id: userId, email });
    }
    await changed(connection, "INSERT INTO permissions(`key`,label) VALUES(?,?)", ["dashboard.view", marker]);
    const permissions = await select(connection, "SELECT * FROM permissions WHERE `key`=? AND label=?", ["dashboard.view", marker]);
    ensure(permissions.length === 1);
    const permission = permissions[0]!, permissionId = id(permission.id);
    for (const name of ["allowed", "httpAllowed"] as const) {
      await changed(connection, "INSERT INTO admin_user_permissions(admin_user_id,permission_id) VALUES(?,?)", [identities[name].id, permissionId]);
      const found = await select(connection, "SELECT * FROM admin_user_permissions WHERE admin_user_id=? AND permission_id=?", [identities[name].id, permissionId]);
      ensure(found.length === 1); grants.set(id(found[0]!.id), found[0]!);
    }
    commitStarted = true;
    await connection.commit();
    const fixture = Object.freeze({ ...identities, fixtureId, database, password, permissionId });
    const allowedBuckets = new Set([`client:${digest("web")}`, ...fixtureNames.map(name => `account:${digest(identities[name].email)}`),
      `account:${digest(`missing.${fixtureId}@example.invalid`)}`]);
    owners.set(fixture, { database, marker, consumed: false, users, permission, grants, sessions: new Map(), attempts: new Map(), allowedBuckets });
    return fixture;
  } catch {
    if (!commitStarted) { try { await connection.rollback(); } catch { /* preserve failure */ } }
    else connection.destroy();
    throw refusal();
  }
}

/** Observe only our adapter's bound mutation contract, including writes whose
 * commit acknowledgment is lost. No hash/value is returned to logs or reports. */
function observe(owner: Ownership, sql: string, values: readonly unknown[]): void {
  if (sql.startsWith("INSERT INTO crm_sessions(")) {
    ensure(values.length === 6 && typeof values[0] === "string" && owner.users.has(String(values[1])));
    owner.sessions.set(values[0], [...values]);
  } else if (sql.startsWith("UPDATE crm_sessions SET csrf_hash = ?")) {
    const current = owner.sessions.get(String(values[1]));
    ensure(current); owner.sessions.set(String(values[1]), [current[0], current[1], values[0], ...current.slice(3)]);
  } else if (sql.startsWith("DELETE FROM crm_login_attempts WHERE window_start <= ?")) {
    for (const [bucket, entry] of owner.attempts) if (entry.window <= Number(values[0])) owner.attempts.delete(bucket);
  } else if (sql.startsWith("INSERT INTO crm_login_attempts(")) {
    const bucket = String(values[0]); ensure(owner.allowedBuckets.has(bucket));
    const existing = owner.attempts.get(bucket);
    owner.attempts.set(bucket, { window: existing?.window ?? Number(values[1]), count: (existing?.count ?? 0) + 1 });
  }
}
export function createOwnedAuthDatabase(config: MysqlAuthConfig, fixture: SyntheticFixture, options: { connect?: MysqlAuthConnector } = {}) {
  const owner = ownership(fixture), checked = validateMysqlAuthConfig(config);
  ensure(checked.environment === "test" && checked.database === owner.database);
  const connect = options.connect ?? connectMysqlAuth;
  return createMysqlAuthDatabase(checked, { connect: async input => {
    const wire = await connect(input);
    return { ...wire, execute: async (sql, values = []) => {
      // Record issuance before dispatch so an acknowledgment loss cannot erase ownership.
      if (sql.startsWith("INSERT INTO crm_sessions(")) observe(owner, sql, values);
      const result = await wire.execute(sql, values);
      if (!sql.startsWith("INSERT INTO crm_sessions(")) observe(owner, sql, values);
      return result;
    } };
  } });
}

/** Cleanup is optional, single-run and all-or-nothing. Unknown rows or changed
 * markers abort BEFORE deletion. No DROP/TRUNCATE, FK toggles, DDL or wildcard
 * cleanup exists. Failed/uncertain runs should be retained, not cleaned up. */
export async function cleanupSyntheticFixture(connection: MysqlAuthWireConnection, fixture: SyntheticFixture): Promise<{ deletedRows: number }> {
  const owner = ownership(fixture);
  await target(connection, owner.database);
  let committing = false, deletedRows = 0;
  // An exclusive operator window remains required, but ownership must not rely
  // only on the application's technical lock: a fixture writer can bypass it.
  // RR next-key range locks prevent new rows/grants/sessions from appearing after
  // validation and being removed indirectly by the owned user's FK cascades.
  try { await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"); }
  catch { throw refusal(); }
  await connection.beginTransaction();
  try {
    await lock(connection);
    const authTables = new Set(["users", "permissions", "admin_user_permissions", "crm_sessions", "crm_login_attempts"]);
    for (const table of mysqlExpectedTables) if (!authTables.has(table)) {
      const locked = await select(connection, `SELECT 1 AS present FROM \`${table}\` FOR UPDATE`);
      ensure(locked.length === (table === "crm_app_lock" ? 1 : 0));
    }
    const users = await select(connection, "SELECT * FROM users ORDER BY id FOR UPDATE");
    const permissions = await select(connection, "SELECT * FROM permissions ORDER BY id FOR UPDATE");
    const grants = await select(connection, "SELECT * FROM admin_user_permissions ORDER BY id FOR UPDATE");
    const sessions = await select(connection, "SELECT token_hash,CAST(user_id AS CHAR) AS user_id,csrf_hash,password_fingerprint,created_at,expires_at FROM crm_sessions ORDER BY token_hash FOR UPDATE");
    const attempts = await select(connection, "SELECT bucket,window_start,attempts FROM crm_login_attempts ORDER BY bucket FOR UPDATE");
    ensure(users.length === owner.users.size && users.every(row => fingerprint(row) === fingerprint(owner.users.get(id(row.id)) ?? {})));
    ensure(permissions.length === 1 && fingerprint(permissions[0]!) === fingerprint(owner.permission));
    ensure(grants.length === owner.grants.size && grants.every(row => fingerprint(row) === fingerprint(owner.grants.get(id(row.id)) ?? {})));
    for (const row of sessions) {
      const expected = owner.sessions.get(String(row.token_hash));
      ensure(expected && [row.token_hash, row.user_id, row.csrf_hash, row.password_fingerprint, row.created_at, row.expires_at]
        .every((value, index) => String(value) === String(expected[index])));
    }
    for (const row of attempts) {
      const expected = owner.attempts.get(String(row.bucket));
      ensure(expected && String(row.window_start) === String(expected.window) && String(row.attempts) === String(expected.count));
    }
    for (const row of sessions) { await changed(connection, "DELETE FROM crm_sessions WHERE token_hash=? AND user_id=? AND csrf_hash=? AND password_fingerprint=? AND created_at=? AND expires_at=?",
      [row.token_hash, row.user_id, row.csrf_hash, row.password_fingerprint, Number(row.created_at), Number(row.expires_at)]); deletedRows++; }
    for (const row of attempts) { await changed(connection, "DELETE FROM crm_login_attempts WHERE bucket=? AND window_start=? AND attempts=?",
      [row.bucket, Number(row.window_start), Number(row.attempts)]); deletedRows++; }
    for (const row of grants) { await changed(connection, "DELETE FROM admin_user_permissions WHERE id=? AND admin_user_id=? AND permission_id=?", [id(row.id), id(row.admin_user_id), id(row.permission_id)]); deletedRows++; }
    for (const row of users) { await changed(connection, "DELETE FROM users WHERE id=? AND user_id=? AND username=? AND email=? AND password=? AND role='fixture-nonadmin'",
      [id(row.id), row.user_id, row.username, row.email, row.password]); deletedRows++; }
    await changed(connection, "DELETE FROM permissions WHERE id=? AND `key`=? AND label=?", [fixture.permissionId, "dashboard.view", owner.marker]); deletedRows++;
    for (const table of mysqlExpectedTables) ensure(await count(connection, table) === (table === "crm_app_lock" ? 1 : 0));
    committing = true; await connection.commit(); owner.consumed = true;
    return { deletedRows };
  } catch {
    if (!committing) { try { await connection.rollback(); } catch { /* retain */ } }
    else { owner.consumed = true; connection.destroy(); }
    throw refusal();
  }
}

async function expectFailure(operation: () => Promise<unknown>, status: number): Promise<void> {
  let failed = false;
  try { await operation(); } catch (error) { failed = true; ensure(authFailure(error).status === status); }
  ensure(failed);
}
export interface AuthCaseOptions {
  runtimeConfig: MysqlAuthConfig; fixtureConnection: MysqlAuthWireConnection; fixture: SyntheticFixture;
  record: (name: string, kind: "mysql" | "fault-injection") => void;
}

/** These are real-wire cases, NEVER called by ordinary npm test. An explicit
 * connector argument exists solely for offline orchestration tests; no env switch
 * selects a fake store. Clock/fault cases are labeled, not claimed as restart proof. */
export async function runAuthCases(input: AuthCaseOptions, dependencies: { connect?: MysqlAuthConnector } = {}): Promise<{ checks: number }> {
  const { runtimeConfig, fixtureConnection: operator, fixture, record } = input;
  const owner = ownership(fixture), connect = dependencies.connect ?? connectMysqlAuth;
  const database = createOwnedAuthDatabase(runtimeConfig, fixture, { connect });
  let timestamp = Date.now(), checks = 0;
  const service = createAuthService(createMysqlAuthStore(database), { now: () => timestamp });
  const done = (name: string, kind: "mysql" | "fault-injection" = "mysql") => { checks++; record(name, kind); timestamp += LOGIN_WINDOW_MS + 1; };
  const login = (user: FixtureUser) => service.login(user.email, fixture.password);
  async function changeUser(user: FixtureUser, field: "status" | "password", value: string) {
    const row = owner.users.get(user.id)!;
    await changed(operator, `UPDATE users SET ${field}=? WHERE id=? AND username=?`, [value, user.id, row.username]);
    row[field] = value;
  }
  try {
    for (const name of ["allowed", "bcryptA", "bcryptY"] as const) {
      const signed = await login(fixture[name]);
      ensure((await service.authenticate(signed.sessionToken))?.localUserId === fixture[name].id);
      done(`bcrypt-${name === "allowed" ? "2b" : name === "bcryptA" ? "2a" : "2y"}-login`);
    }
    await expectFailure(() => service.login(fixture.allowed.email, "deliberately-invalid-synthetic-password"), 401);
    await expectFailure(() => service.login(`missing.${fixture.fixtureId}@example.invalid`, fixture.password), 401);
    const deniedHash = String(owner.users.get(fixture.denied.id)!.password);
    await changeUser(fixture.denied, "password", "unsupported-synthetic-format");
    await expectFailure(() => login(fixture.denied), 401);
    await changeUser(fixture.denied, "password", deniedHash);
    done("invalid-and-missing-credentials");
    const signed = await login(fixture.allowed), denied = await login(fixture.denied);
    await service.authorize(signed.sessionToken, ["dashboard.view"]);
    await expectFailure(() => service.authorize(denied.sessionToken, ["dashboard.view"]), 403);
    await expectFailure(() => service.authorize(signed.sessionToken, ["dashboard.view", "users.write"]), 403);
    const grant = [...owner.grants.values()].find(row => String(row.admin_user_id) === fixture.allowed.id)!;
    await changed(operator, "DELETE FROM admin_user_permissions WHERE id=? AND admin_user_id=? AND permission_id=?", [id(grant.id), fixture.allowed.id, fixture.permissionId]);
    await expectFailure(() => service.authorize(signed.sessionToken, ["dashboard.view"]), 403);
    await changed(operator, "INSERT INTO admin_user_permissions(id,admin_user_id,permission_id) VALUES(?,?,?)", [id(grant.id), fixture.allowed.id, fixture.permissionId]);
    done("fresh-permissions-and-denial");
    const original = await login(fixture.allowed);
    const rotated = await service.login(fixture.allowed.email, fixture.password, original.sessionToken);
    ensure(rotated.sessionToken !== original.sessionToken && await service.authenticate(original.sessionToken) === null);
    ensure(await service.verifySessionCsrf(rotated.sessionToken, rotated.csrfToken));
    const csrf = newToken(); ensure(await service.setSessionCsrf(rotated.sessionToken, csrf));
    ensure(!await service.verifySessionCsrf(rotated.sessionToken, rotated.csrfToken));
    ensure(await service.verifySessionCsrf(rotated.sessionToken, csrf));
    done("session-fixation-rotation-and-csrf");
    const loggingOut = await login(fixture.allowed); await service.logout(loggingOut.sessionToken);
    ensure(await service.authenticate(loggingOut.sessionToken) === null);
    await expectFailure(() => service.authorize(loggingOut.sessionToken, ["dashboard.view"]), 401);
    done("logout-and-revoked-replay");
    const expiring = await login(fixture.allowed);
    timestamp = expiring.expiresAt - 1; ensure(await service.authenticate(expiring.sessionToken));
    timestamp = expiring.expiresAt; ensure(await service.authenticate(expiring.sessionToken) === null);
    timestamp--; ensure(await service.authenticate(expiring.sessionToken) === null); timestamp++;
    done("absolute-expiry-with-injected-service-clock", "fault-injection");
    const disabling = await login(fixture.allowed);
    await changeUser(fixture.allowed, "status", "inactive");
    ensure(await service.authenticate(disabling.sessionToken) === null);
    await expectFailure(() => login(fixture.allowed), 401);
    await changeUser(fixture.allowed, "status", "active");
    ensure(await service.authenticate(disabling.sessionToken) === null);
    done("disabled-account-and-reactivation-replay");
    const changing = await login(fixture.allowed), oldHash = String(owner.users.get(fixture.allowed.id)!.password);
    await changeUser(fixture.allowed, "password", await hash(newToken(), 4));
    ensure(await service.authenticate(changing.sessionToken) === null);
    await changeUser(fixture.allowed, "password", oldHash);
    ensure(await service.authenticate(changing.sessionToken) === null);
    done("changed-password-invalidates-session");
    const secondDatabase = createOwnedAuthDatabase(runtimeConfig, fixture, { connect });
    try {
      const second = createAuthService(createMysqlAuthStore(secondDatabase), { now: () => timestamp });
      const attempts = await Promise.allSettled(Array.from({ length: 6 }, (_, index) =>
        (index % 2 ? second : service).login(fixture.concurrent.email, fixture.password)));
      ensure(attempts.filter(result => result.status === "fulfilled").length === 5);
      ensure(attempts.filter(result => result.status === "rejected" && authFailure(result.reason).status === 429).length === 1);
      const bucket = `account:${digest(fixture.concurrent.email)}`;
      const stored = await select(operator, "SELECT window_start,attempts FROM crm_login_attempts WHERE bucket=?", [bucket]);
      ensure(stored.length === 1 && Number(stored[0]!.attempts) === 5 && Number(stored[0]!.window_start) === timestamp);
    } finally { await secondDatabase.close(); }
    done("concurrent-independent-stores-share-throttle-lock");
    const buildSession = () => ({ tokenHash: digest(newToken()), userId: fixture.allowed.id, csrfHash: digest(newToken()),
      passwordFingerprint: digest(String(owner.users.get(fixture.allowed.id)!.password)), createdAt: timestamp, expiresAt: timestamp + SESSION_LIFETIME_MS });
    const rolled = buildSession();
    await expectFailure(() => createMysqlAuthStore(database).transaction(async tx => { await tx.insertSession(rolled); throw new Error("synthetic rollback"); }), 503);
    ensure(await createMysqlAuthStore(database).transaction(tx => tx.getSession(rolled.tokenHash)) === null);
    done("issuance-failure-rolls-back");
    const prior = await login(fixture.allowed);
    const sessionsBefore = await count(operator, "crm_sessions");
    const failingRotation = createOwnedAuthDatabase(runtimeConfig, fixture, { connect: async config => {
      const wire = await connect(config);
      let issued = false;
      return { ...wire, execute: async (sql, values) => {
        if (issued && sql.startsWith("SELECT p.`key`")) throw refusal();
        const result = await wire.execute(sql, values);
        if (sql.startsWith("INSERT INTO crm_sessions(")) issued = true;
        return result;
      } };
    } });
    try {
      const failingService = createAuthService(createMysqlAuthStore(failingRotation), { now: () => timestamp });
      await expectFailure(() => failingService.login(fixture.allowed.email, fixture.password, prior.sessionToken), 503);
    } finally { await failingRotation.close(); }
    ensure((await service.authenticate(prior.sessionToken))?.localUserId === fixture.allowed.id);
    ensure(await count(operator, "crm_sessions") === sessionsBefore);
    done("failed-rotation-restores-prior-session-and-removes-new-issuance", "fault-injection");
    for (const mode of ["disconnect", "commit-ack-loss"] as const) {
      let inserts = 0, commits = 0;
      const faultDatabase = createOwnedAuthDatabase(runtimeConfig, fixture, { connect: async config => {
        const wire = await connect(config);
        return { ...wire, execute: async (sql, values) => {
          const result = await wire.execute(sql, values);
          if (sql.startsWith("INSERT INTO crm_sessions(")) { inserts++; if (mode === "disconnect") { wire.destroy(); throw refusal(); } }
          return result;
        }, commit: async () => { commits++; await wire.commit(); if (mode === "commit-ack-loss") throw refusal(); } };
      } });
      const session = buildSession();
      try { await expectFailure(() => createMysqlAuthStore(faultDatabase).transaction(tx => tx.insertSession(session)), 503); }
      finally { await faultDatabase.close(); }
      const reconciled = await createMysqlAuthStore(database).transaction(tx => tx.getSession(session.tokenHash));
      ensure(inserts === 1 && (mode === "disconnect" ? reconciled === null && commits === 0 : reconciled !== null && commits === 1));
      done(mode === "disconnect" ? "owned-connection-loss-rolls-back-and-fresh-read-recovers" : "uncertain-commit-no-retry-separate-read-reconciles", "fault-injection");
    }
    return { checks };
  } catch { throw new Error("MySQL authentication case failed; retained fixture requires review."); }
  finally { await database.close(); }
}
