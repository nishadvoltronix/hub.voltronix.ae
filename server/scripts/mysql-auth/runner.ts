import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createAuthService } from "../../src/auth/service.js";
import { createMysqlAuthStore } from "../../src/auth/mysql-store.js";
import type { MysqlAuthConfig } from "../../src/db/mysql/config.js";
import { connectMysqlAuth, type MysqlAuthWireConnection } from "../../src/db/mysql/driver.js";
import { assertMysqlMigrationsCurrent, migrateMysqlApplicationSchema } from "../../src/db/mysql/migrations.js";
import { mysqlExpectedTables, mysqlExpectedTriggers } from "../../src/db/mysql/schema.js";
import { assertMysqlAuthReady } from "../../src/db/mysql/verification.js";
import { createOwnedAuthDatabase, createSyntheticFixture, cleanupSyntheticFixture, runAuthCases, type SyntheticFixture } from "./cases.js";
import { fingerprint, HarnessFiles, harnessDigest } from "./files.js";
import { HarnessRefusal, parseArguments, parseApproval, parseOwnership, parseProfile, parseReceipt, requireScopes, targetFor,
  type HarnessApproval, type HarnessTarget } from "./guard.js";
import { assertNoHarnessDebug, runHttpBrowser } from "./http-browser.js";
import { assertScopedAccounts, grantRuntimePrivileges, observeOperator, provisionTarget } from "./observer.js";

export type CheckKind = "mysql" | "fault-injection" | "http" | "chromium";
type Check = { name: string; kind: CheckKind; status: "PASS" };
type Profiles = Record<"runtime" | "migration" | "fixture", Readonly<MysqlAuthConfig>>;
type FilePort = Pick<HarnessFiles, "approvalPath" | "fixtureRoot" | "operatorPath" | "exists" | "read" | "writeNew" | "ensureContainer" | "createFixture">;
export interface HarnessEffects {
  connect: typeof connectMysqlAuth;
  verifyConnection: (connection: MysqlAuthWireConnection, config: Readonly<MysqlAuthConfig>, serverUuid: string) => Promise<void>;
  observe: typeof observeOperator;
  provision: typeof provisionTarget;
  grants: typeof grantRuntimePrivileges;
  scoped: typeof assertScopedAccounts;
  migrate: typeof migrateMysqlApplicationSchema;
  verifySchema: (connection: MysqlAuthWireConnection, target: HarnessTarget, operator: MysqlAuthWireConnection) => Promise<void>;
  verifyRuntime: typeof assertMysqlAuthReady;
  createFixture: typeof createSyntheticFixture;
  cases: typeof runAuthCases;
  browser: typeof runHttpBrowser;
  cleanup: typeof cleanupSyntheticFixture;
}
const setup = ["SET SESSION time_zone = '+00:00'",
  "SET SESSION sql_mode = 'STRICT_ALL_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'",
  "SET SESSION innodb_lock_wait_timeout = 5", "SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ",
  "SET SESSION autocommit = 1", "SET SESSION foreign_key_checks = 1", "SET SESSION unique_checks = 1"] as const;
