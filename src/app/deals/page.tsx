import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/server/frontend-auth";
import { CrmShell } from "@/components/crm/shell";
import { CreatedDeals } from "@/components/crm/created-deals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function CreatedDealsPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.permissions.includes("deals.view")) notFound();
  return <CrmShell user={user}><CreatedDeals canViewDetails={user.permissions.some((permission) => ["leads.view", "leads.manage.agents"].includes(permission))} /></CrmShell>;
}
