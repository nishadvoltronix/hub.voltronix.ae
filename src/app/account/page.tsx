import { redirect } from "next/navigation";
import { currentUser } from "@/server/frontend-auth";
import { CrmShell } from "@/components/crm/shell";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  return (
    <CrmShell user={user}>
      <h1>Your account</h1>
      <p>Signed in as <strong>{user.username}</strong>.</p>
      <p className="muted">{user.email}</p>
      <p className="notice">Available modules appear in the navigation according to your permissions.</p>
    </CrmShell>
  );
}
