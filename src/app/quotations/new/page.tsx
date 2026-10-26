import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/server/frontend-auth";
import { CrmShell } from "@/components/crm/shell";
import { QuotationForm } from "@/components/crm/quotation-form";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function QuotationCreatePage({ searchParams }: { searchParams: Promise<{ taskId?: string | string[] }> }) {
  const user = await currentUser(); if (!user) redirect("/login");
  if (!user.permissions.some((key) => key === "leads.manage" || key === "leads.manage.agents")) notFound();
  const { taskId } = await searchParams;
  return <CrmShell user={user}><QuotationForm initialTaskId={typeof taskId === "string" && /^[1-9][0-9]{0,18}$/.test(taskId) ? taskId : ""} /></CrmShell>;
}
