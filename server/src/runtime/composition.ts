import { createAuthService } from "../auth/service.js";
import { createMysqlAuthStore } from "../auth/mysql-store.js";
import { MysqlDatabase } from "../crm/db/mysql/database.js";
import { assertMysqlMigrationsCurrent } from "../crm/db/mysql/migrations.js";
import { assertMysqlRuntimePrivileges } from "../crm/db/mysql/runtime-privileges.js";
import type { MysqlWireConnection } from "../crm/db/mysql/driver.js";
import { assertValidatedRuntimeConfiguration, RuntimeConfigurationError, type RuntimeConfiguration } from "./configuration.js";
import { createCrmServices, type CrmIntegration } from "../crm/router.js";
import { createReadinessProbe } from "./readiness.js";
import type { ProductionZohoConfiguration } from "../integrations/zoho/production.js";
import { validateRuntimeZohoSyncConfiguration, type RuntimeZohoSyncConfiguration } from "./zoho-configuration.js";
import { createZohoSyncWorker } from "./zoho-sync-worker.js";

/** Called for each owned connection, never as implicit migration or repair. */
export async function verifyCrmRuntimeConnection(connection: MysqlWireConnection, config: RuntimeConfiguration, now = Date.now()): Promise<void> {
  try {
    assertValidatedRuntimeConfiguration(config, now);
    const [identity] = await connection.query("SELECT @@server_uuid AS serverUuid,CURRENT_USER() AS identity");
    if (!Array.isArray(identity) || identity.length !== 1 || identity[0]?.serverUuid !== config.serverUuid
      || identity[0]?.identity !== `${config.mysql.user}@127.0.0.1`) throw new Error();
    await assertMysqlRuntimePrivileges(connection, config.mysql.database, config.mysql.port);
    await assertMysqlMigrationsCurrent(connection, config.mysql.database);
  } catch { throw new RuntimeConfigurationError(); }
}

/** Construction opens nothing. HTTP/auth/CRM borrow one lifecycle owner with
 * the full table privilege contract; the narrow auth-only identity is not reused.
 * Neither constructors nor requests apply migrations, import rows or retry writes. */
export function createCrmRuntime(config: RuntimeConfiguration, options: { integration?: CrmIntegration } = {}) {
  assertValidatedRuntimeConfiguration(config);
  const database = new MysqlDatabase(config.mysql, { verify: connection => verifyCrmRuntimeConnection(connection, config) });
  const store = createMysqlAuthStore({ transaction: work => database.authTransaction(work) });
  const readiness = createReadinessProbe(async () => {
    // The normal lease verifies identity, privileges and current migrations
    // before this read. No transaction/audit/authentication write is performed.
    const row = await database.prepare("SELECT 1 AS ready").get();
    if (typeof row !== "object" || row === null || !("ready" in row) || row.ready !== 1) throw new RuntimeConfigurationError();
  });
  return { database, auth: createAuthService(store), crmServices: createCrmServices(database,
    { ...(config.issuer ? { issuer: config.issuer } : {}), ...(options.integration ? { integration: options.integration } : {}) }),
  readiness, close: () => database.close() };
}

interface RuntimeIntegration {
  readonly crmIntegration: CrmIntegration;
  readiness(): Promise<void>;
  close(): void | Promise<void>;
}
interface RuntimeOpeningDependencies {
  networkEnabled?: boolean;
  createRuntime?: typeof createCrmRuntime;
  openIntegration?: (configuration: ProductionZohoConfiguration) => Promise<RuntimeIntegration>;
  openInboundSource?: typeof import("../integrations/zoho/inbound-sync-source.js").openZohoInboundSource;
  runInboundSync?: typeof import("../integrations/zoho/inbound-sync.js").runZohoInboundSync;
  readInboundStatus?: typeof import("../integrations/zoho/inbound-store.js").readZohoInboundStatus;
}
export type OpenedCrmRuntime = ReturnType<typeof createCrmRuntime> & { startBackground?: () => void };

