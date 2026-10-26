import { requireSettingsPage } from "@/server/settings-page";
import { SettingsEditTarget } from "@/components/settings/edit-target";
export default async function PermissionsPage({ searchParams }: { searchParams: Promise<{ editId?: string | string[] }> }) {
  await requireSettingsPage(["permissions.manage"]);
  const { editId } = await searchParams;
  const target = typeof editId === "string" ? editId : editId ? "invalid" : "";
  return <section><h1>Permissions</h1><p>Manage permission labels and groups. Keys stay fixed once created.</p><SettingsEditTarget key={target} kind="permissions" editId={target} /></section>;
}

