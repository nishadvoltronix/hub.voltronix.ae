import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { z } from "zod";

const reference = z.string().trim().min(1).max(240).refine((value) => !/[\r\n\0]/.test(value));
const schema = z.object({
  formatVersion: z.literal(1),
  nonProductionApproved: z.literal(true),
  approvalReference: reference,
  artifactReference: reference,
  expiresAt: z.iso.datetime(),
  origin: z.string().max(253),
  approvedAddresses: z.array(z.string().refine((address) => isIP(address) !== 0)).min(1).max(16),
  canaries: z.array(z.object({
    path: z.string().regex(/^\/(?:\.local-data\/|\.private\/|backups\/|\.next\/|src\/|\.env\.)staging-canary-[a-zA-Z0-9-]{1,64}\.txt$/),
    installedEvidenceReference: reference,
  }).strict()).min(1).max(8),
}).strict();
export type ProbeConfig = z.infer<typeof schema>;
export function probeConfigFingerprint(config: ProbeConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
export function parseProbeConfig(input: unknown, now = Date.now()): ProbeConfig {
  try {
    const value = schema.parse(input);
    const origin = new URL(value.origin);
    if (origin.protocol !== "https:" || origin.origin !== value.origin || origin.username || origin.password
      || isIP(origin.hostname.replace(/^\[|\]$/g, "")) || !origin.hostname.includes(".")
      || Date.parse(value.expiresAt) <= now || Date.parse(value.expiresAt) > now + 24 * 60 * 60 * 1000
      || new Set(value.canaries.map((entry) => entry.path)).size !== value.canaries.length) throw new Error();
    return value;
  } catch { throw new Error("Invalid or expired staging probe configuration. No values were logged."); }
}
export interface ProbeRequest { id: string; path: string; headers: Record<string, string> }
export interface ProbeResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  tlsAuthorized: boolean;
  tlsProtocol: string | null;
}
export type ProbeTransport = (request: ProbeRequest) => Promise<ProbeResponse>;
function header(response: ProbeResponse, name: string): string {
  const value = response.headers[name];
  return typeof value === "string" ? value.toLowerCase() : "";
}
function csrfCookieSafe(response: ProbeResponse): boolean {
  const values = response.headers["set-cookie"];
  if (!Array.isArray(values) || values.length !== 1) return false;
  const parts = values[0]!.split(";").map((part) => part.trim());
  if (!/^__Host-crm_csrf=[A-Za-z0-9_-]{43}$/.test(parts.shift() ?? "")) return false;
  const attributes = new Map<string, string>();
  for (const part of parts) {
    const separator = part.indexOf("=");
    const key = (separator < 0 ? part : part.slice(0, separator)).trim().toLowerCase();
    const value = separator < 0 ? "" : part.slice(separator + 1).trim().toLowerCase();
    if (!key || attributes.has(key) || key === "domain") return false;
    attributes.set(key, value);
  }
  return attributes.get("secure") === "" && attributes.get("httponly") === ""
    && attributes.get("samesite") === "lax" && attributes.get("path") === "/"
    && attributes.get("max-age") === "7200";
}
export function probeRequests(config: ProbeConfig): ProbeRequest[] {
  return [
    { id: "liveness", path: "/api/health/live", headers: {} },
    { id: "anonymous-identity", path: "/api/auth/me", headers: {} },
    { id: "csrf-cookie", path: "/api/auth/csrf", headers: {} },
    { id: "cross-origin-csrf", path: "/api/auth/csrf", headers: { Origin: "https://cross-origin.example.invalid", "Sec-Fetch-Site": "cross-site" } },
    { id: "forwarded-origin", path: "/api/auth/csrf", headers: { "X-Forwarded-Host": "spoof.example.invalid", "X-Forwarded-Proto": "http" } },
    ...config.canaries.map((entry, index) => ({ id: `private-canary-${index + 1}`, path: entry.path, headers: {} })),
  ];
}
/** Explicit injected transport; no default network client and no authenticated requests. */
export async function runHttpProbes(config: ProbeConfig, transport: ProbeTransport, now = () => Date.now()) {
  parseProbeConfig(config, now());
  const results = [];
  for (const request of probeRequests(config)) {
    // Approval expiry is rechecked before every request. No redirects or retries.
    try {
      parseProbeConfig(config, now());
      const response = await transport(request);
      const checks: Record<string, boolean> = {
        certificateAndHostname: response.tlsAuthorized,
        modernTls: ["TLSv1.2", "TLSv1.3"].includes(response.tlsProtocol ?? ""),
        noRedirect: response.status < 300 || response.status >= 400,
      };
      if (request.id.startsWith("private-canary-")) checks.denied = [403, 404].includes(response.status);
      else {
        checks.status = response.status === (request.id === "anonymous-identity" ? 401 : request.id === "cross-origin-csrf" ? 403 : 200);
        checks.noStore = header(response, "cache-control").split(/\s*,\s*/).includes("no-store");
        checks.nosniff = header(response, "x-content-type-options") === "nosniff";
        checks.frameDeny = header(response, "x-frame-options") === "deny";
        if (request.id !== "liveness") checks.variesByCookie = header(response, "vary").split(/\s*,\s*/).includes("cookie");
        if (["csrf-cookie", "forwarded-origin"].includes(request.id)) checks.csrfCookieFlags = csrfCookieSafe(response);
        if (request.id === "cross-origin-csrf") checks.noCookieOnRejection = response.headers["set-cookie"] === undefined;
      }
      results.push({ id: request.id, status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL", statusCode: response.status, checks });
    } catch {
      results.push({ id: request.id, status: "FAIL", failure: "CONFIGURATION_TLS_DNS_OR_REQUEST_FAILED" });
      break;
    }
  }
  return { formatVersion: 1, status: results.length === probeRequests(config).length && results.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL",
    scope: "anonymous-https-probes-only", configSha256: probeConfigFingerprint(config), results,
    stagingReady: false, artifactIndependentlyVerified: false, authenticatedSessionsVerified: false,
    storageVerified: false, sandboxVerified: false, canaryPlacementIndependentlyVerified: false };
}
