import type { MysqlDatabase } from "../db/mysql/database.js";
import { hash } from "bcryptjs";
import { z } from "zod";
import { createAuthService, type AuthUser } from "../auth/service.js";

// Verified forms: application/views/Permissions/*.php. No employee/external ID
// editing or deletion is offered because those workflows are not established there.
export const DEPARTMENTS = ["Electrical", "Civil", "PM", "Switchgear", "Maintenance", "Accounts", "Operations"] as const;
type Token = string | undefined | null;
export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }
export interface UserRecord {
  id: string; name: string; email: string; status: "active" | "inactive";
  externalUserId: string | null; departmentRole: string | null;
  departmentAssignedBy: string | null; departmentAssignedAt: string | null; version: number;
}
export interface GroupRecord { id: string; key: string; label: string; sortOrder: number; version: number }
export interface PermissionRecord {
  id: string; key: string; label: string; groupId: string | null; groupLabel: string | null; version: number;
}
export interface GrantUser { id: string; name: string; email: string }
export interface GrantsRecord { user: GrantUser; permissionIds: string[]; version: number }
export class SettingsError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409 | 503, message?: string) {
    super(message ?? ({ 400: "Invalid settings input.", 401: "Sign in required.", 403: "Access denied.",
      404: "Record not found.", 409: "The record changed or conflicts with an existing record. Reload and try again.",
      503: "Settings are temporarily unavailable." })[status]);
    this.name = "SettingsError";
  }
}
const idSchema = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n);
const text = (max: number) => z.string().trim().min(1).max(max).refine((value) => !value.includes("\0"));
const versionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const statusSchema = z.enum(["active", "inactive"]);
const passwordSchema = z.string().min(12).max(72).refine((value) => Array.from(value).length >= 12 &&
  Buffer.byteLength(value, "utf8") <= 72 && !value.includes("\0"));
const userFields = { name: text(120), email: z.email().max(254).transform((value) => value.toLowerCase()), status: statusSchema };
const createUserSchema = z.object({ ...userFields, password: passwordSchema }).strict();
const updateUserSchema = z.object({ ...userFields, version: versionSchema, password: passwordSchema.optional() }).strict();
const statusInput = z.object({ version: versionSchema, status: statusSchema }).strict();
const departmentInput = z.object({ version: versionSchema, departmentRole: z.enum(DEPARTMENTS) }).strict();
const groupFields = { label: text(120), sortOrder: z.number().int().min(-2_147_483_648).max(2_147_483_647) };
const createGroupSchema = z.object({ ...groupFields, key: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).strict();
const updateGroupSchema = z.object({ ...groupFields, version: versionSchema }).strict();
const permissionFields = { label: text(120), groupId: idSchema };
const createPermissionSchema = z.object({ ...permissionFields, key: z.string().regex(/^[a-z0-9._-]{1,100}$/) }).strict();
const updatePermissionSchema = z.object({ ...permissionFields, version: versionSchema }).strict();
const grantsInput = z.object({ version: versionSchema,
  permissionIds: z.array(idSchema).max(500).refine((ids) => new Set(ids).size === ids.length),
}).strict();
const pageInput = z.object({
  query: z.string().trim().max(120).refine((value) => !value.includes("\0")).default(""),
  page: z.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
}).strict();
const userProjection = `CAST(id AS CHAR) AS id, username AS name, email, status,
  user_id AS externalUserId, department_role AS departmentRole,
  CAST(department_assigned_by AS CHAR) AS departmentAssignedBy,
  department_assigned_date AS departmentAssignedAt, version`;
const groupProjection = `CAST(id AS CHAR) AS id, \`key\`, label, sort_order AS sortOrder, version`;
const permissionProjection = `CAST(p.id AS CHAR) AS id, p.\`key\`, p.label,
  CAST(p.group_id AS CHAR) AS groupId, g.label AS groupLabel, p.version`;

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new SettingsError(400);
  return result.data;
}
function escapedSearch(value: string): string { return `%${value.replace(/[!%_]/g, "!$&")}%`; }

