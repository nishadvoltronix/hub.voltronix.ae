import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/server/frontend-auth";
import { CrmShell } from "@/components/crm/shell";
import { Jobs } from "@/components/crm/jobs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function JobsPage({ searchParams }: { searchParams: Promise<{ cohort?: string; jobStatus?: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.permissions.includes("dashboard.view")) notFound();
  const params = await searchParams;
  const cohort = params.cohort ?? "all", jobStatus = params.jobStatus ?? "all";
  if (!["all", "pending", "process", "completed", "hold", "closed"].includes(cohort) || !["all", "Active", "Hold", "Closed"].includes(jobStatus)) notFound();
  return <CrmShell user={user}><h1>Jobs</h1><Jobs key={cohort + ":" + jobStatus} initialCohort={cohort} initialJobStatus={jobStatus} /></CrmShell>;
}
