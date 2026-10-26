type Fetcher = typeof fetch;
export type LoginResult = { ok: true } | { ok: false; message: string };

const unavailable = "Sign-in is temporarily unavailable. Please try again.";
const securityFailure = "Sign-in security check failed. Reload this page and use the configured CRM address.";

function failure(status: number, credentialsSubmitted: boolean): LoginResult {
  const message = status === 403 ? securityFailure
    : status === 429 ? "Too many sign-in attempts. Try again in 15 minutes."
      : status === 401 && credentialsSubmitted ? "Unable to sign in. Check your email and password."
        : unavailable;
  return { ok: false, message };
}

/** A failed challenge never submits credentials; an uncertain login is never retried automatically. */
export async function requestLogin(email: string, password: string, fetcher: Fetcher = fetch): Promise<LoginResult> {
  try {
    const challenge = await fetcher("/api/auth/csrf", { cache: "no-store", credentials: "same-origin",
      redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!challenge.ok) return failure(challenge.status, false);
    const value: unknown = await challenge.json();
    if (!value || typeof value !== "object" || Array.isArray(value) || !("csrfToken" in value)
      || typeof value.csrfToken !== "string" || value.csrfToken.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(value.csrfToken)) {
      return { ok: false, message: unavailable };
    }
    const response = await fetcher("/api/auth/login", {
      method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": value.csrfToken },
      body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(15_000),
    });
    return response.ok ? { ok: true } : failure(response.status, true);
  } catch {
    // Do not surface provider/server bodies, credentials, tokens or network error text.
    return { ok: false, message: unavailable };
  }
}
