"use client";

import { useEffect } from "react";
import type { AuthUser } from "@voltronix/crm-contracts";

type Access = Pick<AuthUser, "localUserId" | "externalUserId" | "permissions">;
function accessKey(user: Access) {
  return JSON.stringify([user.localUserId, user.externalUserId, [...new Set(user.permissions)].sort()]);
}
function readAccess(value: unknown): Access | null {
  if (!value || typeof value !== "object" || !("user" in value)) return null;
  const user = value.user;
  if (!user || typeof user !== "object" || !("localUserId" in user) || typeof user.localUserId !== "string"
    || !/^[1-9][0-9]{0,29}$/.test(user.localUserId) || !("externalUserId" in user)
    || (user.externalUserId !== null && typeof user.externalUserId !== "string")
    || !("permissions" in user) || !Array.isArray(user.permissions)
    || !user.permissions.every((permission): permission is string => typeof permission === "string")) return null;
  return { localUserId: user.localUserId, externalUserId: user.externalUserId, permissions: user.permissions };
}

/** Reauthorize the server-rendered dashboard when an owner changes this user's
 * access. A route refresh alone preserves the dashboard's old client read, so
 * refresh must also reload that read. Other pages and unsaved forms are untouched. */
export function useDashboardPermissionRefresh(user: AuthUser | undefined, refresh: () => void) {
  const key = user ? accessKey(user) : null;
  const localUserId = user?.localUserId;
  useEffect(() => {
    if (!key || !localUserId) return;
    let disposed = false;
    let pending: AbortController | undefined;
    let lastCheckAt = -Infinity;
    let lastRefreshAt = -Infinity;
    async function check() {
      if (disposed || document.visibilityState !== "visible" || pending || Date.now() - lastCheckAt < 1_000) return;
      lastCheckAt = Date.now();
      const controller = new AbortController();
      pending = controller;
      const timeout = window.setTimeout(() => controller.abort(), 5_000);
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal });
        if (disposed || controller.signal.aborted) return;
        if (response.status === 401) { window.location.replace("/login"); return; }
        if (!response.ok) return;
        const current = readAccess(await response.json());
        if (disposed || controller.signal.aborted || !current) return;
        // A different signed-in account must not inherit the old dashboard's
        // client state. Navigate to a fixed route and authorize it afresh.
        if (current.localUserId !== localUserId) { window.location.replace("/dashboard"); return; }
        if (accessKey(current) !== key && Date.now() - lastRefreshAt >= 5_000) {
          lastRefreshAt = Date.now();
          refresh();
        }
      } catch {
        // A temporary network/auth-service failure is not a grant change.
      } finally {
        window.clearTimeout(timeout);
        if (pending === controller) pending = undefined;
      }
    }
    const recheck = () => { void check(); };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    const timer = window.setInterval(recheck, 30_000);
    return () => {
      disposed = true;
      pending?.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [key, localUserId, refresh]);
}
