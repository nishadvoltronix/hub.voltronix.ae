import { redirect } from "next/navigation";
import { currentUser } from "@/server/frontend-auth";
import { hasDashboardAccess } from "@/server/presentation-permissions";

export const dynamic = "force-dynamic";
export default async function Home() {
  const user = await currentUser();
  if (!user) redirect("/login");
  redirect(hasDashboardAccess(user.permissions) ? "/dashboard" : "/account");
}
