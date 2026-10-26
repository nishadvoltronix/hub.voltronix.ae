export interface ReportStages { qualification: number; siteVisit: number; proposal: number; won: number; lost: number; omitted: number; proposalOmitted: number }
export interface ReportJobCounts { active: number; hold: number; closed: number }
export interface EmployeePerformance extends ReportStages, ReportJobCounts {
  id: string; name: string; departmentRole: string | null; totalDeals: number;
  wonAmount: string | null; unknownAmounts: number;
  electrical: number; civil: number; pm: number; accounts: number;
  assigned: number; process: number; completed: number;
}
export interface PerformanceReport {
  dateFrom: string; dateTo: string; timeZone: "Asia/Dubai";
  /** Counts use the selected report date range; monthly series has its own range.
   * Deal/amount totals combine cohorts. Missing imported job states are excluded;
   * recorded job states and department assignments remain visible. */
  sourceCoverage?: { mode: "local-zoho-snapshot" | "zoho-sync"; importedDeals: number; importedWonJobs: number;
    operationalHistory: "not-imported"; users: "local-only"; lastSyncedAt?: string | null };
  summary: ReportJobCounts & { activeEmployees: number; totalDeals: number; wonJobs: number; wonAmount: string | null; unknownAmounts: number };
  stages: ReportStages; wonJobStatuses: ReportJobCounts;
  employees: { items: EmployeePerformance[]; total: number; page: number; pageSize: number };
  monthlySince: string; monthly: { month: string; wonAmount: string | null; unknownAmounts: number }[];
}
