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
  operationId: string;
  taskId: string;
  noteId?: string;
  version: number;
}
export interface LeadMutationCapabilities {
  version: number;
  canChangeStage: boolean;
  canWriteNotes: boolean;
  stages: string[];
  integrationAvailable: boolean;
  blockedOperationId?: string;
}
