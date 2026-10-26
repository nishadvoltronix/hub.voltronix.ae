"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { AuthUser } from "@voltronix/crm-contracts";
import { LogoutButton } from "@/components/logout-button";
import { dashboardSection } from "@/server/presentation-permissions";
import { CrmNavigation } from "./navigation";

function pageTitle(pathname: string): string {
  if (pathname === "/deals") return "Self Created Deals";
  if (pathname === "/settings/users/departments") return "Assign Departments";
  const titles: Record<string, string> = { "/account": "Your account", "/dashboard": "Dashboard", "/pipeline": "Leads Pipeline", "/jobs": "Jobs Departments", "/deals/new": "Create Deal", "/items": "Items", "/items/new": "Create Item", "/quotations": "All Quotations", "/quotations/new": "Create Quotation", "/settings/users": "Users", "/settings/permissions": "Permissions", "/settings/permission-groups": "Permission Groups", "/settings/permissions/assign": "Assign Permissions", "/reports/employee-performance": "Employee Performance Report" };
  if (titles[pathname]) return titles[pathname];
  if (pathname.startsWith("/departments/")) return "Department Jobs";
  if (pathname.startsWith("/jobs/")) return "Job Details";
  if (pathname.startsWith("/leads/")) return "Lead Details";
  if (pathname.startsWith("/quotations/")) return pathname.endsWith("/edit") ? "Edit Quotation" : "Quotation Details";
  return "CRM";
}

