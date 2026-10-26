// Harness expectations only. Keep the persisted value separate from PHP's
// department-specific display label; Civil's uppercase label is not global.
export function sourceWorkerStatusLabels(department: string): Record<string, string> {
  return { Process: "Under Process", Hold: "ON HOLD",
    Complete: department === "Electrical" ? "COMPLETE" : "Complete",
    Completed: department === "Civil" ? "COMPLETED" : "Completed" };
}
