import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/server/frontend-auth";
import { CrmShell } from "@/components/crm/shell";
import { EmployeeReport } from "@/components/crm/employee-report";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function ReportPage() {
  const user = await currentUser(); if (!user) redirect("/login");
  if (!user.permissions.includes("dashboard.view")) notFound();
  return <CrmShell user={user}><h1>Employee performance</h1><EmployeeReport /></CrmShell>;
}
