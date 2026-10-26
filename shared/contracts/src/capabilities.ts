export type CrmPersistence = "local-demo" | "local-mysql" | "zoho";
/** Server-authorized actions for the current actor and verified runtime. */
export interface CrmWriteCapabilities {
  persistence: CrmPersistence | "unavailable";
  productCreate: boolean;
  leadNotes: boolean;
  /** Absent/false until the selected provider's explicit workflow migrations exist. */
  localWorkflow?: boolean;
  /** True only after the native outbound connection and actor binding are verified. */
  remoteWorkflow?: boolean;
  dealCreate?: boolean;
  /** Source-backed read filters; independent of local or remote write availability. */
  jobCohorts?: boolean;
  /** Native source-only quotation and synchronization read views are installed. */
  zohoInbound?: boolean;
  integrationAvailable: boolean;
}

export interface LocalPersistenceResult { persistence: "local-demo" | "local-mysql" }

/** Presentation discriminator only, never an authorization or provider selector. */
export function isLocalPersistence(value: unknown): value is LocalPersistenceResult["persistence"] {
  return value === "local-demo" || value === "local-mysql";
}

/** Presentation check only; every mutation must still authorize on the server. */
export function hasRemoteWorkflow(value: CrmWriteCapabilities | null | undefined): boolean {
  return value?.persistence === "zoho" && value.integrationAvailable === true && value.remoteWorkflow === true;
}

/** A remote runtime may retain explicitly local MySQL records; it never converts their provider. */
export function hasLocalRecordWorkflow(value: CrmWriteCapabilities | null | undefined, persistence: unknown): boolean {
  return value?.localWorkflow === true && isLocalPersistence(persistence)
    && (value.persistence === persistence || (persistence === "local-mysql" && hasRemoteWorkflow(value)));
}

export interface PersistenceReceipt {
  operationId: string;
  persistence?: CrmPersistence;
  /** Set only after the remote readback and durable local commit succeed. */
  remoteVerified?: true;
}

/** A successful HTTP response alone must never be presented as verified remote persistence. */
export function assertPersistenceReceipt(value: unknown, expected: { operationId: string; persistence: CrmPersistence }): asserts value is PersistenceReceipt {
  if (!value || typeof value !== "object") throw new Error("The save could not be confirmed. Reload this record before making another change.");
  const receipt = value as Partial<PersistenceReceipt>;
  if (receipt.operationId !== expected.operationId || receipt.persistence !== expected.persistence
    || (expected.persistence === "zoho" && receipt.remoteVerified !== true)) {
    throw new Error("The save could not be confirmed. Reload this record before making another change.");
  }
}