/** All callers supply an opaque session token; never trust an actor ID or browser role. */
export function createSettingsService(db: MysqlDatabase) {
  const auth = createAuthService(db);
  async function authorize(token: Token, users = false): Promise<AuthUser> {
    const actor = await auth.authenticate(token);
    if (!actor) throw new SettingsError(401);
    if (!actor.permissions.includes("permissions.manage") || (users && !actor.permissions.includes("users.write"))) {
      throw new SettingsError(403);
    }
    return actor;
  }
  async function safe<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (error instanceof SettingsError) throw error;
      if (typeof error === "object" && error !== null && "code" in error &&
        ["ER_DUP_ENTRY", "MYSQL_CONFLICT"].includes(String(error.code))) {
        throw new SettingsError(409);
      }
      // Driver messages can contain schema details or input; never propagate them.
      throw new SettingsError(503);
    }
  }
  function read<T>(token: Token, users: boolean, operation: (actor: AuthUser) => T | Promise<T>): Promise<T> {
    return safe(() => db.transaction(async () => operation(await authorize(token, users)))());
  }
  function write<T>(token: Token, users: boolean, operation: (actor: AuthUser) => T | Promise<T>): Promise<T> {
    return safe(() => db.transaction(async () => operation(await authorize(token, users))).immediate());
  }
  async function audit(actor: AuthUser, target: "users" | "permission_groups" | "permissions", id: string,
    action: string, fields: string[]) {
    await db.prepare(`INSERT INTO crm_audit_events(actor_user_id,target_type,target_id,action,changed_fields)
      VALUES(?,?,?,?,?)`).run(actor.localUserId, target, id, action, JSON.stringify(fields));
  }
  async function user(id: string): Promise<UserRecord> {
    const row = await db.prepare(`SELECT ${userProjection} FROM users WHERE id=?`).get(id) as UserRecord | undefined;
    if (!row) throw new SettingsError(404);
    return row;
  }
  async function group(id: string): Promise<GroupRecord> {
    const row = await db.prepare(`SELECT ${groupProjection} FROM permission_groups WHERE id=?`).get(id) as GroupRecord | undefined;
    if (!row) throw new SettingsError(404);
    return row;
  }
  async function permission(id: string): Promise<PermissionRecord> {
    const row = await db.prepare(`SELECT ${permissionProjection} FROM permissions p
      LEFT JOIN permission_groups g ON g.id=p.group_id WHERE p.id=?`).get(id) as PermissionRecord | undefined;
    if (!row) throw new SettingsError(404);
    return row;
  }
  function currentVersion(actual: number, expected: number) { if (actual !== expected) throw new SettingsError(409); }
  function requireChanged(result: { changes: number }) { if (result.changes !== 1) throw new SettingsError(409); }
  async function revokeSessions(id: string) { await db.prepare("DELETE FROM crm_sessions WHERE user_id=?").run(id); }
  function listUsers(token: Token, input: unknown = {}): Promise<Page<UserRecord>> {
    return read(token, true, async () => {
      const value = parse(pageInput, input), search = escapedSearch(value.query);
      const filter = "username LIKE ? ESCAPE '!' OR email LIKE ? ESCAPE '!'";
      const total = (await db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${filter}`).get(search, search) as { n: number }).n;
      const items = await db.prepare(`SELECT ${userProjection} FROM users WHERE ${filter} ORDER BY id
        LIMIT ? OFFSET ?`).all(search, search, value.pageSize, (value.page - 1) * value.pageSize) as UserRecord[];
      return { items, total, page: value.page, pageSize: value.pageSize };
    });
  }
  function getUser(token: Token, id: unknown): Promise<UserRecord> { return read(token, true, () => user(parse(idSchema, id))); }
  async function createUser(token: Token, input: unknown): Promise<UserRecord> {
    // Recheck the live actor after bcrypt yields and inside the write transaction.
    const value = await read(token, true, () => parse(createUserSchema, input));
    const password = await hash(value.password, 12);
    return write(token, true, async (actor) => {
      const inserted = await db.prepare("INSERT INTO users(username,email,password,status) VALUES(?,?,?,?)")
        .safeIntegers(true).run(value.name, value.email, password, value.status);
      const id = String(inserted.lastInsertRowid);
      await audit(actor, "users", id, "users.create", ["name", "email", "password", "status"]);
      return user(id);
    });
  }
  async function updateUser(token: Token, id: unknown, input: unknown): Promise<UserRecord> {
    const { targetId, value } = await read(token, true, async () => {
      const targetId = parse(idSchema, id), value = parse(updateUserSchema, input);
      currentVersion((await user(targetId)).version, value.version);
      return { targetId, value };
    });
    const password = value.password === undefined ? undefined : await hash(value.password, 12);
    return write(token, true, async (actor) => {
      const previous = await user(targetId);
      currentVersion(previous.version, value.version);
      const fields: string[] = [];
      if (previous.name !== value.name) fields.push("name");
      if (previous.email !== value.email) fields.push("email");
      if (previous.status !== value.status) fields.push("status");
      if (password !== undefined) fields.push("password");
      requireChanged(await db.prepare(`UPDATE users SET username=?,email=?,status=?,password=COALESCE(?,password),
        version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND version=?`)
        .run(value.name, value.email, value.status, password ?? null, targetId, value.version));
      if (password !== undefined || previous.email !== value.email || previous.status !== value.status) await revokeSessions(targetId);
      await audit(actor, "users", targetId, "users.update", fields);
      return user(targetId);
    });
  }
  function setUserStatus(token: Token, id: unknown, input: unknown): Promise<UserRecord> {
    return write(token, true, async (actor) => {
      const targetId = parse(idSchema, id), value = parse(statusInput, input), previous = await user(targetId);
      currentVersion(previous.version, value.version);
      requireChanged(await db.prepare("UPDATE users SET status=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND version=?")
        .run(value.status, targetId, value.version));
      if (previous.status !== value.status) await revokeSessions(targetId);
      await audit(actor, "users", targetId, "users.status", previous.status === value.status ? [] : ["status"]);
      return user(targetId);
    });
  }
  function assignDepartment(token: Token, id: unknown, input: unknown): Promise<UserRecord> {
    return write(token, true, async (actor) => {
      const targetId = parse(idSchema, id), value = parse(departmentInput, input), previous = await user(targetId);
      currentVersion(previous.version, value.version);
      requireChanged(await db.prepare(`UPDATE users SET department_role=?,department_assigned_by=?,department_assigned_date=CURRENT_TIMESTAMP,
        version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND version=?`)
        .run(value.departmentRole, actor.localUserId, targetId, value.version));
      await audit(actor, "users", targetId, "users.department", ["departmentRole", "departmentAssignedBy", "departmentAssignedAt"]);
      return user(targetId);
    });
  }
  function listGroups(token: Token, input: unknown = {}): Promise<Page<GroupRecord>> {
    return read(token, false, async () => {
      const value = parse(pageInput, input), search = escapedSearch(value.query);
      const filter = "`key` LIKE ? ESCAPE '!' OR label LIKE ? ESCAPE '!'";
      const total = (await db.prepare(`SELECT COUNT(*) AS n FROM permission_groups WHERE ${filter}`).get(search, search) as { n: number }).n;
      const items = await db.prepare(`SELECT ${groupProjection} FROM permission_groups WHERE ${filter} ORDER BY sort_order,id
        LIMIT ? OFFSET ?`).all(search, search, value.pageSize, (value.page - 1) * value.pageSize) as GroupRecord[];
      return { items, total, page: value.page, pageSize: value.pageSize };
    });
  }
  function getGroup(token: Token, id: unknown): Promise<GroupRecord> { return read(token, false, () => group(parse(idSchema, id))); }
  function createGroup(token: Token, input: unknown): Promise<GroupRecord> {
    return write(token, false, async (actor) => {
      const value = parse(createGroupSchema, input);
      const inserted = await db.prepare('INSERT INTO permission_groups(`key`,label,sort_order) VALUES(?,?,?)')
        .safeIntegers(true).run(value.key, value.label, value.sortOrder);
      const id = String(inserted.lastInsertRowid);
      await audit(actor, "permission_groups", id, "groups.create", ["key", "label", "sortOrder"]);
      return group(id);
    });
  }
  function updateGroup(token: Token, id: unknown, input: unknown): Promise<GroupRecord> {
    return write(token, false, async (actor) => {
      const targetId = parse(idSchema, id), value = parse(updateGroupSchema, input), previous = await group(targetId);
      currentVersion(previous.version, value.version);
      requireChanged(await db.prepare("UPDATE permission_groups SET label=?,sort_order=?,version=version+1 WHERE id=? AND version=?")
        .run(value.label, value.sortOrder, targetId, value.version));
      await audit(actor, "permission_groups", targetId, "groups.update",
        [...(previous.label !== value.label ? ["label"] : []), ...(previous.sortOrder !== value.sortOrder ? ["sortOrder"] : [])]);
      return group(targetId);
    });
  }
  function listPermissions(token: Token, input: unknown = {}): Promise<Page<PermissionRecord>> {
    return read(token, false, async () => {
      const value = parse(pageInput, input), search = escapedSearch(value.query);
      const filter = "p.`key` LIKE ? ESCAPE '!' OR p.label LIKE ? ESCAPE '!'";
      const total = (await db.prepare(`SELECT COUNT(*) AS n FROM permissions p WHERE ${filter}`).get(search, search) as { n: number }).n;
      const items = await db.prepare(`SELECT ${permissionProjection} FROM permissions p LEFT JOIN permission_groups g ON g.id=p.group_id
        WHERE ${filter} ORDER BY g.sort_order,p.id LIMIT ? OFFSET ?`)
        .all(search, search, value.pageSize, (value.page - 1) * value.pageSize) as PermissionRecord[];
      return { items, total, page: value.page, pageSize: value.pageSize };
    });
  }
  function getPermission(token: Token, id: unknown): Promise<PermissionRecord> {
    return read(token, false, () => permission(parse(idSchema, id)));
  }
  function createPermission(token: Token, input: unknown): Promise<PermissionRecord> {
    return write(token, false, async (actor) => {
      const value = parse(createPermissionSchema, input);
      await group(value.groupId);
      const inserted = await db.prepare('INSERT INTO permissions(`key`,label,group_id) VALUES(?,?,?)')
        .safeIntegers(true).run(value.key, value.label, value.groupId);
      const id = String(inserted.lastInsertRowid);
      await audit(actor, "permissions", id, "permissions.create", ["key", "label", "groupId"]);
      return permission(id);
    });
  }
  function updatePermission(token: Token, id: unknown, input: unknown): Promise<PermissionRecord> {
    return write(token, false, async (actor) => {
      const targetId = parse(idSchema, id), value = parse(updatePermissionSchema, input), previous = await permission(targetId);
      currentVersion(previous.version, value.version);
      await group(value.groupId);
      requireChanged(await db.prepare("UPDATE permissions SET label=?,group_id=?,version=version+1 WHERE id=? AND version=?")
        .run(value.label, value.groupId, targetId, value.version));
      await audit(actor, "permissions", targetId, "permissions.update",
        [...(previous.label !== value.label ? ["label"] : []), ...(previous.groupId !== value.groupId ? ["groupId"] : [])]);
      return permission(targetId);
    });
  }
  // The PHP permission assignment form has its own user selector under permissions.manage.
  function listGrantUsers(token: Token, input: unknown = {}): Promise<Page<GrantUser>> {
    return read(token, false, async () => {
      const value = parse(pageInput, input), search = escapedSearch(value.query);
      const filter = "username LIKE ? ESCAPE '!' OR email LIKE ? ESCAPE '!'";
      const total = (await db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${filter}`).get(search, search) as { n: number }).n;
      const items = await db.prepare(`SELECT CAST(id AS CHAR) AS id,username AS name,email FROM users WHERE ${filter}
        ORDER BY id LIMIT ? OFFSET ?`).all(search, search, value.pageSize, (value.page - 1) * value.pageSize) as GrantUser[];
      return { items, total, page: value.page, pageSize: value.pageSize };
    });
  }
  async function grants(id: string): Promise<GrantsRecord> {
    const target = await db.prepare("SELECT CAST(id AS CHAR) AS id,username AS name,email,grants_version AS version FROM users WHERE id=?")
      .get(id) as (GrantUser & { version: number }) | undefined;
    if (!target) throw new SettingsError(404);
    const permissionIds = (await db.prepare("SELECT CAST(permission_id AS CHAR) AS id FROM admin_user_permissions WHERE admin_user_id=? ORDER BY permission_id")
      .all(id) as { id: string }[]).map((row) => row.id);
    return { user: { id: target.id, name: target.name, email: target.email }, permissionIds, version: target.version };
  }
  function getGrants(token: Token, id: unknown): Promise<GrantsRecord> { return read(token, false, () => grants(parse(idSchema, id))); }
  function replaceGrants(token: Token, id: unknown, input: unknown): Promise<GrantsRecord> {
    return write(token, false, async (actor) => {
      const targetId = parse(idSchema, id), value = parse(grantsInput, input), previous = await grants(targetId);
      currentVersion(previous.version, value.version);
      for (const permissionId of value.permissionIds) await permission(permissionId);
      requireChanged(await db.prepare("UPDATE users SET grants_version=grants_version+1 WHERE id=? AND grants_version=?").run(targetId, value.version));
      await db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=?").run(targetId);
      const insert = db.prepare("INSERT INTO admin_user_permissions(admin_user_id,permission_id) VALUES(?,?)");
      for (const permissionId of value.permissionIds) await insert.run(targetId, permissionId);
      await audit(actor, "users", targetId, "grants.replace", ["permissionIds"]);
      return grants(targetId);
    });
  }
  return { listUsers, getUser, createUser, updateUser, setUserStatus, assignDepartment,
    listGroups, getGroup, createGroup, updateGroup, listPermissions, getPermission, createPermission,
    updatePermission, listGrantUsers, getGrants, replaceGrants };
}
