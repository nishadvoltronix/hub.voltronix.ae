import type { Database } from "better-sqlite3";
import { hash } from "bcryptjs";
import { z } from "zod";
import { PERMISSION_KEYS } from "./permissions";

const provisionInput = z.object({
  environment: z.literal("development"),
  email: z.email().max(254).transform((value) => value.toLowerCase()),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(12).max(72).refine((value) => Array.from(value).length >= 12 &&
    Buffer.byteLength(value, "utf8") <= 72 && !value.includes("\0")),
  externalUserId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
  permissions: z.array(z.enum(PERMISSION_KEYS)).max(PERMISSION_KEYS.length),
}).strict();

export class DevelopmentUserError extends Error {
  constructor(message = "Development user configuration is invalid.") {
    super(message);
    this.name = "DevelopmentUserError";
  }
}

/** Explicit operator provisioning only; never called by app startup or migrations. */
export async function createDevelopmentUser(db: Database, input: unknown): Promise<string> {
  const parsed = provisionInput.safeParse(input);
  if (!parsed.success) throw new DevelopmentUserError();
  const value = parsed.data;
  // Fast precheck; the transactional unique constraints below remain authoritative.
  if (db.prepare("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE").get(value.email)) {
    throw new DevelopmentUserError("Development user already exists; nothing was overwritten.");
  }
  const password = await hash(value.password, 12);
  try {
    return db.transaction(() => {
      const result = db.prepare(`INSERT INTO users(user_id, username, email, password, status)
        VALUES (?, ?, ?, ?, 'active')`).safeIntegers(true)
        .run(value.externalUserId ?? null, value.name, value.email, password);
      const localId = String(result.lastInsertRowid);
      for (const key of new Set(value.permissions)) {
        // This catalogue is source-observed configuration, not fabricated CRM history.
        db.prepare(`INSERT INTO permissions("key", label) VALUES (?, ?)
          ON CONFLICT("key") DO NOTHING`).run(key, key);
        db.prepare(`INSERT INTO admin_user_permissions(admin_user_id, permission_id)
          SELECT ?, id FROM permissions WHERE "key" = ?`).run(localId, key);
      }
      return localId;
    }).immediate();
  } catch {
    // SQLite constraint messages may include user data. Do not forward them to logs.
    throw new DevelopmentUserError("Development user could not be created; no changes were applied.");
  }
}
