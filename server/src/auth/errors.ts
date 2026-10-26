const failures = {
  credentials: { status: 401, message: "Invalid email or password." },
  authentication: { status: 401, message: "Authentication required." },
  denied: { status: 403, message: "Access denied." },
  csrf: { status: 403, message: "Request not permitted." },
  invalidRequest: { status: 400, message: "Invalid request." },
  tooLarge: { status: 413, message: "Request is too large." },
  contentType: { status: 415, message: "Use an application/json request." },
  throttled: { status: 429, message: "Unable to sign in. Try again later." },
  unavailable: { status: 503, message: "The service is temporarily unavailable." },
  method: { status: 405, message: "Method not permitted." },
} as const;
export type AuthFailureKind = keyof typeof failures;
const kinds = new WeakMap<Error, AuthFailureKind>();

export class AuthError extends Error {
  constructor(kind: AuthFailureKind) {
    super(failures[kind].message);
    this.name = "AuthError";
    kinds.set(this, kind);
  }
}
/** Unknown repository/crypto/parser errors are always opaque503. */
export function authFailure(error: unknown) {
  const kind = error instanceof Error ? kinds.get(error) : undefined;
  return { ...failures[kind ?? "unavailable"] };
}
