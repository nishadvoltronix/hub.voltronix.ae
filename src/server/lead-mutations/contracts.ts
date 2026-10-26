/** No network implementation is provided. Only explicit, isolated test injection is currently supported. */
export interface ZohoRequest {
  method: "GET" | "POST" | "PUT";
  path: string;
  body?: unknown;
}
export interface ZohoTransport {
  request(request: ZohoRequest): Promise<{ status: number; body: unknown }>;
}
export const LEAD_TRANSITIONS = ["Site Visit", "Proposal/Price Quote", "Closed Won", "Closed Lost"] as const;
export interface LeadMutationResult {
  remoteVerified?: true;
  operationId: string;
  taskId: string;
  noteId?: string;
  version: number;
  persistence?: "local-demo" | "local-mysql" | "zoho";
  localOwnerId?: string;
}
export interface LeadMutationCapabilities {
  persistence?: "local-demo" | "local-mysql" | "zoho";
  sourceImport?: { provider: "zoho"; readOnly: true };
  version: number;
  canChangeStage: boolean;
  canWriteNotes: boolean;
  stages: string[];
  integrationAvailable: boolean;
  blockedOperationId?: string;
}
