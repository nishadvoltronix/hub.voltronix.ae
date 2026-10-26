import type { QuotationDetail } from "../commercial/persistence-contracts";
import { QuotationPdfError, renderQuotationPdf } from "./render";

type AuthorizedReader = { getQuotation(token: string, taskId: string): QuotationDetail };
export function createQuotationPdfService(reader: AuthorizedReader, render = renderQuotationPdf) {
  return {
    async download(token: string, taskId: string) {
      const before = reader.getQuotation(token, taskId);
      const result = await render(before);
      // Rendering yields while its stream finishes. Recheck session, permissions,
      // assignment and every printed field before returning sensitive bytes.
      const after = reader.getQuotation(token, taskId);
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new QuotationPdfError(409, "The quotation changed. Reload it before downloading the PDF.");
      return result;
    },
  };
}