/** Only normal executable startup owns this async integration lifecycle.
 * Bootstrap and migration tools continue to use the pure database constructor. */
export async function openCrmRuntime(config: RuntimeConfiguration, integrationConfiguration?: ProductionZohoConfiguration,
  dependencies: RuntimeOpeningDependencies = {}, inboundConfiguration?: RuntimeZohoSyncConfiguration): Promise<OpenedCrmRuntime> {
  assertValidatedRuntimeConfiguration(config);
  const create = dependencies.createRuntime ?? createCrmRuntime;
  if (!integrationConfiguration && !inboundConfiguration) return create(config);
  if (config.api.environment !== "production" || dependencies.networkEnabled !== true) throw new RuntimeConfigurationError();
  let integration: RuntimeIntegration | undefined, runtime: ReturnType<typeof createCrmRuntime> | undefined;
  let inbound: Awaited<ReturnType<NonNullable<RuntimeOpeningDependencies["openInboundSource"]>>> | undefined;
  let worker: ReturnType<typeof createZohoSyncWorker> | undefined;
  try {
    const sync = inboundConfiguration ? validateRuntimeZohoSyncConfiguration(inboundConfiguration) : undefined;
    if (sync && integrationConfiguration && sync.organizationId !== integrationConfiguration.organizationId) throw new Error();
    if (integrationConfiguration) {
      const open = dependencies.openIntegration ?? (async configuration => {
        const { openProductionZohoIntegration } = await import("../integrations/zoho/production.js");
        return openProductionZohoIntegration(configuration, { networkEnabled: true });
      });
      integration = await open(integrationConfiguration);
      if (!integration?.crmIntegration || typeof integration.readiness !== "function" || typeof integration.close !== "function") throw new Error();
    }
    if (sync) {
      const open = dependencies.openInboundSource ?? (await import("../integrations/zoho/inbound-sync-source.js")).openZohoInboundSource;
      inbound = await open({ credentials: sync.credentials, organizationId: sync.organizationId }, { networkEnabled: true });
      await inbound.readiness();
    }
    runtime = create(config, integration ? { integration: integration.crmIntegration } : {});
    const owned = runtime, session = integration;
    if (sync && inbound) {
      const status = dependencies.readInboundStatus ?? (await import("../integrations/zoho/inbound-store.js")).readZohoInboundStatus;
      await status(owned.database, sync.organizationId, sync.principalId);
      const run = dependencies.runInboundSync ?? (await import("../integrations/zoho/inbound-sync.js")).runZohoInboundSync;
      const source = inbound;
      worker = createZohoSyncWorker({ intervalMs: sync.intervalMs, abortSource: () => source.close(),
        run: signal => run({ database: owned.database, source, organizationId: sync.organizationId, principalId: sync.principalId, signal }) });
    }
    let closed = false, closing: Promise<void> | undefined;
    const readiness = createReadinessProbe(async () => {
      if (closed) throw new Error();
      // Inbound freshness is persisted and reported separately. A later polling
      // failure must not hide already imported data or claim it is up to date.
      const [databaseReady] = await Promise.all([owned.readiness(), session?.readiness()]);
      if (!databaseReady || closed) throw new Error();
    });
    const close = () => closing ??= (async () => {
      closed = true;
      const drained = await Promise.allSettled([worker ? worker.close() : Promise.resolve().then(() => inbound?.close())]);
      const results = await Promise.allSettled([Promise.resolve().then(() => session?.close()), Promise.resolve().then(() => owned.close())]);
      if ([...drained, ...results].some(result => result.status === "rejected")) throw new RuntimeConfigurationError();
    })();
    return { ...owned, readiness, close, startBackground: () => { if (!closed) worker?.start(); } };
  } catch {
    await Promise.allSettled([worker ? worker.close() : Promise.resolve().then(() => inbound?.close())]);
    await Promise.allSettled([Promise.resolve().then(() => integration?.close()), Promise.resolve().then(() => runtime?.close())]);
    throw new RuntimeConfigurationError();
  }
}
