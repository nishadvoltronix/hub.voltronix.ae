import { redirect } from "next/navigation";
import { currentUser } from "@/server/frontend-auth";
import { readLead } from "@/server/frontend-records";
import { CrmShell } from "@/components/crm/shell";
import { LeadDetails } from "@/components/crm/lead-details";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const id = (await params).id;
  const lead = await readLead(id);
  return <CrmShell user={user}><LeadDetails key={lead.id} lead={lead} /></CrmShell>;
}