function ensure(value: unknown): asserts value { if (!value) throw new HarnessRefusal("CHECK_FAILED"); }
function rows(value: unknown): Record<string, unknown>[] {
  ensure(Array.isArray(value) && value.every(row => row && typeof row === "object" && !Array.isArray(row)));
  return value as Record<string, unknown>[];
}
export async function verifyConnection(connection: MysqlAuthWireConnection, config: Readonly<MysqlAuthConfig>, serverUuid: string): Promise<void> {
  const found = rows((await connection.execute(`SELECT DATABASE() AS selectedDatabase,CURRENT_USER() AS identity,
    @@server_uuid AS uuid,VERSION() AS version,@@port AS port,CURRENT_ROLE() AS activeRoles`))[0]);
  ensure(found.length === 1 && found[0]?.selectedDatabase === config.database && found[0]?.uuid === serverUuid
    && found[0]?.version === "8.4.11" && String(found[0]?.port) === "3308" && found[0]?.activeRoles === "NONE"
    && found[0]?.identity === `${config.user}@${config.user === "root" ? "localhost" : "127.0.0.1"}`);
}
export async function verifySchema(connection: MysqlAuthWireConnection, target: HarnessTarget, operator: MysqlAuthWireConnection): Promise<void> {
  await assertMysqlMigrationsCurrent(connection, target.database);
  for (const [sql, expected] of [
    ["SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=?", mysqlExpectedTriggers],
    ["SELECT ROUTINE_NAME AS name FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=?", []],
    ["SELECT EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA=?", []],
  ] as const) {
    const found = rows((await operator.execute(sql, [target.database]))[0]);
    ensure(found.every(row => typeof row.name === "string")
      && JSON.stringify(found.map(row => row.name).sort()) === JSON.stringify([...expected].sort()));
  }
  for (const table of mysqlExpectedTables) {
    const found = rows((await connection.execute(`SELECT COUNT(*) AS total FROM \`${table}\``))[0]);
    ensure(found.length === 1 && String(found[0]?.total) === (table === "crm_app_lock" ? "1" : "0"));
  }
}
const realEffects: HarnessEffects = { connect: connectMysqlAuth, verifyConnection, observe: observeOperator, provision: provisionTarget,
  grants: grantRuntimePrivileges, scoped: assertScopedAccounts, migrate: migrateMysqlApplicationSchema,
  verifySchema, verifyRuntime: assertMysqlAuthReady, createFixture: createSyntheticFixture,
  cases: runAuthCases, browser: runHttpBrowser, cleanup: cleanupSyntheticFixture };

/** File/clock/effect injection is used only by offline tests. CLI always supplies
 * the real fixed effects; no environment flag selects a fake database. */
