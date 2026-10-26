/** Preserve the conservative delimiter/whitespace/optional-quote policy in O(n).
 * Overlapping whitespace quantifiers can backtrack quadratically on valid CSV. */
export function hasSpreadsheetFormula(text: string): boolean {
  let start = true, quote = false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if ([44, 59, 9, 10, 13].includes(code)) { start = true; quote = false; continue; }
    if (!start) continue;
    const whitespace = code === 32 || code === 160 || code === 5760 || code >= 8192 && code <= 8202 || [11, 12, 8232, 8233, 8239, 8287, 12288, 65279].includes(code);
    if (whitespace) continue;
    if (code === 34 && !quote) { quote = true; continue; }
    if ([61, 43, 64, 45].includes(code)) return true;
    start = false;
  }
  return false;
}
