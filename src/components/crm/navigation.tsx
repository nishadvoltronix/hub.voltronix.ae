"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { AuthUser } from "@voltronix/crm-contracts";
import { DASHBOARD_SECTIONS, hasDashboardAccess } from "@/server/presentation-permissions";
import { DEPARTMENT_PERMISSIONS } from "@/server/auth/permissions";

type Entry = { href: string; label: string; accessible?: string };
type Group = { label: string; icon: string; entries: Entry[]; direct?: boolean };
function NavigationGroup({ group, query, onNavigate }: { group: Group; query: string; onNavigate: () => void }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const activeEntry = group.entries.filter((entry) => {
    const [path = "", query = ""] = entry.href.split("?");
    const matchesPath = pathname === path || pathname.startsWith(path + "/") || (path === "/pipeline" && pathname.startsWith("/leads/"));
    return matchesPath && [...new URLSearchParams(query)].every(([key, value]) => search.get(key) === value);
  })
    .sort((left, right) => right.href.length - left.href.length)[0]?.href;
  const active = Boolean(activeEntry);
  const [open, setOpen] = useState(active);
  const id = "nav-" + group.label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const entries = group.entries.filter((entry) => `${group.label} ${entry.label} ${entry.accessible ?? ""}`.toLowerCase().includes(query));
  const firstEntry = entries[0];
  if (!firstEntry) return null;
  if (group.direct) return <li className={`pc-item${active ? " active" : ""}`}>
    <Link className="pc-link" href={firstEntry.href} aria-label={firstEntry.accessible} aria-current={active ? "page" : undefined} onClick={onNavigate}>
      <span className="pc-micon"><i className={group.icon} aria-hidden="true" /></span><span className="pc-mtext">{group.label}</span>
    </Link>
  </li>;
  const expanded = query.length > 0 || open;
  return <li className={`pc-item pc-hasmenu${active ? " active" : ""}${expanded ? " pc-trigger" : ""}`}>
    <button className="pc-link" type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setOpen(!open)}>
      <span className="pc-micon"><i className={group.icon} aria-hidden="true" /></span><span className="pc-mtext">{group.label}</span><span className="pc-arrow"><i className="ti ti-chevron-right" aria-hidden="true" /></span>
    </button>
    <ul className="pc-submenu" id={id} hidden={!expanded}>{entries.map((entry) => <li className={`pc-item${entry.href === activeEntry ? " active" : ""}`} key={entry.href}>
      <Link className="pc-link" href={entry.href} aria-label={entry.accessible} aria-current={entry.href === activeEntry ? (entry.href.split("?")[0] === pathname ? "page" : "location") : undefined} onClick={onNavigate}>{entry.label}</Link>
    </li>)}</ul>
  </li>;
}

