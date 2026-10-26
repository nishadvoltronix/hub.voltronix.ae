"use client";
import { useRef, useState } from "react";
import type { Department, JobAssignments } from "@/server/departments/contracts";
import { message, writeApi } from "@/components/settings/client";
import { useRead } from "./read-client";

export const departmentIcons: Record<Department, string> = { Electrical: "ph-lightning", Civil: "ph-buildings", PM: "ph-user-gear", Switchgear: "ph-plug", Maintenance: "ph-wrench" };
export const departmentName = (department: Department) => department === "PM" ? "Project Manager" : department;
export const assignmentStatusColor = (status?: string) => status === "Completed" ? "bg-success-subtle text-success" : status === "Hold" ? "bg-danger-subtle text-danger" : status === "Process" ? "bg-primary-subtle text-primary" : "bg-warning-subtle text-warning";

/** Both list and detail editors read the same fresh version and use the existing guarded writes. */
export function useJobAssignments(taskId: string, onSaved?: () => void) {
  const result = useRead<JobAssignments>(`/api/jobs/${taskId}/assignments`);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  async function save(operation: "assignments" | "unassign" | "accounts", input: object): Promise<boolean> {
    if (!result.data || result.data.sourceImport?.readOnly || saving.current) return false;
    saving.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await writeApi<JobAssignments>(`/api/jobs/${taskId}/${operation}`, "POST", { ...input, expectedVersion: result.data.version });
      setNotice("Assignment saved. Reload other job forms before saving further changes.");
      result.reload(); onSaved?.();
      return true;
    } catch (failure) { setError(message(failure)); return false; }
    finally { saving.current = false; setBusy(false); }
  }
  function refresh() { setError(""); setNotice(""); result.reload(); }
  return { result, error, notice, busy, save, refresh };
}
