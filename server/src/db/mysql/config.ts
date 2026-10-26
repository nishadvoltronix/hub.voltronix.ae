import { z } from "zod";

export class MysqlAuthDatabaseError extends Error {
  constructor() { super("MySQL authentication unavailable; no fallback or automatic retry was attempted."); }
}
export interface MysqlAuthConfig {
  provider: "mysql";
  environment: "development" | "test";
  host: "127.0.0.1";
  port: 3308;
  database: string;
  user: string;
  password: string;
}
const configSchema = z.object({
  provider: z.literal("mysql"), environment: z.enum(["development", "test"]),
  host: z.literal("127.0.0.1"), port: z.literal(3308),
  database: z.string(), user: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/),
  password: z.string().min(1).max(4096).refine(value => !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 4096),
}).strict().refine(value => value.environment === "development" ? value.database === "crm_local_dev"
  : /^crm_local_auth_[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/.test(value.database));

/** Pure explicit input validation. No environment/profile lookup, connection or fallback.
 * Test target grammar establishes scope, not approval, provenance or empty-target proof.
 */
export function validateMysqlAuthConfig(input: unknown): Readonly<MysqlAuthConfig> {
  try {
    const value = configSchema.parse(input);
    return Object.freeze(value);
  } catch { throw new MysqlAuthDatabaseError(); }
}
