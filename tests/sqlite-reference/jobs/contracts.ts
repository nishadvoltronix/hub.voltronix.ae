export const JOB_STATUSES = ["Active", "Hold", "Closed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export interface JobRecord {
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
