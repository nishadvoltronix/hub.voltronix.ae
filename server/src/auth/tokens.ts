import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
export function newToken(): string { return randomBytes(32).toString("base64url"); }
export function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function matchesCsrfHash(value: unknown, saved: string): boolean {
  return validToken(value) && /^[a-f0-9]{64}$/.test(saved)
    && timingSafeEqual(Buffer.from(saved, "hex"), Buffer.from(digest(value), "hex"));
}
