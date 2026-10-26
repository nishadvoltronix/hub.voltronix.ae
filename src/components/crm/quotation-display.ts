export const HISTORICAL_QUOTATION_NOTICE = "This saved quotation uses an earlier calculation policy. Its recorded values are preserved; editing requires an approved historical revision.";

/** Limits checked against the selected Zoho quotation profile; local fields retain their existing capacity. */
export function quotationTermLimit(key: string, remote: boolean): number {
  if (!remote) return 10_000;
  if (key === "specification") return 2000;
  return ["project", "termsOfPayment", "brand", "warranty", "delivery"].includes(key) ? 255 : 10_000;
}

// This is saved creation metadata, not an inferred editable issue/revision date.
export function recordedCreationDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: string) => parts.find(value => value.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
