import { z } from "zod";
import type { GrantUser } from "@/server/settings/service";

// The PHP selector lists every authorized user. Keep a complete list while
// respecting the paged API; never display a silently truncated set of choices.
const pageSize = 100;
export const MAX_ADMIN_USER_OPTIONS = 10_000;
const id = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n);
const userSchema = z.object({ id, name: z.string(), email: z.string() }).strict();
const pageSchema = z.object({ items: z.array(userSchema), total: z.number().int().min(0).max(MAX_ADMIN_USER_OPTIONS),
  page: z.number().int(), pageSize: z.number().int() }).strict();
const incomplete = "The admin user list could not be fully loaded. Reload users and try again.";

export async function loadAdminUserOptions(
  read: (path: string, signal?: AbortSignal) => Promise<unknown>, signal?: AbortSignal,
): Promise<GrantUser[]> {
  const users: GrantUser[] = [], ids = new Set<string>();
  let total: number | undefined;
  for (let page = 1; ; page++) {
    signal?.throwIfAborted();
    const parsed = pageSchema.safeParse(await read(`/api/settings/grant-users?page=${page}&pageSize=${pageSize}`, signal));
    signal?.throwIfAborted();
    if (!parsed.success) throw new Error(incomplete);
    const result = parsed.data;
    if (total === undefined) total = result.total;
    if (result.page !== page || result.pageSize !== pageSize || result.total !== total
      || result.items.length !== Math.min(pageSize, total - users.length)) throw new Error(incomplete);
    for (const user of result.items) {
      if (ids.has(user.id)) throw new Error(incomplete);
      ids.add(user.id); users.push(user);
    }
    if (users.length === total) return users;
  }
}
