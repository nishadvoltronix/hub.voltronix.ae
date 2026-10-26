import { z } from "zod";

export class CommercialError extends Error {
  constructor(public readonly status: 400 | 409 | 502) {
    super(status === 400 ? "Invalid commercial input." : status === 409
      ? "The legacy quotation rules conflict; this operation requires a verified rule."
      : "The integration returned an invalid response.");
    this.name = "CommercialError";
  }
}

export function parseCommercial<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new CommercialError(400);
  return result.data;
}

export const externalIdSchema = z.string().regex(/^[1-9][0-9]{0,39}$/);
export const singleLine = (max: number) => z.string().trim().max(max)
  .refine((value) => Array.from(value).every((character) => character.charCodeAt(0) >= 32
    && character.charCodeAt(0) !== 127));
export const multiLine = (max: number) => z.string().trim().max(max)
  .refine((value) => Array.from(value).every((character) => character === "\n" || character === "\r"
    || character === "\t" || (character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)));

// Escape source criteria grammar before percent-encoding the entire criteria value.
// Unsupported operators are not accepted as literal user input.
export function exactSearchPath(module: "Accounts" | "Contacts" | "Products", field: string, value: string) {
  const literal = parseCommercial(singleLine(200).min(1), value);
  if (/[(),:\\]/.test(literal)) throw new CommercialError(400);
  return `/${module}/search?criteria=${encodeURIComponent(`(${field}:equals:${literal})`)}`;
}
