import { z } from "zod";
import { validateMysqlAuthConfig, type MysqlAuthConfig } from "../../src/db/mysql/config.js";

export type RefusalCode = "ARGUMENTS" | "APPROVAL" | "TARGET" | "PRIVATE_FILE" | "OWNERSHIP" | "STATE" | "DATABASE" | "CHECK_FAILED";
export class HarnessRefusal extends Error {
  constructor(readonly code: RefusalCode) { super("Isolated authentication verification refused; no fallback or automatic repair."); }
}
export const acknowledgement = "--acknowledge-new-isolated-mysql-and-retained-ddl";
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const serverId = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
export function targetFor(fixtureId: string) {
  if (!uuid.safeParse(fixtureId).success) throw new HarnessRefusal("TARGET");
  const hex = fixtureId.replaceAll("-", "");
  return Object.freeze({ host: "127.0.0.1" as const, port: 3308 as const, database: `crm_local_auth_${hex}`,
    runtimeUser: `auth_r_${hex.slice(0, 24)}`, migrationUser: `auth_m_${hex.slice(0, 24)}`, fixtureUser: `auth_f_${hex.slice(0, 24)}` });
}
export type HarnessTarget = ReturnType<typeof targetFor>;
export interface HarnessArguments {
  mode: "plan" | "diagnose" | "provision" | "run";
  fixtureId?: string;
  chromium: boolean;
  cleanup: boolean;
}
export function parseArguments(args: readonly string[]): HarnessArguments {
  const mode = args[0];
  if (!["plan", "diagnose", "provision", "run"].includes(mode ?? "")) throw new HarnessRefusal("ARGUMENTS");
  if (mode === "plan") {
    if (args.length !== 1) throw new HarnessRefusal("ARGUMENTS");
    return { mode, chromium: false, cleanup: false };
  }
  const values = new Map<string, string>(); const flags = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const item = args[i]!;
    if (item === "--fixture-id") {
      if (values.has(item) || !args[i + 1]) throw new HarnessRefusal("ARGUMENTS");
      values.set(item, args[++i]!);
    } else if ([acknowledgement, "--chromium", "--cleanup-owned-fixture"].includes(item) && !flags.has(item)) flags.add(item);
    else throw new HarnessRefusal("ARGUMENTS");
  }
  const fixtureId = values.get("--fixture-id");
  if (!fixtureId) throw new HarnessRefusal("ARGUMENTS");
  targetFor(fixtureId);
  const live = mode === "provision" || mode === "run";
  if (live !== flags.has(acknowledgement) || (mode !== "run" && flags.size > Number(live))) throw new HarnessRefusal("ARGUMENTS");
  return { mode: mode as HarnessArguments["mode"], fixtureId,
    chromium: flags.has("--chromium"), cleanup: flags.has("--cleanup-owned-fixture") };
}
const scopesSchema = z.object({ provision: z.boolean(), migrate: z.boolean(), syntheticWrites: z.boolean(),
  authentication: z.boolean(), http: z.boolean(), faultInjection: z.boolean(), chromium: z.boolean(), cleanupOwned: z.boolean() }).strict();
const targetSchema = z.object({ host: z.literal("127.0.0.1"), port: z.literal(3308), database: z.string(),
  runtimeUser: z.string(), migrationUser: z.string(), fixtureUser: z.string() }).strict();
const approvalSchema = z.object({ version: z.literal(1), fixtureId: uuid, target: targetSchema,
  approved: z.literal(true), approvalReference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$/),
  validFrom: z.iso.datetime(), validUntil: z.iso.datetime(), serverUuid: serverId,
  harnessDigest: z.string().regex(/^[a-f0-9]{64}$/), exclusiveOperatorWindow: z.literal(true),
  scopes: scopesSchema }).strict();
export type HarnessApproval = z.infer<typeof approvalSchema>;
export function parseApproval(value: unknown, fixtureId: string, digest: string, now = Date.now()): HarnessApproval {
  try {
    const approval = approvalSchema.parse(value);
    if (!Number.isFinite(now) || approval.fixtureId !== fixtureId || JSON.stringify(approval.target) !== JSON.stringify(targetFor(fixtureId))
      || approval.harnessDigest !== digest || Date.parse(approval.validFrom) > now || Date.parse(approval.validUntil) <= now
      || Date.parse(approval.validUntil) - Date.parse(approval.validFrom) > 86_400_000) throw new Error();
    return approval;
  } catch { throw new HarnessRefusal("APPROVAL"); }
}
export function requireScopes(approval: HarnessApproval, args: HarnessArguments): void {
  const scopes = approval.scopes;
  if (args.mode === "provision" && (!scopes.provision || !scopes.migrate)) throw new HarnessRefusal("APPROVAL");
  if (args.mode === "run" && (!scopes.syntheticWrites || !scopes.authentication || !scopes.http || !scopes.faultInjection
    || (args.chromium && !scopes.chromium) || (args.cleanup && !scopes.cleanupOwned))) throw new HarnessRefusal("APPROVAL");
}
export function parseProfile(value: unknown, target: HarnessTarget, kind: "runtime" | "migration" | "fixture" | "operator"): Readonly<MysqlAuthConfig> {
  try {
    const config = validateMysqlAuthConfig(value);
    if (kind === "operator") {
      if (config.environment !== "development" || config.database !== "crm_local_dev" || config.user !== "root") throw new Error();
    } else if (config.environment !== "test" || config.database !== target.database || config.user !== target[`${kind}User`]) throw new Error();
    return config;
  } catch { throw new HarnessRefusal("TARGET"); }
}
const ownershipSchema = z.object({ version: z.literal(1), fixtureId: uuid, target: targetSchema,
  serverUuid: serverId, harnessDigest: z.string().regex(/^[a-f0-9]{64}$/), owner: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime() }).strict();
export type Ownership = z.infer<typeof ownershipSchema>;
export function parseOwnership(value: unknown, approval: HarnessApproval): Ownership {
  try {
    const owned = ownershipSchema.parse(value);
    if (owned.fixtureId !== approval.fixtureId || owned.harnessDigest !== approval.harnessDigest || owned.serverUuid !== approval.serverUuid
      || JSON.stringify(owned.target) !== JSON.stringify(approval.target)
      || Date.parse(owned.createdAt) < Date.parse(approval.validFrom) || Date.parse(owned.createdAt) >= Date.parse(approval.validUntil)) throw new Error();
    return owned;
  } catch { throw new HarnessRefusal("OWNERSHIP"); }
}
const receiptSchema = z.object({ version: z.literal(1), owner: z.string(), fixtureId: uuid, serverUuid: serverId,
  phase: z.literal("provisioned"), migrationApplied: z.literal(1), migrationRepeat: z.literal(0),
  profiles: z.object({ runtime: z.string(), migration: z.string(), fixture: z.string() }).strict() }).strict();
export function parseReceipt(value: unknown, owned: Ownership, profiles: {runtime:string;migration:string;fixture:string}) {
  try {
    const receipt = receiptSchema.parse(value);
    if (receipt.owner !== owned.owner || receipt.fixtureId !== owned.fixtureId || receipt.serverUuid !== owned.serverUuid
      || JSON.stringify(receipt.profiles) !== JSON.stringify(profiles)) throw new Error();
    return receipt;
  } catch { throw new HarnessRefusal("OWNERSHIP"); }
}
