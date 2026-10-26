import { resolve, sep } from "node:path";
import { z } from "zod";

const environmentSchema = z.object({
  DATABASE_ENVIRONMENT: z.enum(["development", "test"]),
  SQLITE_DATABASE_PATH: z.string().min(1).max(240),
});

export class DatabaseConfigurationError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    const safeFields = [...new Set(fields)].filter((field) => ["DATABASE_PROVIDER", "DATABASE_ENVIRONMENT", "SQLITE_DATABASE_PATH"].includes(field)).sort();
    super("Invalid database configuration: " + safeFields.join(", ") + ".");
    this.name = "DatabaseConfigurationError";
    this.fields = safeFields;
  }
}

export interface DatabaseConfig {
  environment: "development" | "test";
  applicationDirectory: string;
  filename: string;
}

/** Explicit local-only configuration. No credentials, connections, or filesystem writes. */
export function parseDatabaseConfig(
  environment: Record<string, string | undefined>,
  applicationDirectory = process.cwd(),
): DatabaseConfig {
  // Preserve the existing local fixture contract, but never silently fall back
  // when the new MySQL provider (or an unknown provider) is selected.
  if (environment.DATABASE_PROVIDER !== undefined && environment.DATABASE_PROVIDER !== "sqlite") {
    throw new DatabaseConfigurationError(["DATABASE_PROVIDER"]);
  }
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    throw new DatabaseConfigurationError(result.error.issues.map((issue) => String(issue.path[0])));
  }
  const parts = result.data.SQLITE_DATABASE_PATH.replaceAll("\\", "/").split("/");
  if (parts.length < 3 || parts[0] !== ".local-data" || parts[1] !== result.data.DATABASE_ENVIRONMENT ||
      !parts.every((part) => /^[a-zA-Z0-9._-]+$/.test(part) && part !== "." && part !== ".." && !part.endsWith(".") &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) ||
      !/\.(?:sqlite|sqlite3|db)$/.test(parts.at(-1) ?? "")) {
    throw new DatabaseConfigurationError(["SQLITE_DATABASE_PATH"]);
  }
  // Runtime local data must never become an input to the application bundle trace.
  const root = resolve(/* turbopackIgnore: true */ applicationDirectory);
  const filename = resolve(/* turbopackIgnore: true */ root, ...parts);
  if (!filename.startsWith(root + sep)) throw new DatabaseConfigurationError(["SQLITE_DATABASE_PATH"]);
  return { environment: result.data.DATABASE_ENVIRONMENT, applicationDirectory: root, filename };
}
