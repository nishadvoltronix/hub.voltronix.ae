import { z } from "zod";
import { ZohoClientError } from "./client.js";
import type { VerifiedZohoRequestPort } from "./transports.js";
import { assertZohoV8QuotationPlan, buildZohoV8QuotationReadRequest, parseZohoV8QuotationReadback,
  verifyZohoV8QuotationReadback, type ZohoV8QuotationPlan, type ZohoV8QuotationSnapshot } from "./quotation-v8.js";

export type ZohoV8QuotationExecutionFailure = "INPUT_INVALID" | "WRITE_FAILED" | "PRECONDITION_FAILED"
  | "ACKNOWLEDGEMENT_INVALID" | "READBACK_FAILED" | "READBACK_INVALID" | "READBACK_MISMATCH";
/** No underlying error, provider payload, customer content or identifier escapes. */
export class ZohoV8QuotationExecutionError extends Error {
  constructor(readonly code: ZohoV8QuotationExecutionFailure, readonly remoteWriteAttempted: boolean) {
    super(`Zoho v8 quotation execution ${code}. No local commit or automatic retry was performed.`);
    this.name = "ZohoV8QuotationExecutionError";
  }
}
export interface ZohoV8QuotationExecutionResult {
  readonly quoteId: string;
  readonly quoteNumber: string;
  readonly modifiedTime: string;
  readonly snapshot: ZohoV8QuotationSnapshot;
  readonly normalizedInput: ZohoV8QuotationPlan["normalizedInput"];
  readonly localCommitPerformed: false;
  readonly productionAcceptance: false;
}
const receipt = z.object({ data: z.tuple([z.object({ code: z.literal("SUCCESS"), status: z.literal("success"),
  error: z.never().optional(), errors: z.never().optional(),
  details: z.object({ id: z.string().regex(/^[1-9][0-9]{0,29}$/) }) })]) }).strict();
const fail = (code: ZohoV8QuotationExecutionFailure, attempted = true): never => {
  throw new ZohoV8QuotationExecutionError(code, attempted);
};

/** Execute one immutable explicit plan and verify one complete readback.
 * The injected port owns verified organization binding, authorization, journal
 * reservations, bounded I/O and decimal serialization. Edit plans carry the
 * exact snapshot's If-Unmodified-Since precondition and explicit subform IDs.
 * This boundary neither discovers contacts/products nor transitions a deal,
 * commits persistence, enables a runtime or retries an uncertain operation. */
export async function executeZohoV8Quotation(port: VerifiedZohoRequestPort,
  input: ZohoV8QuotationPlan): Promise<ZohoV8QuotationExecutionResult> {
  try {
    assertZohoV8QuotationPlan(input);
    if (!port || typeof port.request !== "function") return fail("INPUT_INVALID", false);
  } catch { return fail("INPUT_INVALID", false); }
  let response: Awaited<ReturnType<VerifiedZohoRequestPort["request"]>>;
  try { response = await port.request(input.request); }
  catch (error) {
    return fail(error instanceof ZohoClientError && error.httpStatus === 412 ? "PRECONDITION_FAILED" : "WRITE_FAILED");
  }
  let quoteId: string;
  try {
    if (response.status === 412) return fail("PRECONDITION_FAILED");
    if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) return fail("WRITE_FAILED");
    const parsed = receipt.safeParse(response.body);
    if (!parsed.success) return fail("ACKNOWLEDGEMENT_INVALID");
    quoteId = parsed.data.data[0].details.id;
    if (input.expected.quoteId !== undefined && quoteId !== input.expected.quoteId) return fail("ACKNOWLEDGEMENT_INVALID");
  } catch (error) {
    if (error instanceof ZohoV8QuotationExecutionError) throw error;
    return fail("ACKNOWLEDGEMENT_INVALID");
  }
  try { response = await port.request(buildZohoV8QuotationReadRequest(quoteId, input.profile)); }
  catch { return fail("READBACK_FAILED"); }
  let snapshot: ZohoV8QuotationSnapshot;
  try {
    if (response.status !== 200) return fail("READBACK_FAILED");
    snapshot = parseZohoV8QuotationReadback(response.body, quoteId, input.profile);
  } catch (error) {
    if (error instanceof ZohoV8QuotationExecutionError) throw error;
    return fail("READBACK_INVALID");
  }
  if (!verifyZohoV8QuotationReadback(input, snapshot).matched) return fail("READBACK_MISMATCH");
  return Object.freeze({ quoteId, quoteNumber: snapshot.quoteNumber, modifiedTime: snapshot.modifiedTime,
    snapshot, normalizedInput: input.normalizedInput, localCommitPerformed: false, productionAcceptance: false });
}
