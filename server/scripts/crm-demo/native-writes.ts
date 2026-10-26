import { randomUUID } from "node:crypto";
import type { createCrmServices } from "../../src/crm/router.js";
import type { LocalQuotationIssuer } from "../../src/crm/quotation-pdf/render.js";
import { CrmDemoCaseError, ensureCrmDemo } from "./fixture.js";

type Services = ReturnType<typeof createCrmServices>;
export const nativeWriteChecks = 3;
export const syntheticCrmIssuer = Object.freeze({ company: "VOLTRONIX CONTRACTING LLC", salesperson: "TEST ONLY isolated issuer" });
async function refused(work: () => Promise<unknown>, status: number) {
  try { await work(); } catch (error) {
    ensureCrmDemo(error instanceof Error && "status" in error && error.status === status); return;
  }
  throw new CrmDemoCaseError();
}

/** Only called inside the owned fresh-schema harness, after its original cases.
 * TEST ONLY issuer values are fixture data, never production configuration. */
export async function runCrmDemoNativeWrites(options: {
  services: Services; servicesForIssuer: (issuer: LocalQuotationIssuer) => Services;
  operator: string; denied: string; marker: string;
  check: (name: string, work: () => Promise<void>) => Promise<void>;
}) {
  const { services, operator, denied, marker, check } = options;
  let productId = "", taskId = "", version = 0;
  const productInput = { operationId: randomUUID(), name: "TEST ONLY native product", description: marker };
  await check("synthetic native product create replay picker read and denied write", async () => {
    await refused(() => services.commercial.createProduct(denied, productInput), 403);
    const created = await services.commercial.createProduct(operator, productInput);
    ensureCrmDemo(created.productId); productId = created.productId;
    const replay = await services.commercial.createProduct(operator, productInput);
    ensureCrmDemo(replay.productId === productId && replay.version === created.version);
    const product = await services.commercial.getProduct(operator, productId);
    ensureCrmDemo(product.name === productInput.name && product.description === marker && product.unitPrice === null);
    const found = await services.commercial.listProducts(operator, { query: productInput.name });
    ensureCrmDemo(found.items.some(item => item.externalId === productId));
    await refused(() => services.commercial.createProduct(operator, { ...productInput, name: "changed replay" }), 409);
  });
  const deal = () => ({ operationId: randomUUID(), firstName: "TEST ONLY", lastName: "Native acceptance", companyName: "TEST ONLY native customer",
    email: "native-customer@example.invalid", mobile: "0000000000", phone: "0000000000", department: "VOLTRONIX CONTRACTING LLC",
    poBox: "", trn: "", address: "TEST ONLY isolated address", description: marker });
  await check("synthetic native deal notes stage optimistic conflict and own provenance", async () => {
    const input = deal();
    await refused(() => services.mutations.createDeal(denied, input), 403);
    const created = await services.mutations.createDeal(operator, input); taskId = created.taskId; version = created.version;
    const replay = await services.mutations.createDeal(operator, input); ensureCrmDemo(replay.taskId === taskId && replay.version === version);
    const note = await services.mutations.addNote(operator, taskId, { operationId: randomUUID(), expectedVersion: version, title: "TEST ONLY note", content: marker });
    ensureCrmDemo(note.noteId); const noteId = note.noteId;
    await refused(() => services.mutations.addNote(operator, taskId,
      { operationId: randomUUID(), expectedVersion: version, title: "stale synthetic", content: marker }), 409);
    const edit = await services.mutations.editNote(operator, taskId, noteId,
      { operationId: randomUUID(), expectedVersion: note.version, content: `${marker}:edited` });
    const staged = await services.mutations.changeStage(operator, taskId,
      { operationId: randomUUID(), expectedVersion: edit.version, stage: "Site Visit" }); version = staged.version;
    const lead = await services.leads.getLead(operator, taskId);
    ensureCrmDemo(lead.persistence === "local-mysql" && lead.externalId === null && lead.status === "Site Visit");
    await refused(() => services.leads.getLead(denied, taskId), 404);
    const notes = await services.leads.listNotes(operator, taskId);
    ensureCrmDemo(notes.items.some(note => note.id === noteId && note.content === `${marker}:edited`));
  });
  await check("synthetic native percentage quotation create edit issuer snapshot and both PDFs", async () => {
    for (const company of ["VOLTRONIX CONTRACTING LLC", "VOLTRONIX SWITCHGEAR LLC"]) {
      if (company !== syntheticCrmIssuer.company) {
        const next = await services.mutations.createDeal(operator, deal()); taskId = next.taskId; version = next.version;
      }
      const issuer = { company, salesperson: syntheticCrmIssuer.salesperson }, scoped = options.servicesForIssuer(issuer);
      const quotation = { subject: "TEST ONLY native percentage quotation", kindAttention: "TEST ONLY contact", discountType: "percentage",
        discount: "10", adjustment: "0", notes: marker,
        items: [{ productId, productName: productInput.name, description: marker, quantity: "2", unitPrice: "100", itemDiscount: "10", uom: "NOS" }] };
      await refused(() => scoped.commercial.createQuotation(operator, taskId,
        { operationId: randomUUID(), expectedVersion: version, quotation: { ...quotation, discountType: "flat" } }), 400);
      const create = { operationId: randomUUID(), expectedVersion: version, quotation };
      const saved = await scoped.commercial.createQuotation(operator, taskId, create);
      const replay = await scoped.commercial.createQuotation(operator, taskId, create);
      ensureCrmDemo(saved.quoteId === replay.quoteId && saved.quoteVersion === replay.quoteVersion);
      const detail = await scoped.commercial.getQuotation(operator, taskId);
      ensureCrmDemo(detail.calculationPolicy === "percentage-only-v2" && detail.quotation.discountType === "percentage"
        && detail.grandTotal === "170.10" && detail.task.assignedCompany === company
        && detail.task.assignedSaleName === issuer.salesperson && detail.pdfAvailable === true);
      const edited = await scoped.commercial.updateQuotation(operator, taskId, { operationId: randomUUID(), expectedVersion: detail.taskVersion,
        expectedQuoteVersion: detail.version, quotation: { ...quotation, discount: "5" } });
      await refused(() => scoped.commercial.updateQuotation(operator, taskId, { operationId: randomUUID(), expectedVersion: detail.taskVersion,
        expectedQuoteVersion: detail.version, quotation }), 409);
      const final = await scoped.commercial.getQuotation(operator, taskId);
      ensureCrmDemo(final.grandTotal === "179.55" && final.version === edited.quoteVersion
        && final.task.assignedCompany === company && final.task.assignedSaleName === issuer.salesperson);
      const pdf = await scoped.pdf.download(operator, taskId);
      ensureCrmDemo(pdf.bytes.subarray(0, 8).toString() === "%PDF-1.7" && pdf.pages > 0);
      await refused(() => scoped.pdf.download(denied, taskId), 404);
    }
  });
}
