import assert from "node:assert/strict";
import test from "node:test";
import type { createCrmServices } from "../src/crm/router.js";
import type { LocalQuotationIssuer } from "../src/crm/quotation-pdf/render.js";
import { calculateLocalQuotation, parseLocalQuotationInput } from "../src/crm/commercial/quotations.js";
import { runCrmDemoNativeWrites, nativeWriteChecks, syntheticCrmIssuer } from "../scripts/crm-demo/native-writes.js";
import { CrmDemoCaseError } from "../scripts/crm-demo/fixture.js";

type Input = Record<string, unknown>;
type Task = { id: string; version: number; status: string; notes: { id: string; content: string }[];
  quote?: { input: Input; version: number; issuer: LocalQuotationIssuer; grandTotal: string } };
// OFFLINE service-port orchestration double, not a database/SQL acceptance test.
// Real repository transactions/rollback/concurrency have mysql-target-writes tests.
function fixture(pdfFailure = false) {
  const tasks = new Map<string, Task>(), products = new Map<string, Input>(), operations = new Map<string, { input: string; result: Input }>();
  const checks: string[] = [], events: string[] = [], companies: string[] = [];
  function deny(token: string, code = 403) { if (token === "denied") throw Object.assign(new Error("synthetic denial"), { status: code }); }
  function conflict() { throw Object.assign(new Error("synthetic conflict"), { status: 409 }); }
  function operation(input: Input, work: () => Input) {
    const key = String(input.operationId), old = operations.get(key);
    if (old) { if (old.input !== JSON.stringify(input)) conflict(); return old.result; }
    const result = work(); operations.set(key, { input: JSON.stringify(input), result }); return result;
  }
  function current(id: string, input?: Input) {
    const task = tasks.get(id); assert.ok(task);
    if (input && task.version !== input.expectedVersion) conflict(); return task;
  }
  function servicesForIssuer(issuer: LocalQuotationIssuer) {
    const services = {
      commercial: {
        async createProduct(token: string, input: Input) {
          deny(token); return operation(input, () => { const productId = "90001"; products.set(productId, input);
            events.push("product:create"); return { productId, version: 1 }; });
        },
        async getProduct(_token: string, id: string) { const value = products.get(id)!; return { externalId: id, name: value.name, description: value.description, unitPrice: null }; },
        async listProducts(_token: string, input: Input) { assert.equal(input.query, "TEST ONLY native product");
          return { items: [...products.keys()].map(externalId => ({ externalId })) }; },
        async createQuotation(token: string, id: string, input: Input) {
          deny(token); const quote = input.quotation as Input;
          if (quote.discountType !== "percentage") throw Object.assign(new Error("synthetic validation"), { status: 400 });
          return operation(input, () => { const task = current(id, input);
            const normalized = parseLocalQuotationInput(quote), totals = calculateLocalQuotation(normalized);
            task.quote = { input: quote, version: 1, issuer: { ...issuer }, grandTotal: totals.grandTotal }; task.version++;
            events.push("quote:create"); return { quoteId: `local-${id}`, quoteVersion: 1, version: task.version }; });
        },
        async updateQuotation(token: string, id: string, input: Input) {
          deny(token); const task = current(id, input); assert.ok(task.quote);
          if (input.expectedQuoteVersion !== task.quote.version) conflict();
          const quote = input.quotation as Input, totals = calculateLocalQuotation(parseLocalQuotationInput(quote));
          task.quote.input = quote; task.quote.grandTotal = totals.grandTotal; task.quote.version++; task.version++;
          events.push("quote:edit"); return { quoteId: `local-${id}`, quoteVersion: task.quote.version, version: task.version };
        },
        async getQuotation(token: string, id: string) {
          deny(token, 404); const task = current(id), quote = task.quote; assert.ok(quote);
          return { calculationPolicy: "percentage-only-v2", quotation: quote.input, grandTotal: quote.grandTotal,
            task: { assignedCompany: quote.issuer.company, assignedSaleName: quote.issuer.salesperson }, pdfAvailable: true, version: quote.version, taskVersion: task.version };
        },
      },
      mutations: {
        async createDeal(token: string, input: Input) {
          deny(token); return operation(input, () => { const id = String(tasks.size + 1);
            tasks.set(id, { id, version: 1, status: "Pending", notes: [] }); events.push("deal:create"); return { taskId: id, version: 1 }; });
        },
        async addNote(token: string, id: string, input: Input) { deny(token); const task = current(id, input);
          task.notes.push({ id: "1", content: String(input.content) }); return { noteId: "1", version: ++task.version }; },
        async editNote(token: string, id: string, noteId: string, input: Input) { deny(token); const task = current(id, input);
          const note = task.notes.find(row => row.id === noteId); assert.ok(note); note.content = String(input.content); return { version: ++task.version }; },
        async changeStage(token: string, id: string, input: Input) { deny(token); const task = current(id, input);
          assert.equal(input.stage, "Site Visit"); task.status = String(input.stage); return { version: ++task.version }; },
      },
      leads: {
        async getLead(token: string, id: string) { deny(token, 404); return { ...current(id), persistence: "local-mysql", externalId: null }; },
        async listNotes(_token: string, id: string) { return { items: current(id).notes }; },
      },
      pdf: { async download(token: string, id: string) {
        deny(token, 404); const quote = current(id).quote; assert.ok(quote); companies.push(quote.issuer.company);
        return { bytes: Buffer.from(pdfFailure ? "bad PDF" : "%PDF-1.7 synthetic fixture only"), pages: 1 };
      } },
    };
    return services as unknown as ReturnType<typeof createCrmServices>;
  }
  return { tasks, products, events, companies, checks, run: () => runCrmDemoNativeWrites({ services: servicesForIssuer(syntheticCrmIssuer),
    servicesForIssuer, operator: "operator", denied: "denied", marker: "synthetic marker", check: async (name, work) => { await work(); checks.push(name); } }) };
}
test("OFFLINE staging native cases execute replay/conflict/percentage checks and both issuer PDFs", async () => {
  const f = fixture(); await f.run();
  assert.equal(f.checks.length, nativeWriteChecks); assert.equal(f.products.size, 1); assert.equal(f.tasks.size, 2);
  assert.deepEqual(f.events, ["product:create", "deal:create", "quote:create", "quote:edit", "deal:create", "quote:create", "quote:edit"]);
  assert.deepEqual(f.companies, ["VOLTRONIX CONTRACTING LLC", "VOLTRONIX SWITCHGEAR LLC"]);
  assert.ok([...f.tasks.values()].every(task => task.quote?.grandTotal === "179.55" && task.quote.version === 2));
});
test("OFFLINE staging native cases cannot record quotation acceptance when a PDF fails", async () => {
  const f = fixture(true); await assert.rejects(f.run(), CrmDemoCaseError);
  assert.equal(f.checks.length, nativeWriteChecks - 1); assert.equal(f.tasks.size, 1);
});
