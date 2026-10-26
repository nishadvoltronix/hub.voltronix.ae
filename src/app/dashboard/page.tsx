import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/server/frontend-auth";
import { dashboardSection, hasDashboardAccess } from "@/server/presentation-permissions";
import { CrmShell } from "@/components/crm/shell";
import { Dashboard } from "@/components/crm/dashboard";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!hasDashboardAccess(user.permissions)) notFound();
  const requested = (await searchParams).section;
  const section = dashboardSection(requested);
  if (requested !== undefined && (!section || !user.permissions.includes(section.permission))) notFound();
  return <CrmShell user={user}><h1>{section ? `${section.label} Dashboard` : "Dashboard"}</h1><Dashboard user={user} section={section?.key} /></CrmShell>;
}