export function CrmNavigation({ user, query = "", onNavigate = () => {} }: { user: AuthUser; query?: string; onNavigate?: () => void }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const mainDashboardActive = pathname === "/dashboard" && !search.has("section");
  const has = (permission: string) => user.permissions.includes(permission);
  const commercial: Group[] = [];
  const sales = DASHBOARD_SECTIONS[0];
  if (has(sales.permission)) commercial.push({ label: sales.label, icon: "ph ph-chart-line-up", direct: true, entries: [
    { href: `/dashboard?section=${sales.key}`, label: "Dashboard", accessible: `${sales.label} dashboard` },
  ] });
  if (has("leads.view") || has("leads.manage.agents")) commercial.push({ label: "Leads Pipeline", icon: "ph ph-layout", entries: [
    { href: "/pipeline", label: has("leads.manage.agents") || !has("leads.manage") ? "Pipelines" : "Agents Pipelines", accessible: "Lead pipeline" },
    ...(has("leads.manage") ? [{ href: "/pipeline?scope=own", label: `${user.username} Pipeline`, accessible: "Your pipeline" }, { href: "/pipeline?view=agents", label: "Search Agent", accessible: "Search agent pipeline" }] : []),
  ] });
  if (has("deals.manage") || has("deals.view")) commercial.push({ label: "Deals", icon: "ph ph-handshake", entries: [
    ...(has("deals.manage") ? [{ href: "/deals/new", label: "Create Deal", accessible: "Create deal" }] : []),
    ...(has("deals.view") ? [{ href: "/deals", label: "View All Deals", accessible: "Created deals" }] : []),
  ] });
  if (user.permissions.some((key) => ["leads.view", "leads.manage", "leads.manage.agents"].includes(key))) commercial.push({ label: "Quotations", icon: "ph ph-file-plus", entries: [
    ...(has("leads.manage") || has("leads.manage.agents") ? [{ href: "/quotations/new", label: "Create Quotation", accessible: "Create quotation" }] : []), { href: "/quotations", label: "View All Quotations", accessible: "Quotations" },
  ] });
  if (has("items.view") || has("items.write")) commercial.push({ label: "Items", icon: "ti ti-file-invoice-filled", entries: [
    ...(has("items.write") ? [{ href: "/items/new", label: "Create Items", accessible: "Create product" }] : []), { href: "/items", label: "View All Items", accessible: "Products" },
  ] });
  const jobs: Group[] = has("dashboard.view") ? [{ label: "Jobs Departments", icon: "ti ti-briefcase", entries: [
    { href: "/jobs?cohort=pending", label: "Pending Assigning" }, { href: "/jobs?cohort=process", label: "Under Process" }, { href: "/jobs?cohort=completed", label: "Completed" },
    { href: "/jobs?cohort=hold", label: "Hold" }, { href: "/jobs?cohort=closed", label: "Closed" }, { href: "/jobs", label: "All Jobs", accessible: "Jobs" },
  ] }] : [];
  const icons: Record<string, string> = { Electrical: "ph ph-lightning", Civil: "ph ph-buildings", PM: "ph ph-user-gear", Switchgear: "ph ph-lightning", Maintenance: "ph ph-wrench" };
  for (const section of DASHBOARD_SECTIONS) {
    const department = section.department;
    if (!department) continue;
    const canView = has(section.permission);
    const canManage = has(DEPARTMENT_PERMISSIONS[department]);
    if (!canView && !canManage) continue;
    jobs.push({ label: section.label, icon: icons[department] ?? "ph ph-briefcase", direct: !canManage, entries: [
      ...(canView ? [{ href: `/dashboard?section=${section.key}`, label: "Dashboard", accessible: `${section.label} dashboard` }] : []),
      ...(canManage ? [
        { href: `/departments/${department}/jobs?status=Assigned`, label: "Pending" },
        { href: `/departments/${department}/jobs?status=Process`, label: "Process" },
        { href: `/departments/${department}/jobs?status=Completed`, label: "Completed" },
        { href: `/departments/${department}/jobs?status=Hold`, label: "Hold" },
        { href: `/departments/${department}/jobs`, label: "View All", accessible: `${department} jobs` },
      ] : []),
    ] });
  }
  const settings: Group[] = has("permissions.manage") ? [{ label: "Permission & Users", icon: "ti ti-settings", entries: [
    ...(has("users.write") ? [{ href: "/settings/users", label: "Users" }, { href: "/settings/users/departments", label: "Assign Departments", accessible: "Assign departments" }] : []),
    { href: "/settings/permissions/assign", label: "Assign Permissions", accessible: "Assign permissions" }, { href: "/settings/permission-groups", label: "Groups", accessible: "Permission groups" }, { href: "/settings/permissions", label: "Permissions" },
  ] }] : [];
  if (has("dashboard.view")) settings.push({ label: "Reports", icon: "ti ti-report-analytics", entries: [{ href: "/reports/employee-performance", label: "Employee Performance", accessible: "Employee report" }] });
  const normalized = query.trim().toLowerCase();
  return <nav aria-label="CRM navigation" className="navbar-content"><ul className="pc-navbar">
    <li className="pc-item pc-caption"><label>Navigation</label></li>
    {hasDashboardAccess(user.permissions) && (!normalized || "dashboard".includes(normalized)) && <li className={`pc-item${mainDashboardActive ? " active" : ""}`}><Link className="pc-link" href="/dashboard" aria-current={mainDashboardActive ? "page" : undefined} onClick={onNavigate}><span className="pc-micon"><i className="ph ph-house-line" aria-hidden="true" /></span><span className="pc-mtext">Dashboard</span></Link></li>}
    {commercial.map((group) => <NavigationGroup key={group.label} group={group} query={normalized} onNavigate={onNavigate} />)}
    {jobs.length > 0 && <li className="pc-item pc-caption"><label>Jobs</label></li>}
    {jobs.map((group) => <NavigationGroup key={group.label} group={group} query={normalized} onNavigate={onNavigate} />)}
    {settings.length > 0 && <li className="pc-item pc-caption"><label>Settings</label></li>}
    {settings.map((group) => <NavigationGroup key={group.label} group={group} query={normalized} onNavigate={onNavigate} />)}
    <li className={`pc-item${pathname === "/account" ? " active" : ""}`}><Link className="pc-link" href="/account" aria-current={pathname === "/account" ? "page" : undefined} onClick={onNavigate}><span className="pc-micon"><i className="ph ph-user-circle" aria-hidden="true" /></span><span className="pc-mtext">Your account</span></Link></li>
  </ul></nav>;
}

