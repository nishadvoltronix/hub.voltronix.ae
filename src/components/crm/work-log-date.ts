// Worker PHP saves local Dubai clock values and renders d M Y[, ] h:i A.
// Current API timestamps identify an instant; legacy zone-less values retain
// their recorded clock. This formatter never writes or infers a saved date.
export function recordedWorkLogDate(value: string | null | undefined, comma = false): string {
  if (!value) return value ?? "";
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) return value;
  const [, year, month, day, hour, minute, second = "00", , zone] = match;
  const y = Number(year), m = Number(month), d = Number(day), h = Number(hour);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m - 1]! || h > 23 || Number(minute) > 59 || Number(second) > 59) return value;
  const separator = comma ? ", " : " ";
  if (!zone) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${day} ${months[m - 1]} ${year}${separator}${String(h % 12 || 12).padStart(2, "0")}:${minute} ${h < 12 ? "AM" : "PM"}`;
  }
  const date = new Date(value.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Dubai", year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: true }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)!.value;
  return `${part("day")} ${part("month")} ${part("year")}${separator}${part("hour")}:${part("minute")} ${part("dayPeriod")}`;
}
