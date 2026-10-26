export const PIPELINE_STAGES = [
  { key: "qualification", label: "Qualification", statuses: ["Pending", "Qualification"] },
  { key: "siteVisit", label: "Site visit", statuses: ["Site Visit"] },
  { key: "proposal", label: "Proposal", statuses: ["Proposal", "Proposal/Price Quote"] },
  { key: "won", label: "Closed won", statuses: ["Close to Won", "Closed Won"] },
  { key: "lost", label: "Lost / omitted", statuses: ["Close to Lost", "Closed Lost", "Omitted", "Proposal-Omitted"] },
] as const;
export type PipelineStage = typeof PIPELINE_STAGES[number]["key"] | "other";
export interface LeadPage<T> { items: T[]; total: number; page: number; pageSize: number }
export interface PipelineLead {
  persistence?: "local-demo" | "local-mysql" | "zoho"; localOwnerId?: string;
  /** Explicit one-way local import; never enables remote edits or local ownership. */
  sourceImport?: import("./zoho-sync.js").ZohoSyncSource;
  id: string; dealName: string; status: string; stage: PipelineStage;
  accountName: string | null; assignedExternalId: string | null; assignedName: string | null;
  serviceCharge: string | null; displayNumber: string | null; createdAt: string; updatedAt: string;
}
export interface PipelineResult extends LeadPage<PipelineLead> {
  counts: Record<PipelineStage, number>;
  scope: "all" | "own";
}
export interface PipelineAgent { externalId: string; name: string }
export interface LeadDetail extends PipelineLead {
  externalId: string | null; customerName: string | null; customerEmail: string | null;
  customerContact: string | null; address: string | null; description: string | null;
  remark: string | null; notes: string | null; assignmentNotes: string | null;
  ownerExternalId: string | null; createdByLocalId: string | null; jobStatus: string | null;
  dealNumber: string | null; enquiryNumber: string | null; qualificationNumber: string | null;
  siteNumber: string | null; quotationNumber: string | null; jobNumber: string | null; lostNumber: string | null;
  quoteId: string | null; enquiryDate: string | null; qualificationDate: string | null;
  siteDate: string | null; quotationDate: string | null; jobDate: string | null; lostDate: string | null;
}
export interface LeadNote {
  id: string; title: string; content: string; externalNoteId: string | null; createdAt: string; updatedAt: string;
}
export interface LeadStatusEvent { id: string; status: string; actorId: string | null; actorName: string | null; occurredAt: string }
