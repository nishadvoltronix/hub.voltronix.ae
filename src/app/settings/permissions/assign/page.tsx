import { requireSettingsPage } from "@/server/settings-page";
import { GrantManager } from "@/components/settings/grant-manager";
export default async function AssignPage({ searchParams }: { searchParams: Promise<{ userId?: string }> }) {
  await requireSettingsPage(["permissions.manage"]);
  const { userId } = await searchParams;
  const selectedUserId = typeof userId === "string" ? userId : "";
  return <section><h1>Assign Permissions</h1><GrantManager key={selectedUserId} initialUserId={selectedUserId} /></section>;
}

