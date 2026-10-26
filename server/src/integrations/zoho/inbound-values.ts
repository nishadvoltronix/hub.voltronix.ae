import { z } from "zod";

/** Shared source-only parsing. Write payload limits and staged DTO validation
 * remain separate: successful inbound decoding is not permission to send the
 * same values back or to mutate an imported record. */
export const inboundSourceName = (maximum: number) => z.string().max(maximum).min(1)
  .refine(value => value.trim().length > 0 && Array.from(value).every(character => ["\r", "\n", "\t"].includes(character)
    || character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127));

export const inboundDecimal = z.string().regex(/^-?(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,18})?$/);

/** The HTTP client retains numeric JSON lexemes. Expand scientific notation
 * exactly using digit strings, never a binary floating-point money value.
 * Preserve ordinary decimal strings, including their trailing zeroes. */
function exponentDecimal(value: string): string {
  if (value.length > 128 || !/[eE]/.test(value)) return value;
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?[eE]([+-]?[0-9]{1,6})$/.exec(value);
  if (!match) return value;
  const exponent = BigInt(match[4]!);
  if (exponent < -1000n || exponent > 1000n) return value;
  const digits = `${match[2]}${match[3] ?? ""}`.replace(/0+$/, "");
  if (!digits) return "0";
  // Only this bounded positional offset, never the amount, becomes a number.
  const point = match[2]!.length + Number(exponent);
  const integer = (point <= 0 ? "0" : point >= digits.length ? digits + "0".repeat(point - digits.length) : digits.slice(0, point))
    .replace(/^0+(?=[0-9])/, "");
  const fraction = point <= 0 ? "0".repeat(-point) + digits : point < digits.length ? digits.slice(point) : "";
  const normalized = `${match[1]}${integer}${fraction ? `.${fraction}` : ""}`;
  return inboundDecimal.safeParse(normalized).success ? normalized : value;
}

export const inboundSourceDecimal = z.preprocess(value => typeof value === "string" ? exponentDecimal(value) : value, inboundDecimal);
