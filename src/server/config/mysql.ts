import { z } from "zod";

const fieldNames = ["DATABASE_PROVIDER", "MYSQL_ENVIRONMENT", "MYSQL_HOST", "MYSQL_PORT", "MYSQL_DATABASE", "MYSQL_USER", "MYSQL_PASSWORD"] as const;
const systemSchemas = new Set(["mysql", "sys", "information_schema", "performance_schema"]);
const schema = z.object({
  DATABASE_PROVIDER: z.literal("mysql"),
  MYSQL_ENVIRONMENT: z.enum(["development", "test"]),
  MYSQL_HOST: z.enum(["127.0.0.1", "::1"]),
  MYSQL_PORT: z.string().regex(/^[1-9][0-9]{0,4}$/).transform(Number).refine((value) => value <= 65_535),
  MYSQL_DATABASE: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).refine((value) => !systemSchemas.has(value.toLowerCase())),
  MYSQL_USER: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/),
  MYSQL_PASSWORD: z.string().min(1).max(4096).refine((value) => !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 4096),
});

export class MysqlConfigurationError extends Error {
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    const safe = [...new Set(fields)].filter((field) => (fieldNames as readonly string[]).includes(field)).sort();
    super(`Invalid local MySQL configuration: ${safe.join(", ")}.`);
    this.name = "MysqlConfigurationError";
    this.fields = safe;
  }
}

export interface LocalMysqlConfig {
  provider: "mysql";
  environment: "development" | "test";
  host: "127.0.0.1" | "::1";
  port: number;
  database: string;
  user: string;
  password: string;
}

/** Local preparation only. Does not read files, connect, create a schema or select a runtime adapter. */
export function parseLocalMysqlConfig(environment: Record<string, string | undefined>): LocalMysqlConfig {
  const parsed = schema.safeParse(environment);
  if (!parsed.success) throw new MysqlConfigurationError(parsed.error.issues.map((issue) => String(issue.path[0])));
  return { provider: "mysql", environment: parsed.data.MYSQL_ENVIRONMENT, host: parsed.data.MYSQL_HOST,
    port: parsed.data.MYSQL_PORT, database: parsed.data.MYSQL_DATABASE, user: parsed.data.MYSQL_USER, password: parsed.data.MYSQL_PASSWORD };
}

/** Revalidate typed callers too; a hand-built object must not enable remote hosts or driver options. */
export function validateLocalMysqlConfig(config: LocalMysqlConfig): LocalMysqlConfig {
  return parseLocalMysqlConfig({ DATABASE_PROVIDER: config.provider, MYSQL_ENVIRONMENT: config.environment,
    MYSQL_HOST: config.host, MYSQL_PORT: typeof config.port === "number" ? String(config.port) : undefined,
    MYSQL_DATABASE: config.database, MYSQL_USER: config.user, MYSQL_PASSWORD: config.password });
}
