import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/server/frontend-auth";
import { CrmShell } from "@/components/crm/shell";
import { Products } from "@/components/crm/products";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function ProductsPage() {
  const user = await currentUser(); if (!user) redirect("/login");
  if (!user.permissions.some((key) => ["items.view", "items.write", "leads.manage", "leads.manage.agents"].includes(key))) notFound();
  return <CrmShell user={user}><Products canCreate={user.permissions.includes("items.write")} /></CrmShell>;
}
