import { z } from "zod";
import { loadConfig, type ApiConfig } from "../config.js";
import type { LocalMysqlConfig } from "../crm/config/mysql.js";
import { validateLocalMysqlConfig } from "../crm/config/mysql.js";
import { validateLocalQuotationIssuer, type LocalQuotationIssuer } from "../crm/quotation-pdf/render.js";
import { mysqlEnvironmentKeys, productionProfileFromEnvironment } from "./environment-settings.js";

export const runtimeProfilePath = ".local-data/operators/mysql-crm-runtime.json";
export const runtimeAcknowledgement = "approved-local-mysql-crm-runtime";
export const productionRuntimeAcknowledgement = "approved-production-mysql-crm-runtime";
export class RuntimeConfigurationError extends Error {
  constructor() { super("Explicit local CRM runtime configuration is missing, unsafe or unapproved; no fallback was attempted."); }
}
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const profile = z.object({
  version: z.literal(1),
  mysql: z.object({ provider: z.literal("mysql"), environment: z.enum(["development", "test"]),
    host: z.literal("127.0.0.1"), port: z.literal(3308), database: z.string(),
    user: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/).refine(value => !/^(?:root|mysql[._])/i.test(value)),
    password: z.string().min(1).max(4096).refine(value => !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 4096),
  }).strict(),
  approval: z.object({ approved: z.literal(true), reference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$/),
    validFrom: z.iso.datetime(), validUntil: z.iso.datetime(), localRuntime: z.literal(true),
    syntheticWrites: z.boolean(), serverUuid: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
    provisioningReference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$/),
    fixtureId: uuid.nullable(),
  }).strict(),
}).strict();
const productionProfile = z.object({
  version: z.literal(2),
  mysql: z.object({ provider: z.literal("mysql"), environment: z.literal("production"),
    host: z.literal("127.0.0.1"), port: z.union([z.literal(3306), z.literal(3308)]),
    database: z.string(), user: z.string(), password: z.string(),
  }).strict(),
  approval: z.object({ approved: z.literal(true),
    reference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$/),
    provisioningReference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$/),
    serverUuid: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
  }).strict(),
  issuer: z.object({ company: z.string(), salesperson: z.string() }).strict(),
}).strict();
export interface RuntimeConfiguration {
  readonly api: ApiConfig;
  readonly mysql: Readonly<LocalMysqlConfig>;
  readonly serverUuid: string;
  readonly validFrom: number;
  readonly validUntil: number;
  readonly issuer?: Readonly<LocalQuotationIssuer>;
}
const validated = new WeakSet<object>();
export function assertValidatedRuntimeConfiguration(value: RuntimeConfiguration, now = Date.now()): void {
  if (!value || !validated.has(value) || !Number.isFinite(now) || now < value.validFrom || now >= value.validUntil) throw new RuntimeConfigurationError();
}

/** Pure validation. A private reference records an actual review; a boolean is
 * never a substitute for approval, schema provenance or live privilege evidence. */
export function validateRuntimeConfiguration(input: unknown, apiInput: ApiConfig, now = Date.now()): RuntimeConfiguration {
  try {
    const api = loadConfig({ CRM_API_ENVIRONMENT: apiInput.environment,
      CRM_API_HOST: apiInput.host, CRM_API_PORT: String(apiInput.port), APP_ORIGIN: apiInput.appOrigin,
      CRM_API_INSTANCE_ID: apiInput.instanceId });
    if (!Number.isFinite(now)) throw new Error();
    if (api.environment === "production") {
      const selected = productionProfile.parse(input);
      const result = Object.freeze({ api, mysql: Object.freeze(validateLocalMysqlConfig(selected.mysql)),
        serverUuid: selected.approval.serverUuid, validFrom: 0, validUntil: Number.POSITIVE_INFINITY,
        issuer: Object.freeze(validateLocalQuotationIssuer(selected.issuer)) });
      validated.add(result);
      return result;
    }
    const selected = profile.parse(input);
    const { mysql, approval } = selected;
    const validFrom = Date.parse(approval.validFrom), validUntil = Date.parse(approval.validUntil);
    if (!Number.isFinite(now) || validFrom > now || validUntil <= now || validUntil - validFrom > 86_400_000
      || api.environment !== mysql.environment) throw new Error();
    if (mysql.environment === "development") {
      if (mysql.database !== "crm_local_dev" || approval.fixtureId !== null || approval.syntheticWrites) throw new Error();
    } else {
      if (!approval.fixtureId || !approval.syntheticWrites) throw new Error();
      const hex = approval.fixtureId.replaceAll("-", "");
      if (mysql.database !== `crm_local_crm_${hex}` || mysql.user !== `crm_r_${hex.slice(0, 24)}`) throw new Error();
    }
    const result = Object.freeze({ api, mysql: Object.freeze(mysql), serverUuid: approval.serverUuid, validFrom, validUntil });
    validated.add(result);
    return result;
  } catch { throw new RuntimeConfigurationError(); }
}

/** Selection is explicit and backend-owned. Existing Next profiles/.env files
 * are never searched, loaded, copied, changed or substituted. */
export function loadRuntimeConfiguration(root: string, environment: Readonly<Record<string, string | undefined>>,
  readPrivate: (root: string, name: string) => unknown, now = Date.now()): RuntimeConfiguration {
  try {
    // This is the native-schema runtime. Disabled Hub startup and the unavailable
    // legacy adapter must never fall through to its profile or credential sources.
    if (environment.CRM_DATABASE_MODE !== undefined) throw new Error();
    const allowed = new Set(["CRM_RUNTIME_ENABLE", "CRM_RUNTIME_PROFILE", "CRM_RUNTIME_SOURCE"]);
    const acknowledgement = environment.CRM_API_ENVIRONMENT === "production"
      ? productionRuntimeAcknowledgement : runtimeAcknowledgement;
    if (Object.keys(environment).some(key => key.startsWith("CRM_RUNTIME_") && !allowed.has(key))
      || environment.CRM_RUNTIME_ENABLE !== acknowledgement) throw new Error();
    const mysqlAllowed = new Set<string>([...mysqlEnvironmentKeys, "CRM_MYSQL_NETWORK_DISABLED"]);
    if (Object.keys(environment).some(key => key.startsWith("CRM_MYSQL_") && !mysqlAllowed.has(key))) throw new Error();
    for (const key of ["NODE_DEBUG", "NODE_DEBUG_NATIVE", "DEBUG", "PWDEBUG", "NODE_OPTIONS"]) {
      if (environment[key]?.trim()) throw new Error();
    }
    const api = loadConfig(environment);
    if (environment.CRM_RUNTIME_SOURCE === "environment") {
      if (api.environment !== "production" || environment.CRM_RUNTIME_PROFILE?.trim()) throw new Error();
      return validateRuntimeConfiguration(productionProfileFromEnvironment(environment), api, now);
    }
    if (environment.CRM_RUNTIME_SOURCE?.trim() || environment.CRM_RUNTIME_PROFILE !== runtimeProfilePath
      || mysqlEnvironmentKeys.some(key => environment[key]?.trim())) throw new Error();
    return validateRuntimeConfiguration(readPrivate(root, runtimeProfilePath), api, now);
  } catch { throw new RuntimeConfigurationError(); }
}
