import { z } from "zod";
import type { LocalMysqlConfig } from "../../src/crm/config/mysql.js";
import { mysqlMigrations } from "../../src/crm/db/mysql/migrations.js";
export class CrmDemoRefusal extends Error {
  constructor(readonly code: "ARGUMENTS" | "APPROVAL" | "TARGET" | "OWNERSHIP" | "STATE" | "DATABASE" | "CHECK_FAILED") {
    super("Local CRM demonstration refused; retain all partial targets and evidence. No automatic retry or cleanup.");
  }
}
export const acknowledgement = "--acknowledge-new-isolated-crm-and-retained-ddl";
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const serverId = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
export function targetFor(id: string) {
  if (!uuid.safeParse(id).success) throw new CrmDemoRefusal("TARGET");
  const hex = id.replaceAll("-", "");
  return Object.freeze({ host: "127.0.0.1" as const, port: 3308 as const, database: `crm_local_crm_${hex}`,
    runtimeUser: `crm_r_${hex.slice(0, 24)}`, migrationUser: `crm_m_${hex.slice(0, 24)}`, fixtureUser: `crm_f_${hex.slice(0, 24)}` });
}
export type CrmDemoTarget = ReturnType<typeof targetFor>;
export interface CrmDemoArguments { mode: "plan" | "diagnose" | "provision" | "run"; fixtureId?: string; chromium?: boolean; retainDemoAccess?: boolean }
export function parseArguments(args: readonly string[]): CrmDemoArguments {
  const mode = args[0];
  if (mode === "plan" && args.length === 1) return { mode };
  if (mode !== "diagnose" && mode !== "provision" && mode !== "run") throw new CrmDemoRefusal("ARGUMENTS");
  const live = mode !== "diagnose";
  const extra = args.slice(4), flags = new Set(extra);
  if (args.length < (live ? 4 : 3) || args[1] !== "--fixture-id" || (live && args[3] !== acknowledgement)
    || (mode !== "run" && args.length !== (live ? 4 : 3)) || flags.size !== extra.length
    || extra.some(flag => !["--chromium", "--retain-demo-access"].includes(flag))) throw new CrmDemoRefusal("ARGUMENTS");
  const fixtureId = args[2]!; targetFor(fixtureId);
  return { mode, fixtureId, ...(flags.has("--chromium") ? { chromium: true } : {}),
    ...(flags.has("--retain-demo-access") ? { retainDemoAccess: true } : {}) };
}
const scopes = z.object({ provision: z.boolean(), migrate: z.boolean(), syntheticWrites: z.boolean(),
  authentication: z.boolean(), crmWorkflows: z.boolean(), http: z.boolean(), chromium: z.boolean(), retainDemoAccess: z.boolean() }).strict();
const targetSchema = z.object({ host: z.literal("127.0.0.1"), port: z.literal(3308), database: z.string(),
  runtimeUser: z.string(), migrationUser: z.string(), fixtureUser: z.string() }).strict();
const approvalSchema = z.object({ version: z.literal(1), fixtureId: uuid, target: targetSchema, approved: z.literal(true),
  approvalReference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$/), validFrom: z.iso.datetime(), validUntil: z.iso.datetime(),
  serverUuid: serverId, harnessDigest: z.string().regex(/^[a-f0-9]{64}$/), exclusiveOperatorWindow: z.literal(true), scopes }).strict();
export type CrmDemoApproval = z.infer<typeof approvalSchema>;
export function parseApproval(input: unknown, fixtureId: string, digest: string, now = Date.now()): CrmDemoApproval {
  try {
    const value = approvalSchema.parse(input);
    if (!Number.isFinite(now) || value.fixtureId !== fixtureId || JSON.stringify(value.target) !== JSON.stringify(targetFor(fixtureId))
      || value.harnessDigest !== digest || Date.parse(value.validFrom) > now || Date.parse(value.validUntil) <= now
      || Date.parse(value.validUntil) - Date.parse(value.validFrom) > 86_400_000) throw new Error();
    return value;
  } catch { throw new CrmDemoRefusal("APPROVAL"); }
}
export function requireScopes(value: CrmDemoApproval, args: CrmDemoArguments): void {
  if ((args.mode === "provision" && (!value.scopes.provision || !value.scopes.migrate))
    || (args.mode === "run" && (!value.scopes.syntheticWrites || !value.scopes.authentication || !value.scopes.crmWorkflows || !value.scopes.http
      || (args.chromium && !value.scopes.chromium) || (args.retainDemoAccess && !value.scopes.retainDemoAccess)))) {
    throw new CrmDemoRefusal("APPROVAL");
  }
}
const profileSchema = z.object({ provider: z.literal("mysql"), environment: z.enum(["development", "test"]), host: z.literal("127.0.0.1"),
  port: z.literal(3308), database: z.string(), user: z.string(), password: z.string().min(1).max(4096)
    .refine(value => !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 4096) }).strict();
export function parseProfile(input: unknown, target: CrmDemoTarget, kind: "runtime" | "migration" | "fixture" | "operator"): Readonly<LocalMysqlConfig> {
  try {
    const value = profileSchema.parse(input);
    if (kind === "operator") {
      if (value.environment !== "development" || value.database !== "crm_local_dev" || value.user !== "root") throw new Error();
    } else if (value.environment !== "test" || value.database !== target.database || value.user !== target[`${kind}User`]) throw new Error();
    return Object.freeze(value);
  } catch { throw new CrmDemoRefusal("TARGET"); }
}
const ownershipSchema = z.object({ version: z.literal(1), fixtureId: uuid, target: targetSchema, serverUuid: serverId,
  harnessDigest: z.string().regex(/^[a-f0-9]{64}$/), owner: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.iso.datetime() }).strict();
export type CrmDemoOwnership = z.infer<typeof ownershipSchema>;
export function parseOwnership(input: unknown, approval: CrmDemoApproval): CrmDemoOwnership {
  try {
    const value = ownershipSchema.parse(input);
    if (value.fixtureId !== approval.fixtureId || value.serverUuid !== approval.serverUuid || value.harnessDigest !== approval.harnessDigest
      || JSON.stringify(value.target) !== JSON.stringify(approval.target) || Date.parse(value.createdAt) < Date.parse(approval.validFrom)
      || Date.parse(value.createdAt) >= Date.parse(approval.validUntil)) throw new Error();
    return value;
  } catch { throw new CrmDemoRefusal("OWNERSHIP"); }
}
const receiptSchema = z.object({ version: z.literal(1), owner: z.string().regex(/^[a-f0-9]{64}$/), fixtureId: uuid, serverUuid: serverId,
  phase: z.literal("provisioned"), migrationApplied: z.literal(mysqlMigrations.length), migrationRepeat: z.literal(0),
  profiles: z.object({ runtime: z.string(), migration: z.string(), fixture: z.string() }).strict() }).strict();
export function parseReceipt(input: unknown, ownership: CrmDemoOwnership, fingerprints: {runtime:string;migration:string;fixture:string}): void {
  try {
    const value = receiptSchema.parse(input);
    if (value.owner !== ownership.owner || value.fixtureId !== ownership.fixtureId || value.serverUuid !== ownership.serverUuid
      || JSON.stringify(value.profiles) !== JSON.stringify(fingerprints)) throw new Error();
  } catch { throw new CrmDemoRefusal("OWNERSHIP"); }
}
