import { requireSettingsPage } from "@/server/settings-page";
import { DepartmentManager } from "@/components/settings/department-manager";
export default async function DepartmentsPage() {
  await requireSettingsPage(["users.write", "permissions.manage"]);
  return <section><h1>Assign departments</h1><DepartmentManager /></section>;
}

