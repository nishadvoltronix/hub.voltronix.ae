import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { connectMysql, type MysqlConnector, type MysqlWireConnection } from "../../src/crm/db/mysql/driver.js";
import type { LocalMysqlConfig } from "../../src/crm/config/mysql.js";
import { assertMysqlMigrationsCurrent, migrateMysqlApplicationSchema, mysqlMigrations } from "../../src/crm/db/mysql/migrations.js";
import { mysqlExpectedTables, mysqlExpectedTriggers } from "../../src/crm/db/mysql/schema.js";
import { assertMysqlRuntimePrivileges } from "../../src/crm/db/mysql/runtime-privileges.js";
import { createCrmRuntime } from "../../src/runtime/composition.js";
import { validateRuntimeConfiguration, type RuntimeConfiguration } from "../../src/runtime/configuration.js";
import { fingerprint } from "../mysql-auth/files.js";
import { assertNoHarnessDebug } from "../mysql-auth/http-browser.js";
import { CrmDemoFiles } from "./files.js";
import { crmDemoDigest } from "./digest.js";
import { acknowledgement, CrmDemoRefusal, parseArguments, parseApproval, parseOwnership, parseProfile, parseReceipt, requireScopes, targetFor,
  type CrmDemoApproval, type CrmDemoTarget } from "./guard.js";
import { assertScopedAccounts, grantRuntimePrivileges, observeOperator, provisionTarget } from "./observer.js";
import { createCrmDemoFixture, getCrmDemoAccess } from "./fixture.js";
import { expectedCrmDemoChecks, runCrmDemoCases } from "./cases.js";
import { expectedCrmDemoHttpChecks, runCrmDemoHttp } from "./browser.js";
import { expectedCrmDemoChromiumChecks, runCrmDemoChromium } from "./chromium.js";

