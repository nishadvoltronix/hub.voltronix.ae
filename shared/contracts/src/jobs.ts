import type { Department } from "./departments.js";

export const JOB_STATUSES = ["Active", "Hold", "Closed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
/** Saved task details present in the original manager and assigned-worker views.
 * Optional fields keep older read providers compatible; no value is inferred. */
export interface JobSourceDetails {
  /** Explicit one-way local import; never enables remote edits. */
  sourceImport?: import("./zoho-sync.js").ZohoSyncSource;
  complaintDescription?: string | null;
  createdAt?: string | null;
  qualificationNumber?: string | null;
  quotationNumber?: string | null;
  enquiryDate?: string | null;
  quotationDate?: string | null;
  customerEmail?: string | null;
  customerContact?: string | null;
}
export interface JobRecord extends JobSourceDetails {
  id: string;
  dealName: string;
  accountName: string | null;
  jobNumber: string | null;
  salesStatus: string;
  jobStatus: string | null;
  remarks: string | null;
  holdByExternalId: string | null;
  version: number;
  updatedAt: string;
}
export interface JobPage { items: JobRecord[]; total: number; page: number; pageSize: number }

/** Source cohorts overlap: Completed means any latest department is completed. */
export const CENTRAL_JOB_COHORTS = ["all", "pending", "process", "completed", "hold", "closed"] as const;
export type CentralJobCohort = (typeof CENTRAL_JOB_COHORTS)[number];
export interface CentralJobRecord extends JobRecord {
  jobDate: string | null;
  assignedName: string | null;
  serviceCharge: string | null;
  departments: { department: Department; userName: string | null; status: string }[];
}
export interface CentralJobPage { items: CentralJobRecord[]; total: number; page: number; pageSize: number }
