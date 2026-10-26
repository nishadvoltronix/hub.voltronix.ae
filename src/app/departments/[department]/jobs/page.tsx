import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/server/frontend-auth";
import { DEPARTMENT_PERMISSIONS } from "@/server/auth/permissions";
import { DEPARTMENTS, type Department } from "@/server/departments/contracts";
import { DepartmentJobs } from "@/components/crm/department-jobs";
import { CrmShell } from "@/components/crm/shell";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function DepartmentJobsPage({ params }: { params: Promise<{ department: string }> }) {
  const user = await currentUser(); if (!user) redirect("/login");
  const { department } = await params;
  if (!DEPARTMENTS.includes(department as Department) || !user.permissions.includes(DEPARTMENT_PERMISSIONS[department as Department])) notFound();
  return <CrmShell user={user}><DepartmentJobs department={department as Department} /></CrmShell>;
}
