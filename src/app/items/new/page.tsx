import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/server/frontend-auth";
import { CrmShell } from "@/components/crm/shell";
import { ProductCreate } from "@/components/crm/products";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function ProductCreatePage() {
  const user = await currentUser(); if (!user) redirect("/login");
  if (!user.permissions.includes("items.write")) notFound();
  return <CrmShell user={user}><ProductCreate /></CrmShell>;
}
