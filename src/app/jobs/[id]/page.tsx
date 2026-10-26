import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/server/frontend-auth";
import { readJob } from "@/server/frontend-records";
import { CrmShell } from "@/components/crm/shell";
import { JobDetails } from "@/components/crm/job-details";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.permissions.includes("dashboard.view")) notFound();
  const job = await readJob((await params).id);
  return <CrmShell user={user}><JobDetails key={job.id} initialJob={job} /></CrmShell>;
}