type FilePort = Pick<CrmDemoFiles, "approvalPath" | "fixtureRoot" | "operatorPath" | "exists" | "read" | "writeNew" | "ensureContainer" | "createFixture">;
type Profiles = Record<"runtime" | "migration" | "fixture", Readonly<LocalMysqlConfig>>;
type Check = { name: string; kind: "mysql" | "http" | "chromium"; status: "PASS" };
export interface CrmDemoEffects {
  connect: MysqlConnector;
  verifyConnection: typeof verifyConnection;
  observe: typeof observeOperator;
  provision: typeof provisionTarget;
  scoped: typeof assertScopedAccounts;
  grants: typeof grantRuntimePrivileges;
  migrate: typeof migrateMysqlApplicationSchema;
  verifySchema: typeof verifySchema;
  verifyRuntime: typeof assertMysqlRuntimePrivileges;
  createFixture: typeof createCrmDemoFixture;
  cases: typeof runCrmDemoCases;
  http: typeof runCrmDemoHttp;
  chromium: typeof runCrmDemoChromium;
  demoAccess: typeof getCrmDemoAccess;
  createRuntime: (config: RuntimeConfiguration) => ReturnType<typeof createCrmRuntime>;
}
function ensure(value: unknown): asserts value { if (!value) throw new CrmDemoRefusal("CHECK_FAILED"); }
function rows(value: unknown): Record<string, unknown>[] {
  ensure(Array.isArray(value) && value.every(row => row && typeof row === "object" && !Array.isArray(row)));
  return value as Record<string, unknown>[];
}
export async function verifyConnection(connection: MysqlWireConnection, config: Readonly<LocalMysqlConfig>, serverUuid: string): Promise<void> {
  const found = rows((await connection.execute(`SELECT DATABASE() AS selectedDatabase,CURRENT_USER() AS identity,
    @@server_uuid AS uuid,VERSION() AS version,@@port AS port,CURRENT_ROLE() AS activeRoles`))[0]);
  ensure(found.length === 1 && found[0]?.selectedDatabase === config.database && found[0]?.uuid === serverUuid
    && found[0]?.version === "8.4.11" && String(found[0]?.port) === "3308" && found[0]?.activeRoles === "NONE"
    && found[0]?.identity === `${config.user}@${config.user === "root" ? "localhost" : "127.0.0.1"}`);
}
export async function verifySchema(connection: MysqlWireConnection, target: CrmDemoTarget, operator: MysqlWireConnection): Promise<void> {
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
const setup = ["SET SESSION time_zone = '+00:00'", "SET SESSION sql_mode = 'STRICT_ALL_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'",
  "SET SESSION innodb_lock_wait_timeout = 5", "SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ",
  "SET SESSION autocommit = 1", "SET SESSION foreign_key_checks = 1", "SET SESSION unique_checks = 1"] as const;
const realEffects: CrmDemoEffects = { connect: connectMysql, verifyConnection, observe: observeOperator, provision: provisionTarget,
  scoped: assertScopedAccounts, grants: grantRuntimePrivileges, migrate: migrateMysqlApplicationSchema, verifySchema,
  verifyRuntime: assertMysqlRuntimePrivileges, createFixture: createCrmDemoFixture, cases: runCrmDemoCases, http: runCrmDemoHttp,
  chromium: runCrmDemoChromium, demoAccess: getCrmDemoAccess,
  createRuntime: createCrmRuntime };
function runtimeCandidate(profile: Readonly<LocalMysqlConfig>, approval: CrmDemoApproval, activated = false) {
  return { version: 1, mysql: profile, approval: { approved: activated, reference: approval.approvalReference,
    validFrom: approval.validFrom, validUntil: approval.validUntil, localRuntime: true,
    syntheticWrites: true, serverUuid: approval.serverUuid, provisioningReference: `crm-demo-${approval.fixtureId}`, fixtureId: approval.fixtureId } };
}

/** Constructor and imports are inert. Fakes can only be explicitly injected by
 * offline tests; CLI always uses fixed real effects. No cleanup mode exists. */
export function createCrmDemoHarness(options: { files: FilePort; digest: () => string; now?: () => number; uuid?: () => string;
  secret?: () => string; owner?: () => string; effects?: CrmDemoEffects }) {
  const files = options.files, now = options.now ?? Date.now, effects = options.effects ?? realEffects;
  const uuid = options.uuid ?? randomUUID, secret = options.secret ?? (() => randomBytes(48).toString("base64url"));
  const owner = options.owner ?? (() => randomBytes(32).toString("hex"));
  return async (argv: readonly string[]) => {
    const args = parseArguments(argv), digest = options.digest();
    if (args.mode === "plan") {
      const fixtureId = uuid(), target = targetFor(fixtureId), timestamp = now();
      files.ensureContainer(".local-data/approvals");
      files.writeNew(files.approvalPath(fixtureId), { version: 1, fixtureId, target, approved: false, approvalReference: "",
        validFrom: new Date(timestamp).toISOString(), validUntil: new Date(timestamp + 3_600_000).toISOString(), serverUuid: "",
        harnessDigest: digest, exclusiveOperatorWindow: false,
        scopes: { provision: false, migrate: false, syntheticWrites: false, authentication: false, crmWorkflows: false, http: false, chromium: false, retainDemoAccess: false } });
      return { status: "PLAN_ONLY", fixtureId, host: target.host, port: target.port, database: target.database,
        approval: files.approvalPath(fixtureId), operatorConfigurationPresent: files.exists(files.operatorPath),
        chromium: "SEPARATE_APPROVAL_REQUIRED", demoAccess: "SEPARATE_APPROVAL_REQUIRED", cleanup: "UNAVAILABLE" };
    }
    const fixtureId = args.fixtureId!, target = targetFor(fixtureId), base = files.fixtureRoot(fixtureId);
    const approval = parseApproval(files.read(files.approvalPath(fixtureId)), fixtureId, digest, now()); requireScopes(approval, args);
    const operator = parseProfile(files.read(files.operatorPath), target, "operator");
    const publicTarget = { fixtureId, host: target.host, port: target.port, database: target.database };
    const refresh = () => {
      const fresh = parseApproval(files.read(files.approvalPath(fixtureId)), fixtureId, options.digest(), now());
      ensure(JSON.stringify(fresh) === JSON.stringify(approval)); requireScopes(fresh, args);
    };
    if (args.mode === "diagnose") {
      const presence = Object.fromEntries((["runtime", "migration", "fixture"] as const).map(kind => {
        const name = `${base}/${kind}.json`, exists = files.exists(name);
        if (exists) parseProfile(files.read(name), target, kind);
        return [kind, exists];
      }));
      return { status: "OFFLINE_CONFIGURATION_PASS", ...publicTarget, operatorConfigurationPresent: true, profilePresence: presence,
        databaseConnections: 0, databaseWrites: 0 };
    }
    const connections: MysqlWireConnection[] = [], runtimes: ReturnType<typeof createCrmRuntime>[] = [], checks: Check[] = [];
    let claimed = false, stage = "preflight";
    const open = async (profile: Readonly<LocalMysqlConfig>) => {
      refresh(); const connection = await effects.connect(profile); connections.push(connection);
      try { await effects.verifyConnection(connection, profile, approval.serverUuid); }
      catch { try { connection.destroy(); } catch { /* private */ } throw new CrmDemoRefusal("DATABASE"); }
      for (const statement of setup) await connection.query(statement);
      return connection;
    };
    const close = async () => {
      let failed = false;
      for (const runtime of runtimes.splice(0).reverse()) { try { await runtime.close(); } catch { failed = true; } }
      for (const connection of connections.splice(0).reverse()) {
        try { await connection.end(); } catch { failed = true; try { connection.destroy(); } catch { /* private */ } }
      }
      if (failed) throw new CrmDemoRefusal("DATABASE");
    };
    try {
      if (args.mode === "provision") {
        if (files.exists(base)) throw new CrmDemoRefusal("OWNERSHIP");
        files.createFixture(fixtureId); claimed = true;
        const owned = parseOwnership({ version: 1, fixtureId, target, serverUuid: approval.serverUuid, harnessDigest: digest,
          owner: owner(), createdAt: new Date(now()).toISOString() }, approval);
        files.writeNew(`${base}/ownership.json`, owned);
        const passwords = { runtime: secret(), migration: secret(), fixture: secret() };
        ensure(new Set(Object.values(passwords)).size === 3 && Object.values(passwords).every(value => /^[A-Za-z0-9_-]{64}$/.test(value)));
        const profiles = Object.fromEntries((Object.keys(passwords) as (keyof Profiles)[]).map(kind => [kind,
          parseProfile({ provider: "mysql", environment: "test", host: target.host, port: target.port, database: target.database,
            user: target[`${kind}User`], password: passwords[kind] }, target, kind)])) as Profiles;
        for (const kind of Object.keys(profiles) as (keyof Profiles)[]) files.writeNew(`${base}/${kind}.json`, profiles[kind]);
        stage = "operator"; const admin = await open(operator);
        ensure((await effects.observe(admin, operator.user)).serverUuid === approval.serverUuid);
        stage = "additive-provisioning"; refresh(); await effects.provision(admin, target, passwords); await effects.scoped(admin, target, "provisioned");
        stage = "additive-migration"; refresh(); const migration = await open(profiles.migration);
        ensure(await effects.migrate(migration, { database: target.database, allowSchemaChanges: true }) === mysqlMigrations.length);
        ensure(await effects.migrate(migration, { database: target.database, allowSchemaChanges: true }) === 0);
        await effects.verifySchema(migration, target, admin);
        stage = "runtime-grants"; refresh(); await effects.grants(admin, target); await effects.scoped(admin, target, "ready");
        stage = "runtime-readiness"; const runtime = await open(profiles.runtime);
        await effects.verifyRuntime(runtime, target.database); await effects.verifySchema(runtime, target, admin);
        stage = "drain"; await close(); refresh();
        const fingerprints = { runtime: fingerprint(profiles.runtime), migration: fingerprint(profiles.migration), fixture: fingerprint(profiles.fixture) };
        files.writeNew(`${base}/provisioned.json`, { version: 1, owner: owned.owner, fixtureId, serverUuid: approval.serverUuid,
          phase: "provisioned", migrationApplied: mysqlMigrations.length, migrationRepeat: 0, profiles: fingerprints });
        // Candidate is retained within this new fixture, never installed over an
        // operator/application profile. It needs fresh review before CLI use.
        files.writeNew(`${base}/runtime-configuration.json`, runtimeCandidate(profiles.runtime, approval));
        return { status: "PROVISIONED", ...publicTarget, migrationApplied: mysqlMigrations.length, migrationRepeat: 0, businessRows: 0,
          runtimeCandidate: `${base}/runtime-configuration.json`, cleanup: "UNAVAILABLE" };
      }
      const owned = parseOwnership(files.read(`${base}/ownership.json`), approval);
      const profiles = Object.fromEntries((["runtime", "migration", "fixture"] as const).map(kind =>
        [kind, parseProfile(files.read(`${base}/${kind}.json`), target, kind)])) as Profiles;
      parseReceipt(files.read(`${base}/provisioned.json`), owned,
        { runtime: fingerprint(profiles.runtime), migration: fingerprint(profiles.migration), fixture: fingerprint(profiles.fixture) });
      if (["attempt.json", "complete.json", "failed.json", "provision-failed.json", "demo-access.json"].some(name => files.exists(`${base}/${name}`))) throw new CrmDemoRefusal("STATE");
      files.writeNew(`${base}/attempt.json`, { version: 1, owner: owned.owner, startedAt: new Date(now()).toISOString() }); claimed = true;
      stage = "operator"; const admin = await open(operator);
      ensure((await effects.observe(admin, operator.user)).serverUuid === approval.serverUuid); await effects.scoped(admin, target, "ready");
      stage = "empty-schema"; const migration = await open(profiles.migration); await effects.verifySchema(migration, target, admin);
      const runtimeConnection = await open(profiles.runtime); await effects.verifyRuntime(runtimeConnection, target.database);
      const fixtureConnection = await open(profiles.fixture);
      stage = "synthetic-fixture"; refresh(); const fixture = await effects.createFixture(fixtureConnection, fixtureId);
      const createRuntime = () => {
        refresh();
        const config = validateRuntimeConfiguration(runtimeCandidate(profiles.runtime, approval, true),
          { environment: "test", host: "127.0.0.1", port: 4000, appOrigin: "http://127.0.0.1:3000" }, now());
        const value = effects.createRuntime(config); runtimes.push(value); return value;
      };
      const record = (name: string, kind: "mysql" | "http" | "chromium") => {
        ensure(/^[A-Za-z0-9 ()/,:._+-]{1,160}$/.test(name) && ["mysql", "http", "chromium"].includes(kind)
          && !checks.some(check => check.kind === kind && check.name === name));
        checks.push({ name, kind, status: "PASS" });
      };
      stage = "crm-workflows"; refresh(); const databaseCount = await effects.cases({ fixture, fixtureConnection, createRuntime, record });
      ensure(databaseCount === expectedCrmDemoChecks && checks.length === databaseCount && checks.every(check => check.kind === "mysql"));
      stage = "http"; refresh(); const httpCount = await effects.http({ fixture, fixtureConnection, createRuntime, record });
      ensure(httpCount === expectedCrmDemoHttpChecks && checks.length === databaseCount + httpCount
        && checks.slice(databaseCount).every(check => check.kind === "http"));
      if (args.chromium) {
        stage = "chromium"; refresh();
        const chromiumCount = await effects.chromium({ fixture, fixtureConnection, createRuntime, record });
        ensure(chromiumCount === expectedCrmDemoChromiumChecks && checks.length === databaseCount + httpCount + chromiumCount
          && checks.slice(databaseCount + httpCount).every(check => check.kind === "chromium"));
      }
      stage = "drain"; await close(); refresh();
      let demoAccessFile: string | undefined;
      if (args.retainDemoAccess) {
        stage = "retain-approved-demo-access";
        const access = effects.demoAccess(fixture, args.chromium === true);
        ensure(access.database === target.database && access.fixtureId === fixtureId);
        demoAccessFile = `${base}/demo-access.json`;
        files.writeNew(demoAccessFile, { version: 1, owner: owned.owner, serverUuid: approval.serverUuid,
          harnessDigest: digest, approvalReference: approval.approvalReference, validUntil: approval.validUntil, ...access });
      }
      const result = { status: "PASS", ...publicTarget, checks, completedAt: new Date(now()).toISOString(),
        fixtures: "RETAINED", chromium: args.chromium ? "PASS" : "NOT_RUN", ...(demoAccessFile ? { demoAccessFile } : {}),
        serverRestart: "NOT_RUN", recovery: "NOT_RUN" };
      files.writeNew(`${base}/complete.json`, result); return result;
    } catch (error) {
      try { await close(); } catch { /* retain original safe failure category */ }
      if (claimed) { try { files.writeNew(`${base}/${args.mode === "provision" ? "provision-failed" : "failed"}.json`,
        { status: "FAIL_RETAINED", stage, completedChecks: checks, failedAt: new Date(now()).toISOString() }); } catch { /* never overwrite receipts */ } }
      throw error instanceof CrmDemoRefusal ? error : new CrmDemoRefusal("CHECK_FAILED");
    }
  };
}
export function realCrmDemoHarness(root: string) {
  assertNoHarnessDebug(process.env, process.execArgv);
  const normalizedRoot = resolve(root);
  return createCrmDemoHarness({ files: new CrmDemoFiles(normalizedRoot), digest: () => crmDemoDigest(normalizedRoot) });
}
export { acknowledgement };
