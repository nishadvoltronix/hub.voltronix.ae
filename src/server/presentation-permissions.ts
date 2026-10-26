/** Personal dashboard views are separate from department job-management grants. */
export const DASHBOARD_SECTIONS = [
  { key: "sales", label: "Sales", permission: "sales_dashboard.view", department: null },
  { key: "electrical", label: "Electrical", permission: "electric_dashboard.view", department: "Electrical" },
  { key: "civil", label: "Civil", permission: "civil_dashboard.view", department: "Civil" },
  { key: "pm", label: "Project Manager", permission: "pm_dashboard.view", department: "PM" },
  { key: "switchgear", label: "Switchgear", permission: "switchgear_dashboard.view", department: "Switchgear" },
  { key: "maintenance", label: "Maintenance", permission: "maintenance_dashboard.view", department: "Maintenance" },
] as const;

export type DashboardSectionKey = (typeof DASHBOARD_SECTIONS)[number]["key"];

export function dashboardSection(value: unknown) {
  return typeof value === "string" ? DASHBOARD_SECTIONS.find(section => section.key === value) : undefined;
}

/** Presentation visibility only. Express authorizes every protected operation. */
export function hasDashboardAccess(permissions: readonly string[]): boolean {
  return permissions.includes("dashboard.view") || DASHBOARD_SECTIONS.some(section => permissions.includes(section.permission));
}
