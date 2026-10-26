export const DASHBOARD_DEPARTMENTS = ["Electrical", "Civil", "PM", "Switchgear", "Maintenance"] as const;
export type DashboardDepartment = (typeof DASHBOARD_DEPARTMENTS)[number];
export interface PipelineMetric { key: string; label: string; count: number; percentage: string }
export interface DepartmentProgress {
  department: DashboardDepartment; total: number; pending: number; process: number; completed: number; hold: number;
}
export interface PersonalDepartment extends DepartmentProgress { assignedToday: number; completedAssignedThisMonth: number }
export interface EmployeeWorkload { id: string; name: string; electrical: number; civil: number; pm: number }
/** Present only for an authorized global dashboard containing imported deals.
 * Missing operational history is not a zero balance or pending assignment. */
export interface DashboardSourceCoverage {
  mode: "local-zoho-snapshot" | "zoho-sync";
  importedDeals: number; localDeals: number;
  importedWonJobs: number; localWonJobs: number;
  importedAt: string | null;
  operationalHistory: "not-imported";
  users: "local-only";
  /** Verified Hub-native subtotals, separate from unavailable combined totals. */
  localOperations?: {
    pendingAssignmentJobs: number; completedJobs: number;
    accounts: { pendingJobs: number; totalPending: string | null; unknownServiceChargeJobs: number };
  };
}
export interface DashboardResult {
  asOf: string;
  timeZone: "Asia/Dubai";
  sourceCoverage?: DashboardSourceCoverage;
  global?: {
    wonJobs: number; pendingAssignmentJobs: number | null; completedJobs: number | null;
    accounts: { pendingJobs: number | null; totalPending: string | null; unknownServiceChargeJobs: number };
    leadsToday: number; leadsThisMonth: number;
    pipeline: PipelineMetric[];
    departmentProgress: DepartmentProgress[];
    employees: { items: EmployeeWorkload[]; total: number; page: number; pageSize: number };
  };
  departments: PersonalDepartment[];
  sales?: { total: number; today: number; thisMonth: number; stages: Pick<PipelineMetric, "key" | "label" | "count">[] };
}
