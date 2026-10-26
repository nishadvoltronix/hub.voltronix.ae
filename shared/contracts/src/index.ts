/** Wire-only public exports. No environment, framework, database or Node imports. */
export const API_V1_PREFIX = "/api/v1" as const;
export const LIVENESS_PATH = `${API_V1_PREFIX}/health/live` as const;
export const API_IDENTITY_PATH = `${API_V1_PREFIX}/health/identity` as const;
export const API_SERVICE_ID = "hub-crm-api" as const;

/** Non-secret routing identity. This does not attest database readiness or authenticate a server. */
export interface ApiIdentityResponse {
  service: typeof API_SERVICE_ID;
  instanceId: string;
  appOrigin: string;
}

/** Process liveness only; this does not promise database or workflow readiness. */
export interface LivenessResponse { status: "running" }
export interface ErrorResponse { error: string }

/** Safe identity projection only. No persisted session/password representation. */
export interface AuthUser {
  localUserId: string;
  externalUserId: string | null;
  username: string;
  email: string;
  permissions: string[];
}
export interface LoginRequest { email: string; password: string }
export interface CsrfResponse { csrfToken: string }
export interface LoginResponse extends CsrfResponse { user: AuthUser }
export interface MeResponse { user: AuthUser }
export interface LogoutResponse { signedOut: true }

export function isLivenessResponse(value: unknown): value is LivenessResponse {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 1
    && Object.hasOwn(value, "status")
    && (value as Record<string, unknown>).status === "running";
}

export * from "./dashboard.js";
export * from "./leads.js";
export * from "./jobs.js";
export * from "./departments.js";
export * from "./reports.js";
export * from "./capabilities.js";
export * from "./created-deals.js";
export * from "./attachments.js";
export * from "./zoho-sync.js";
