"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LogoutButton({ className }: { className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function signOut() {
    setBusy(true); setError("");
    try {
      const challenge = await fetch("/api/auth/csrf", { cache: "no-store", credentials: "same-origin" });
      if (!challenge.ok) throw new Error();
      const { csrfToken } = await challenge.json() as { csrfToken: string };
      const response = await fetch("/api/auth/logout", {
        method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrfToken },
      });
      if (!response.ok && response.status !== 401) throw new Error();
      router.replace("/login"); router.refresh();
    } catch { setError("Unable to sign out. Please try again."); }
    finally { setBusy(false); }
  }
  return <>{error && <p role="alert" className="error">{error}</p>}<button className={className} type="button" onClick={signOut} disabled={busy}>{busy ? "Signing out…" : "Sign out"}</button></>;
}
