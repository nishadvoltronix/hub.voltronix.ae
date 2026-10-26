import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/server/frontend-auth";
import { CrmShell } from "@/components/crm/shell";
import { Quotations } from "@/components/crm/quotations";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function QuotationsPage() {
  const user = await currentUser(); if (!user) redirect("/login");
  if (!user.permissions.some((key) => ["leads.view", "leads.manage", "leads.manage.agents"].includes(key))) notFound();
  return <CrmShell user={user}><Quotations canCreate={user.permissions.some((key) => key === "leads.manage" || key === "leads.manage.agents")} /></CrmShell>;
}
