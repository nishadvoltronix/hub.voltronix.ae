import { requireSettingsPage } from "@/server/settings-page";
import { SettingsEditTarget } from "@/components/settings/edit-target";
export default async function GroupsPage({ searchParams }: { searchParams: Promise<{ editId?: string | string[] }> }) {
  await requireSettingsPage(["permissions.manage"]);
  const { editId } = await searchParams;
  const target = typeof editId === "string" ? editId : editId ? "invalid" : "";
  return <section><h1>Permission groups</h1><p>Organize permission definitions with a label and display order.</p><SettingsEditTarget key={target} kind="groups" editId={target} /></section>;
}

