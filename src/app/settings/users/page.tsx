import { requireSettingsPage } from "@/server/settings-page";
import { SettingsEditTarget } from "@/components/settings/edit-target";
export default async function UsersPage({ searchParams }: { searchParams: Promise<{ editId?: string | string[] }> }) {
  await requireSettingsPage(["users.write", "permissions.manage"]);
  const { editId } = await searchParams;
  const target = typeof editId === "string" ? editId : editId ? "invalid" : "";
  return <section><h1>Users</h1><SettingsEditTarget key={target} kind="users" editId={target} /></section>;
}

