import { redirect } from "next/navigation";
import { currentUser } from "@/server/frontend-auth";
import { CrmShell } from "@/components/crm/shell";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  return <CrmShell user={user}>{children}</CrmShell>;
}

