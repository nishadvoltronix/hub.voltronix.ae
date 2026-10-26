import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/server/frontend-auth";
import { CrmShell } from "@/components/crm/shell";
import { DealForm } from "@/components/crm/deal-form";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function NewDealPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.permissions.includes("deals.manage")) notFound();
  return <CrmShell user={user}><DealForm /></CrmShell>;
}
