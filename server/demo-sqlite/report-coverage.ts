import type { PerformanceReport } from "@voltronix/crm-contracts";
import type { SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { ReportError } from "../../tests/sqlite-reference/reports/service.js";
import { inspectZohoImportExtension } from "./zoho-import-store.js";

/** Reference totals retain their historical population; flag the mixed source
 * and remove imported missing statuses from the reference's legacy Active
 * default. No history or live financial claim is inferred from Zoho Amount. */
export function applyReportCoverage(db: SqliteDatabase, report: PerformanceReport): PerformanceReport {
  if (!inspectZohoImportExtension(db) || !db.prepare("SELECT 1 FROM crm_demo_zoho_import_records WHERE module='Deals' LIMIT 1").get()) return report;
  const start = new Date(Date.parse(`${report.dateFrom}T00:00:00Z`) - 14_400_000).toISOString();
  const end = new Date(Date.parse(`${report.dateTo}T00:00:00Z`) + 86_400_000 - 14_400_000).toISOString();
  const row = db.prepare(`SELECT COUNT(*) importedDeals,
    COUNT(CASE WHEN t.status IN ('Close to Won','Closed Won') THEN 1 END) importedWonJobs,
    COUNT(CASE WHEN t.Job_Status IS NULL OR t.Job_Status='' THEN 1 END) unknownStatus,
    COUNT(CASE WHEN t.status IN ('Close to Won','Closed Won') AND (t.Job_Status IS NULL OR t.Job_Status='') THEN 1 END) unknownWonStatus
    FROM tasks t JOIN crm_demo_zoho_import_records r ON r.module='Deals' AND r.local_id=CAST(t.id AS TEXT)
    WHERE julianday(t.created_at)>=julianday(?) AND julianday(t.created_at)<julianday(?)`).get(start, end) as Record<string, number>;
  if (Object.values(row).some(value => !Number.isSafeInteger(value) || value < 0)
    || report.summary.active < row.unknownStatus! || report.wonJobStatuses.active < row.unknownWonStatus!) throw new ReportError(503);
  report.summary.active -= row.unknownStatus!;
  report.wonJobStatuses.active -= row.unknownWonStatus!;
  report.sourceCoverage = { mode: "local-zoho-snapshot", importedDeals: row.importedDeals!, importedWonJobs: row.importedWonJobs!,
    operationalHistory: "not-imported", users: "local-only" };
  return report;
}
