import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/server/frontend-auth";
import { CrmShell } from "@/components/crm/shell";
import { Pipeline } from "@/components/crm/pipeline";
import { pipelineEntry } from "@/components/crm/pipeline-entry";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function PipelinePage({ searchParams }: { searchParams: Promise<{ scope?: string | string[]; view?: string | string[] }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.permissions.some((key) => key === "leads.view" || key === "leads.manage.agents")) notFound();
  const entry = pipelineEntry(await searchParams);
  return <CrmShell user={user}><h1>{entry.agents ? "Search Agent Pipeline" : "My Job Pipeline"}</h1><Pipeline key={`${entry.own}:${entry.agents}`} forcedOwn={user.permissions.includes("leads.manage.agents")} initialOwn={entry.own} showAgentFilter={entry.agents} /></CrmShell>;
}

