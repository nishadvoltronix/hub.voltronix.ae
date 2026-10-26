export const DEPARTMENTS = ["Electrical", "Civil", "PM", "Switchgear", "Maintenance"] as const;
export type Department = (typeof DEPARTMENTS)[number];
export const ASSIGNMENT_STATUSES = ["Assigned", "Process", "Completed", "Hold"] as const;
export const LOG_OPTIONS = {
  Electrical: {
    authority: ["-", "DESIGN", "FITOUT", "GE", "GW", "INFRA", "NETWORK MODIFICATION", "POWER NOC", "POWER UPGRADATION", "TEMP POWER", "WATER METER", "WATER NOC", "ZERO KW"],
    status: ["-", "DOCUMENTS PENDING", "POWER NOC SUBMITTED", "POWER NOC APPROVED", "GW", "COMMENT", "DRAWING PREPARATION", "DESIGN SUBMITTED", "DESIGN APPROVED", "INSPECTION", "Complete", "Hold", "SITE WORKS", "W NOC APPROVED", "PAYMENT PENDING", "INSPECTION APPROVED"],
  },
  Civil: {
    authority: ["-", "TRAKHEES", "DCD", "DM", "DDA", "DM HSE", "RTA", "JAFZA", "DM PLANNING", "CONCORDIA", "BM", "DEWA", "NAKHEEL", "DSO", "DESIGN"],
    status: ["-", "DOCUMENTS PENDING", "POWER NOC SUBMITTED", "POWER NOC APPROVED", "GW", "COMMENT", "DRAWING PREPARATION", "DESIGN SUBMITTED", "DESIGN APPROVED", "INSPECTION", "Completed", "Hold", "SITE WORKS", "W NOC APPROVED", "PAYMENT PENDING", "INSPECTION APPROVED"],
  },
  PM: { scope: ["-", "Substation Construction", "Electrical Panel Works", "Electrical Cabling Works"], status: ["-", "Process", "Completed"] },
  Switchgear: { scope: ["-", "Panel Design and Engineering", "Panel Manufacturing", "Testing and Delivery"], status: ["-", "Process", "Completed"] },
  Maintenance: { scope: ["-", "Preventive Maintenance Works", "Breakdown Rectification", "AMC Support Services"], status: ["-", "Process", "Complete"] },
} as const;
export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }
export interface Assignment {
  id: string; taskId: string; department: Department; userId: string | null; userName: string | null;
  status: string; actorId: string | null; assignedAt: string | null; version: number;
}
export interface AccountAssignment {
  id: string; userId: string | null; userName: string | null; status: string | null; assignedAt: string | null;
}
export interface JobAssignments { taskId: string; version: number; assignments: Assignment[]; accounts: AccountAssignment | null }
export interface DepartmentJob {
  id: string; dealName: string; accountName: string | null; jobNumber: string | null;
  salesStatus: string; jobStatus: string | null; remarks: string | null; version: number; updatedAt: string;
  assignment: Assignment;
}
export interface WorkLog {
  id: string; taskId: string; department: Department; assignmentId: string; actorId: string; actorName: string;
  authority: string | null; scope: string | null; status: string; comments: string | null; notes: string; createdAt: string;
  attachment: { id: string; name: string; mediaType: string; size: number } | null;
}
