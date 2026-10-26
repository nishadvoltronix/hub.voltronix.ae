import type { QuotationDetail } from "../../src/crm/commercial/persistence-contracts.js";
import { calculateQuotation, parseQuotationInput } from "../../src/crm/commercial/quotations.js";

/** Synthetic-only fixture. Never used by the runtime or database initialization. */
export function quotationPdfFixture(company = "VOLTRONIX CONTRACTING LLC"): QuotationDetail {
  const quotation = parseQuotationInput({ subject: "TEST ONLY — distribution board installation", kindAttention: "Synthetic customer",
    project: "Isolated PDF test project", termsOfPayment: "Payment terms for testing only", specification: "IP54 test specification",
    generalExclusion: "Civil works excluded\nNote: synthetic terms only", brand: null, warranty: "12 months — test fixture",
    delivery: "10 days — test fixture", notes: "No historical CRM data", validUntil: "2026-11-10", discount: "5", discountType: "percentage", adjustment: "-0.50",
    items: [{ productId: "90001", productName: "TEST ONLY panel", description: "Line one\nLine two\nLiteral <script>alert('test')</script> https://invalid.example/image.png",
      uom: "NOS", quantity: "2.5", unitPrice: "100.10", itemDiscount: "10" }] });
  const totals = calculateQuotation(quotation, "percentage");
  return { id: "1", taskId: "1", externalId: "90011", quoteNumber: "SYNTHETIC-QUOTE-001", subject: quotation.subject,
    accountName: "Synthetic customer LLC", dealName: "Synthetic quote deal", assignedName: "Synthetic agent", subtotal: totals.subtotal,
    grandTotal: totals.grandTotal, version: 1, taskVersion: 1, createdAt: "2026-10-10T08:30:00.000Z", updatedAt: "2026-10-10T08:30:00.000Z",
    remoteModifiedAt: "2026-10-10T08:30:00.000Z", calculationPolicy: "percentage-only-v2", quotation, totals,
    task: { dealName: "Synthetic quote deal", dealNumber: "TEST-DEAL-001", accountName: "Synthetic customer LLC", customerName: "Synthetic customer",
      customerEmail: "synthetic@example.invalid", customerContact: "0000000000", address: "Isolated test address", status: "Proposal/Price Quote",
      assignedExternalId: "90000", assignedName: "Synthetic agent", assignedCompany: company, assignedSaleName: "Synthetic sales agent",
      createdAt: "2026-10-10T08:30:00.000Z", quoteDealDate: "2026-10-10T08:30:00.000Z", quoteDealNumber: "QUOTE-001", pBox: null, trn: null, taxTotal: null } };
}