export function createHarness(options: { files: FilePort; digest: () => string; now?: () => number;
  uuid?: () => string; secret?: () => string; owner?: () => string; effects?: HarnessEffects }) {
  const files = options.files, now = options.now ?? Date.now, effects = options.effects ?? realEffects;
  const id = options.uuid ?? randomUUID, secret = options.secret ?? (() => randomBytes(48).toString("base64url"));
  const owner = options.owner ?? (() => randomBytes(32).toString("hex"));
  return async (argv: readonly string[]) => {
    const args = parseArguments(argv), digest = options.digest();
    if (args.mode === "plan") {
      const fixtureId = id(), target = targetFor(fixtureId), timestamp = now();
      files.ensureContainer(".local-data/approvals"); files.ensureContainer(".local-data/operators");
      files.writeNew(files.approvalPath(fixtureId), { version: 1, fixtureId, target, approved: false,
        approvalReference: "", validFrom: new Date(timestamp).toISOString(), validUntil: new Date(timestamp + 3_600_000).toISOString(),
        serverUuid: "", harnessDigest: digest, exclusiveOperatorWindow: false,
        scopes: { provision: false, migrate: false, syntheticWrites: false, authentication: false, http: false,
          faultInjection: false, chromium: false, cleanupOwned: false } });
      const template = ".local-data/operators/mysql-auth-operator.example.json";
      if (!files.exists(template)) files.writeNew(template, { provider: "mysql", environment: "development", host: "127.0.0.1",
        port: 3308, database: "crm_local_dev", user: "root", password: "" });
      return { status: "PLAN_ONLY", fixtureId, host: target.host, port: target.port, database: target.database,
        approval: files.approvalPath(fixtureId), operatorConfigurationPresent: files.exists(files.operatorPath) };
    }
    const fixtureId = args.fixtureId!, target = targetFor(fixtureId), base = files.fixtureRoot(fixtureId);
    const approval = parseApproval(files.read(files.approvalPath(fixtureId)), fixtureId, digest, now());
    requireScopes(approval, args);
    const operator = parseProfile(files.read(files.operatorPath), target, "operator");
    const publicTarget = { fixtureId, host: target.host, port: target.port, database: target.database };
    const refreshApproval = () => {
      const fresh = parseApproval(files.read(files.approvalPath(fixtureId)), fixtureId, options.digest(), now());
      ensure(JSON.stringify(fresh) === JSON.stringify(approval)); requireScopes(fresh, args);
    };
    if (args.mode === "diagnose") {
      const present = Object.fromEntries(["runtime", "migration", "fixture"].map(kind => {
        const path = `${base}/${kind}.json`, exists = files.exists(path);
        if (exists) parseProfile(files.read(path), target, kind as keyof Profiles);
        return [kind, exists];
      }));
      return { status: "OFFLINE_CONFIGURATION_PASS", ...publicTarget, operatorConfigurationPresent: true,
        fixtureDirectoryPresent: files.exists(base), profilePresence: present, databaseContacted: false };
    }
    let stage = "preflight";
    const checks: Check[] = [];
    const connections: MysqlAuthWireConnection[] = [];
    const connectPinned = async (configuration: Readonly<MysqlAuthConfig>) => {
      const connection = await effects.connect(configuration);
      try { await effects.verifyConnection(connection, configuration, approval.serverUuid); return connection; }
      catch { try { connection.destroy(); } catch { /* private cleanup */ } throw new HarnessRefusal("DATABASE"); }
    };
    const open = async (configuration: Readonly<MysqlAuthConfig>) => {
      const connection = await connectPinned(configuration); connections.push(connection);
      for (const sql of setup) await connection.query(sql);
      return connection;
    };
    const close = async () => {
      let failed = false;
      for (const connection of connections.splice(0).reverse()) {
        try { await connection.end(); } catch { failed = true; try { connection.destroy(); } catch { /* safe */ } }
      }
      if (failed) throw new HarnessRefusal("DATABASE");
    };
    const checkOperator = async (connection: MysqlAuthWireConnection, approved: HarnessApproval) => {
      ensure((await effects.observe(connection, operator.user)).serverUuid === approved.serverUuid);
    };
    let claimed = false;
    try {
      if (args.mode === "provision") {
        if (files.exists(base)) throw new HarnessRefusal("OWNERSHIP");
        files.createFixture(fixtureId); claimed = true;
        const owned = parseOwnership({ version: 1, fixtureId, target, serverUuid: approval.serverUuid,
          harnessDigest: digest, owner: owner(), createdAt: new Date(now()).toISOString() }, approval);
        files.writeNew(`${base}/ownership.json`, owned);
        const passwords = { runtime: secret(), migration: secret(), fixture: secret() };
        ensure(new Set(Object.values(passwords)).size === 3 && Object.values(passwords).every(value => /^[A-Za-z0-9_-]{64}$/.test(value)));
        const profiles = Object.fromEntries((Object.keys(passwords) as (keyof Profiles)[]).map(kind => [kind,
          parseProfile({ provider: "mysql", environment: "test", host: target.host, port: target.port,
            database: target.database, user: target[`${kind}User`], password: passwords[kind] }, target, kind)])) as Profiles;
        for (const kind of Object.keys(profiles) as (keyof Profiles)[]) files.writeNew(`${base}/${kind}.json`, profiles[kind]);
        refreshApproval(); stage = "operator";
        const admin = await open(operator); await checkOperator(admin, approval);
        stage = "additive-provisioning"; refreshApproval(); await effects.provision(admin, target, passwords);
        await effects.scoped(admin, target, "provisioned");
        stage = "additive-migration"; refreshApproval();
        const migration = await open(profiles.migration);
        ensure(await effects.migrate(migration, { database: target.database, allowSchemaChanges: true }) === 1);
        ensure(await effects.migrate(migration, { database: target.database, allowSchemaChanges: true }) === 0);
        await effects.verifySchema(migration, target, admin);
        stage = "runtime-grants"; refreshApproval(); await effects.grants(admin, target); await effects.scoped(admin, target, "ready");
        stage = "runtime-readiness";
        const runtime = await open(profiles.runtime); await effects.verifyRuntime(runtime, profiles.runtime);
        stage = "drain"; await close();
        files.writeNew(`${base}/provisioned.json`, { version: 1, owner: owned.owner, fixtureId, serverUuid: approval.serverUuid,
          phase: "provisioned", migrationApplied: 1, migrationRepeat: 0,
          profiles: { runtime: fingerprint(profiles.runtime), migration: fingerprint(profiles.migration), fixture: fingerprint(profiles.fixture) } });
        return { status: "PROVISIONED", ...publicTarget, migrationApplied: 1, migrationRepeat: 0, businessRows: 0 };
      }
      const owned = parseOwnership(files.read(`${base}/ownership.json`), approval);
      const profiles = Object.fromEntries((["runtime", "migration", "fixture"] as const).map(kind =>
        [kind, parseProfile(files.read(`${base}/${kind}.json`), target, kind)])) as Profiles;
      parseReceipt(files.read(`${base}/provisioned.json`), owned,
        { runtime: fingerprint(profiles.runtime), migration: fingerprint(profiles.migration), fixture: fingerprint(profiles.fixture) });
      if (["attempt.json", "complete.json", "failed.json", "provision-failed.json"].some(name => files.exists(`${base}/${name}`))) throw new HarnessRefusal("STATE");
      files.writeNew(`${base}/attempt.json`, { version: 1, owner: owned.owner, startedAt: new Date(now()).toISOString() }); claimed = true;
      refreshApproval(); stage = "operator";
      const admin = await open(operator); await checkOperator(admin, approval); await effects.scoped(admin, target, "ready");
      stage = "empty-schema";
      const migration = await open(profiles.migration); await effects.verifySchema(migration, target, admin);
      const runtime = await open(profiles.runtime); await effects.verifyRuntime(runtime, profiles.runtime);
      stage = "synthetic-fixture"; refreshApproval();
      const fixtureConnection = await open(profiles.fixture);
      const fixture: SyntheticFixture = await effects.createFixture(fixtureConnection, fixtureId.replaceAll("-", ""));
      const record = (name: string, kind: CheckKind) => {
        ensure(/^[A-Za-z0-9 ()/,:._+-]{1,160}$/.test(name) && ["mysql", "fault-injection", "http", "chromium"].includes(kind));
        checks.push({ name, kind, status: "PASS" });
      };
      stage = "authentication"; refreshApproval();
      const result = await effects.cases({ runtimeConfig: profiles.runtime, fixtureConnection, fixture, record }, { connect: connectPinned });
      ensure(result.checks === 15 && checks.length === 15);
      stage = "http-browser"; refreshApproval();
      const browserCount = await effects.browser({ runtimeConfig: profiles.runtime, identities: {
        allowed: { email: fixture.httpAllowed.email, password: fixture.password },
        denied: { email: fixture.httpDenied.email, password: fixture.password } }, browser: args.chromium, record,
        createAuthentication: () => {
          const database = createOwnedAuthDatabase(profiles.runtime, fixture, { connect: connectPinned });
          return { auth: createAuthService(createMysqlAuthStore(database)), close: () => database.close() };
        } });
      ensure(browserCount === (args.chromium ? 10 : 6) && checks.length === result.checks + browserCount);
      let cleanupRows: number | null = null;
      if (args.cleanup) {
        stage = "owned-row-cleanup"; refreshApproval();
        cleanupRows = (await effects.cleanup(fixtureConnection, fixture)).deletedRows;
      }
      stage = "drain"; await close();
      const evidence = { status: "PASS", ...publicTarget, completedAt: new Date(now()).toISOString(), checks,
        cleanup: args.cleanup ? "OWNED_ROWS_ONLY" : "RETAINED", cleanupRows, serverRestart: "NOT_RUN", recovery: "NOT_RUN" };
      files.writeNew(`${base}/complete.json`, evidence);
      return evidence;
    } catch (error) {
      try { await close(); } catch { /* preserve the original safe category */ }
      if (claimed) {
        try { files.writeNew(`${base}/${args.mode === "provision" ? "provision-failed" : "failed"}.json`,
          { status: "FAIL_RETAINED", stage, failedAt: new Date(now()).toISOString(), completedChecks: checks }); } catch { /* never overwrite evidence */ }
      }
      throw error instanceof HarnessRefusal ? error : new HarnessRefusal("CHECK_FAILED");
    }
  };
}

export function realHarness(root: string) {
  assertNoHarnessDebug(process.env, process.execArgv);
  const normalizedRoot = resolve(root);
  return createHarness({ files: new HarnessFiles(normalizedRoot), digest: () => harnessDigest(normalizedRoot) });
}
