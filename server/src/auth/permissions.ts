import type { AuthUser } from "@voltronix/crm-contracts";
import { AuthError } from "./errors.js";

// Source-observed explicit grants, never a role hierarchy or superuser bypass.
export const PERMISSION_KEYS = [
  "leads.view", "leads.manage", "leads.manage.agents", "deals.manage", "deals.view",
  "items.write", "items.view", "dashboard.view", "electrical.manage", "civil.manage",
  "project_manager.manage", "switchgear.manage", "maintenance.manage",
  "electric_dashboard.view", "civil_dashboard.view", "pm_dashboard.view",
  "switchgear_dashboard.view", "maintenance_dashboard.view", "sales_dashboard.view",
  "users.write", "permissions.manage",
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export const DEPARTMENT_PERMISSIONS = {
  Electrical: "electrical.manage", Civil: "civil.manage", PM: "project_manager.manage",
  Switchgear: "switchgear.manage", Maintenance: "maintenance.manage",
} as const satisfies Record<string, PermissionKey>;

export function requirePermissions(user: AuthUser, permissions: readonly PermissionKey[]): void {
  if (!permissions.length || permissions.some(key => !PERMISSION_KEYS.includes(key))) throw new AuthError("unavailable");
  if (permissions.some(key => !user.permissions.includes(key))) throw new AuthError("denied");
}

export interface TaskAccessSnapshot {
  assignedTo: string | null;
  latestAssignments: readonly { department: string; userId: string | null }[];
}
/** Pure source policy only. Caller MUST fetch the latest parent/assignment inside
 * its authorized transaction; this function does not load or verify database state.
 */
export function canAccessTask(user: AuthUser, task: TaskAccessSnapshot | null): boolean {
  if (!task) return false;
  if (user.permissions.includes("leads.manage.agents")) {
    if (user.externalUserId !== null && task.assignedTo === user.externalUserId) return true;
  } else if (user.permissions.includes("leads.view")) return true;
  return task.latestAssignments.some(assignment => {
    const grant = Object.hasOwn(DEPARTMENT_PERMISSIONS, assignment.department)
      ? DEPARTMENT_PERMISSIONS[assignment.department as keyof typeof DEPARTMENT_PERMISSIONS] : undefined;
    return assignment.userId === user.localUserId && grant !== undefined && user.permissions.includes(grant);
  });
}