export function CrmChrome({ user, children }: { user: AuthUser; children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [profile, setProfile] = useState(false);
  const [search, setSearch] = useState(false);
  const [query, setQuery] = useState("");
  const sidebar = useRef<HTMLElement>(null);
  const drawerToggle = useRef<HTMLButtonElement>(null);
  const profileToggle = useRef<HTMLButtonElement>(null);
  const profileMenu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1025px)");
    function resize() { if (desktop.matches) setDrawer(false); }
    desktop.addEventListener("change", resize);
    return () => desktop.removeEventListener("change", resize);
  }, []);
  useEffect(() => {
    if (!drawer) return;
    const previousOverflow = document.body.style.overflow;
    const toggle = drawerToggle.current;
    document.body.style.overflow = "hidden";
    sidebar.current?.querySelector<HTMLButtonElement>("button")?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") { setDrawer(false); drawerToggle.current?.focus(); }
      if (event.key !== "Tab") return;
      const targets = Array.from(sidebar.current?.querySelectorAll<HTMLElement>("a[href],button,input") ?? []).filter((element) => element.getClientRects().length > 0);
      const first = targets[0]; const last = targets.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener("keydown", keydown);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", keydown); if (window.matchMedia("(max-width: 1024px)").matches) toggle?.focus(); };
  }, [drawer]);
  useEffect(() => {
    if (!profile) return;
    function close(event: MouseEvent) { if (!profileMenu.current?.contains(event.target as Node)) setProfile(false); }
    function keydown(event: KeyboardEvent) { if (event.key === "Escape") { setProfile(false); profileToggle.current?.focus(); } }
    document.addEventListener("click", close); document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("click", close); document.removeEventListener("keydown", keydown); };
  }, [profile]);
  const jobTitles: Record<string, string> = { all: "All Confirmed Jobs", pending: "Pending Jobs", process: "Under Process Jobs", completed: "Completed Jobs", hold: "All Confirmed Jobs", closed: "All Confirmed Jobs" };
  const section = pathname === "/dashboard" && searchParams.getAll("section").length === 1 ? dashboardSection(searchParams.get("section")) : undefined;
  const navigationKey = pathname === "/dashboard" ? `${pathname}?section=${section?.key ?? ""}` : pathname;
  const title = section ? `${section.label} Dashboard` : pathname === "/jobs" ? jobTitles[searchParams.get("cohort") ?? "all"] ?? "All Confirmed Jobs"
    : pathname === "/pipeline" ? searchParams.getAll("view").length === 1 && searchParams.get("view") === "agents" ? "Search Agent Pipeline" : "My Job Pipeline" : pageTitle(pathname);
  const homeOnlyBreadcrumb = pathname === "/settings/users" || pathname === "/settings/permissions/assign";
  return <div className="crm-app">
    <a className="crm-skip-link" href="#crm-content">Skip to content</a>
    <aside ref={sidebar} className={`pc-sidebar${collapsed ? " pc-sidebar-hide" : ""}${drawer ? " mob-sidebar-active" : ""}`} aria-label="Main sidebar">
      <div className="navbar-wrapper"><div className="m-header"><Link href="/" className="b-brand text-primary" onClick={() => setDrawer(false)}><Image src="/legacy/assets/images/logo-voltronix.png" alt="Voltronix CRM" width={407} height={75} unoptimized className="img-fluid logo-lg" priority /></Link><button className="crm-drawer-close" type="button" aria-label="Close navigation" onClick={() => { setDrawer(false); drawerToggle.current?.focus(); }}><i className="ti ti-x" aria-hidden="true" /></button></div>
        <CrmNavigation key={navigationKey} user={user} query={query} onNavigate={() => setDrawer(false)} />
      </div>
    </aside>
    {drawer && <button type="button" className="crm-sidebar-overlay" aria-label="Dismiss navigation" onClick={() => { setDrawer(false); drawerToggle.current?.focus(); }} />}
    <header className="pc-header" inert={drawer}><div className="header-wrapper">
      <div className="me-auto pc-mob-drp"><ul className="list-unstyled"><li className="pc-h-item crm-desktop-toggle"><button type="button" className="pc-head-link" aria-label={collapsed ? "Expand navigation" : "Collapse navigation"} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}><i className="ph ph-list" aria-hidden="true" /></button></li>
        <li className="pc-h-item crm-mobile-toggle"><button ref={drawerToggle} type="button" className="pc-head-link" aria-label="Open navigation" aria-expanded={drawer} onClick={() => setDrawer(true)}><i className="ph ph-list" aria-hidden="true" /></button></li>
        <li className="pc-h-item"><button className="pc-head-link" type="button" aria-label="Search navigation" aria-expanded={search} onClick={() => { setSearch(!search); setQuery(""); }}><i className="ph ph-magnifying-glass" aria-hidden="true" /></button></li></ul>
        {search && <div className="crm-navigation-search"><label htmlFor="crm-nav-search" className="visually-hidden">Find a page</label><input autoFocus id="crm-nav-search" className="form-control" placeholder="Search navigation..." value={query} onChange={(event) => setQuery(event.target.value)} /></div>}
      </div>
      <div className="ms-auto" ref={profileMenu}><ul className="list-unstyled"><li className="dropdown pc-h-item header-user-profile"><button ref={profileToggle} type="button" className="pc-head-link dropdown-toggle arrow-none me-0" aria-label="User menu" aria-expanded={profile} aria-controls="crm-profile-menu" onClick={() => setProfile(!profile)}><i className="ph ph-user-circle" aria-hidden="true" /><span>Hello! {user.username}</span></button>
        {profile && <div className="dropdown-menu dropdown-user-profile dropdown-menu-end show" id="crm-profile-menu"><div className="dropdown-header"><h5 className="mb-0">{user.username} <span className="badge bg-success">Active</span></h5><p className="text-muted mb-0">{user.email}</p></div><Link className="dropdown-item" href="/account" onClick={() => setProfile(false)}><i className="ph ph-user" aria-hidden="true" />Your account</Link><LogoutButton className="dropdown-item" /></div>}
      </li></ul></div>
    </div></header>
    <main id="crm-content" className="pc-container workspace" inert={drawer}><div className="pc-content crm-page"><div className="page-header"><div className="page-block"><div className="row align-items-center"><div className="col-md-12"><div className="page-header-title"><div className="h5 mb-0">{title}</div></div></div><div className="col-md-6"><ul className="breadcrumb mb-0"><li className="breadcrumb-item"><Link href="/">Home</Link></li>{pathname === "/quotations/new" && <li className="breadcrumb-item"><Link href="/quotations">Quotations</Link></li>}{!homeOnlyBreadcrumb && <li className="breadcrumb-item" aria-current="page">{pathname === "/quotations/new" ? "Create New Quotation" : title}</li>}</ul></div></div></div></div><div className="crm-content-body">{children}</div></div></main>
  </div>;
}

