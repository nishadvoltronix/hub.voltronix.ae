import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/server/frontend-auth";
import { DEPARTMENT_PERMISSIONS } from "@/server/auth/permissions";
import { DEPARTMENTS, type Department } from "@/server/departments/contracts";
import { readDepartmentJob } from "@/server/frontend-records";
import { DepartmentJob } from "@/components/crm/department-job";
import { CrmShell } from "@/components/crm/shell";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function DepartmentJobPage({ params }: { params: Promise<{ department: string; id: string }> }) {
  const user = await currentUser(); if (!user) redirect("/login");
  const { department, id } = await params;
  if (!DEPARTMENTS.includes(department as Department) || !user.permissions.includes(DEPARTMENT_PERMISSIONS[department as Department])) notFound();
  const job = await readDepartmentJob(department, id);
  return <CrmShell user={user}><DepartmentJob department={department as Department} initialJob={job} /></CrmShell>;
}
