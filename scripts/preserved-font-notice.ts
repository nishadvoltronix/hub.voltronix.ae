import { createHash } from "node:crypto";

export const preservedFontNoticePath = "resources/quotation-pdf/DejaVuinfo.txt";
export const originalFontNoticePath = "vendor/mpdf/mpdf/ttfonts/DejaVuinfo.txt";
const originalSha256 = "bc9b65c8952e1b2281819c5322adab87c27c330ff7b68434f063b59d219acdaf";

// One source-identical legal notice, never a general text-file exemption.
export function isPreservedFontNotice(path: string, copy: Buffer, original: Buffer): boolean {
  return path === preservedFontNoticePath && copy.equals(original)
    && createHash("sha256").update(copy).digest("hex") === originalSha256;
}
