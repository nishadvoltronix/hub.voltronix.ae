/** Explicit local Hub reference namespace. SITE/JOB/LOST references MUST NOT be
 * written to the legacy remote counter fields: that tenant function parses
 * every numeric suffix without a namespace filter. Existing references win. */
export const ZOHO_NATIVE_NUMBERING_PROFILE = "voltronix-hub-local-references-v1" as const;
export type NativeZohoContext = {
  organizationId: string;
  dealLayoutId: string;
  quotationProfile: "voltronix-custom-quoted-items-v8";
  numberingProfile: typeof ZOHO_NATIVE_NUMBERING_PROFILE;
};
const id = /^[1-9][0-9]{0,29}$/;
export function assertNativeZohoContext(value: NativeZohoContext): void {
  if (!value || !id.test(value.organizationId) || !id.test(value.dealLayoutId) || value.quotationProfile !== "voltronix-custom-quoted-items-v8"
    || value.numberingProfile !== ZOHO_NATIVE_NUMBERING_PROFILE) throw new Error("Invalid native Zoho profile.");
}
export function nativeZohoReference(kind: "qualification" | "quote" | "site" | "job" | "lost",
  dealId: string, existing: unknown, autoNumber?: unknown): string {
  if (!id.test(dealId)) throw new Error("Invalid remote reference.");
  if (existing !== undefined && existing !== null && existing !== "") {
    if (typeof existing !== "string" || !/^[\x20-\x7e]{1,100}$/.test(existing) || existing.trim() !== existing) throw new Error("Invalid remote reference.");
    return existing;
  }
  if (kind === "qualification" || kind === "quote") {
    const match = typeof autoNumber === "string" ? /^VTNX-([A-Za-z0-9]{1,80})$/.exec(autoNumber) : null;
    if (!match) throw new Error("Unsupported verified autonumber.");
    return `${kind === "qualification" ? "DEAL" : "QUOTE"}-${match[1]}`;
  }
  return `HUB-${{ site: "SITE", job: "JOB", lost: "LOST" }[kind]}-${dealId}`;
}
