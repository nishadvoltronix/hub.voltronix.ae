// Source-observed keys, not a role hierarchy. See docs/php-auth-security-audit.md.
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
  Electrical: "electrical.manage",
  Civil: "civil.manage",
  PM: "project_manager.manage",
  Switchgear: "switchgear.manage",
  Maintenance: "maintenance.manage",
} as const satisfies Record<string, PermissionKey>;
