import "server-only";
import { notFound, redirect } from "next/navigation";
import { currentUser } from "./web-auth";
import type { PermissionKey } from "./auth/permissions";

export async function requireSettingsPage(permissions: readonly PermissionKey[]) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!permissions.every((permission) => user.permissions.includes(permission))) notFound();
  return user;
}

