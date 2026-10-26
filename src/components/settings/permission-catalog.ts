import { z } from "zod";
import type { GrantsRecord, GroupRecord, PermissionRecord } from "@/server/settings/service";

const pageSize = 100;
/** Browser load bound only, not a permission/business rule. Exceeding it refuses
 * the whole editor; a truncated catalogue is never offered for saving. */
export const MAX_PERMISSION_CATALOG_RECORDS = 10_000;
type Reader = (path: string, signal?: AbortSignal) => Promise<unknown>;
const id = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const groupSchema = z.object({ id, key: z.string(), label: z.string(), sortOrder: z.number().int(), version }).strict();
const permissionSchema = z.object({ id, key: z.string(), label: z.string(), groupId: id.nullable(), groupLabel: z.string().nullable(), version }).strict();
const grantsSchema = z.object({ user: z.object({ id, name: z.string(), email: z.string() }).strict(),
  permissionIds: z.array(id).max(MAX_PERMISSION_CATALOG_RECORDS), version }).strict();
const incomplete = "The complete permission catalogue could not be verified. Reload before saving.";
function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value); if (!result.success) throw new Error(incomplete); return result.data;
}
async function completeCatalog<T extends { id: string }>(path: string, schema: z.ZodType<T>, read: Reader, signal?: AbortSignal): Promise<T[]> {
  const pageSchema = z.object({ items: z.array(schema), total: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    page: z.number().int(), pageSize: z.number().int() }).strict();
  const items: T[] = [], ids = new Set<string>(); let total: number | undefined;
  for (let page = 1; ; page++) {
    signal?.throwIfAborted();
    const result = checked(pageSchema, await read(`${path}?page=${page}&pageSize=${pageSize}`, signal));
    signal?.throwIfAborted();
    if (result.total > MAX_PERMISSION_CATALOG_RECORDS) {
      throw new Error("The permission catalogue exceeds the browser's safe load limit. Nothing was loaded for saving.");
    }
    if (total === undefined) total = result.total;
    if (result.page !== page || result.pageSize !== pageSize || result.total !== total
      || result.items.length !== Math.min(pageSize, total - items.length)) throw new Error(incomplete);
    for (const item of result.items) {
      if (ids.has(item.id)) throw new Error(incomplete);
      ids.add(item.id); items.push(item);
    }
    if (items.length === total) return items;
  }
}
export interface PermissionGroup { id: string; label: string; permissions: PermissionRecord[] }
export interface PermissionCatalog { permissions: PermissionRecord[]; groups: PermissionGroup[] }
export interface PermissionEditor { grants: GrantsRecord; catalog: PermissionCatalog }
function groupCatalog(groups: GroupRecord[], permissions: PermissionRecord[]): PermissionCatalog {
  const grouped = new Map(groups.map(group => [group.id, { id: group.id, label: group.label, permissions: [] as PermissionRecord[] }]));
  const other: PermissionGroup = { id: "ungrouped", label: "Other permissions", permissions: [] };
  for (const permission of permissions) {
    if (permission.groupId === null) {
      if (permission.groupLabel !== null) throw new Error(incomplete);
      other.permissions.push(permission);
    } else {
      const group = grouped.get(permission.groupId);
      if (!group || group.label !== permission.groupLabel) throw new Error(incomplete);
      group.permissions.push(permission);
    }
  }
  return { permissions, groups: [...grouped.values(), ...(other.permissions.length ? [other] : [])] };
}
export function checkedGrants(value: unknown, userId: string, catalog: PermissionCatalog): GrantsRecord {
  const grants = checked(grantsSchema, value), known = new Set(catalog.permissions.map(permission => permission.id));
  if (grants.user.id !== userId || new Set(grants.permissionIds).size !== grants.permissionIds.length
    || grants.permissionIds.some(permissionId => !known.has(permissionId))) throw new Error(incomplete);
  return grants;
}
export async function loadPermissionEditor(userId: string, read: Reader, signal?: AbortSignal): Promise<PermissionEditor> {
  checked(id, userId); signal?.throwIfAborted();
  const [groups, permissions, grants] = await Promise.all([
    completeCatalog("/api/settings/permission-groups", groupSchema, read, signal),
    completeCatalog("/api/settings/permissions", permissionSchema, read, signal),
    read(`/api/settings/users/${encodeURIComponent(userId)}/permissions`, signal),
  ]);
  signal?.throwIfAborted();
  const catalog = groupCatalog(groups, permissions);
  return { catalog, grants: checkedGrants(grants, userId, catalog) };
}
/** Filtering affects presentation only; it never supplies a replacement grant set. */
export function filterPermissionGroups(catalog: PermissionCatalog, query: string): PermissionGroup[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return catalog.groups;
  return catalog.groups.map(group => ({ ...group, permissions: group.permissions.filter(permission =>
    `${group.label} ${permission.label} ${permission.key}`.toLocaleLowerCase().includes(needle)) }))
    .filter(group => group.permissions.length > 0);
}
export function grantReplacement(editor: PermissionEditor, selected: string[]): { version: number; permissionIds: string[] } {
  checkedGrants(editor.grants, editor.grants.user.id, editor.catalog);
  if (selected.length > 500) throw new Error("Select no more than 500 permissions before saving."); // Existing API limit.
  const known = new Set(editor.catalog.permissions.map(permission => permission.id));
  if (new Set(selected).size !== selected.length || selected.some(permissionId => !known.has(permissionId))) throw new Error(incomplete);
  return { version: editor.grants.version, permissionIds: [...selected] };
}
