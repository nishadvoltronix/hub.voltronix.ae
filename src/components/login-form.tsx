"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { requestLogin } from "./login-request";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    try {
      const email = form.get("email"), password = form.get("password");
      if (typeof email !== "string" || typeof password !== "string") throw new Error();
      const result = await requestLogin(email, password);
      if (!result.ok) { setError(result.message); return; }
      router.replace("/"); router.refresh();
    } catch { setError("Sign-in is temporarily unavailable. Please try again."); }
    finally { pending.current = false; setBusy(false); }
  }
  return (
    <form onSubmit={submit}>
      <div className="mb-3"><label className="visually-hidden" htmlFor="email">Email address</label>
      <input className="form-control" placeholder="Email Address" id="email" name="email" type="email" autoComplete="username" maxLength={254} required disabled={busy} /></div>
      <div className="mb-3"><label className="visually-hidden" htmlFor="password">Password</label>
      <input className="form-control" placeholder="Password" id="password" name="password" type="password" autoComplete="current-password" maxLength={1024} required disabled={busy} /></div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="text-center mt-4"><button className="btn btn-dangers px-4" type="submit" disabled={busy}>{busy ? "Signing in…" : "Login"}</button></div>
    </form>
  );
}
