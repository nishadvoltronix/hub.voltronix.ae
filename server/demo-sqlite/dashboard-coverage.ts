import type { DashboardResult, PipelineMetric } from "@voltronix/crm-contracts";
import type { SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { DashboardError } from "../../tests/sqlite-reference/dashboard/service.js";
import { inspectZohoImportExtension } from "./zoho-import-store.js";

const imported = `FROM tasks t JOIN crm_demo_zoho_import_records r
  ON r.module='Deals' AND r.local_id=CAST(t.id AS TEXT)`;
const stages = [
  { key: "qualification", label: "Qualification", values: ["Pending", "Qualification"] },
  { key: "site_visit", label: "Site Visit", values: ["Site Visit"] },
  { key: "proposal", label: "Proposal", values: ["Proposal", "Proposal/Price Quote"] },
  { key: "won", label: "Won", values: ["Close to Won", "Closed Won"] },
  { key: "lost", label: "Lost / omitted", values: ["Close to Lost", "Closed Lost", "Omitted", "Proposal-Omitted"] },
  { key: "big_project", label: "Big project / empty stage", values: ["Big Project", "", null] },
] as const;
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new DashboardError(503);
  return value;
}
function percentage(value: number, total: number): string {
  if (!total) return "0.00";
  const basis = (BigInt(value) * 20_000n + BigInt(total)) / (BigInt(total) * 2n);
  return `${basis / 100n}.${String(basis % 100n).padStart(2, "0")}`;
}

/** Called only after the reference service authorizes its sections, within the
 * same read transaction. No source reads, writes, migrations or inferred user
 * mappings. Imported financial/workflow history was never captured. */
export function applyDashboardCoverage(db: SqliteDatabase, result: DashboardResult): DashboardResult {
  if (!result.global || !inspectZohoImportExtension(db)) return result;
  const number = (sql: string, ...args: string[]) => count((db.prepare(sql).get(...args) as { n: unknown }).n);
  const importedDeals = number("SELECT COUNT(*) n FROM crm_demo_zoho_import_records WHERE module='Deals'");
  if (!importedDeals) return result;
  const rows = db.prepare(`SELECT t.status,COUNT(*) n ${imported} GROUP BY t.status`).all() as { status: string | null; n: number }[];
  if (rows.reduce((sum, row) => sum + count(row.n), 0) !== importedDeals) throw new DashboardError(503);
  const pipeline: PipelineMetric[] = stages.map(stage => {
    const n = rows.filter(row => (stage.values as readonly (string | null)[]).includes(row.status)).reduce((sum, row) => sum + row.n, 0);
    return { key: stage.key, label: stage.label, count: n, percentage: percentage(n, importedDeals) };
  });
  const unmapped = importedDeals - pipeline.reduce((sum, stage) => sum + stage.count, 0);
  if (unmapped) pipeline.push({ key: "unmapped", label: "Other / unmapped stages", count: unmapped, percentage: percentage(unmapped, importedDeals) });
  const importedWonJobs = pipeline.find(stage => stage.key === "won")!.count;
  const localDeals = number("SELECT COUNT(*) n FROM tasks") - importedDeals;
  const localWonJobs = result.global.wonJobs - importedWonJobs;
  count(localDeals); count(localWonJobs);
  const last = db.prepare(`SELECT imported_at importedAt FROM crm_demo_zoho_import_runs
    ORDER BY julianday(imported_at) DESC,run_id DESC LIMIT 1`).get() as { importedAt: string } | undefined;
  if (!last || !Number.isFinite(Date.parse(last.importedAt))) throw new DashboardError(503);
  result.sourceCoverage = { mode: "local-zoho-snapshot", importedDeals, localDeals, importedWonJobs, localWonJobs,
    importedAt: last.importedAt, operationalHistory: "not-imported", users: "local-only" };
  const dubai = new Date(Date.parse(result.asOf) + 14_400_000);
  const year = dubai.getUTCFullYear(), month = dubai.getUTCMonth(), day = dubai.getUTCDate();
  const boundary = (m: number, d: number) => new Date(Date.UTC(year, m, d) - 14_400_000).toISOString();
  const created = (start: string, end: string) => number(`SELECT COUNT(*) n ${imported}
    WHERE julianday(t.created_at)>=julianday(?) AND julianday(t.created_at)<julianday(?)`, start, end);
  result.global = { ...result.global, wonJobs: importedWonJobs, pipeline,
    pendingAssignmentJobs: null, completedJobs: null,
    accounts: { pendingJobs: null, totalPending: null, unknownServiceChargeJobs: 0 },
    leadsToday: created(boundary(month, day), boundary(month, day + 1)),
    leadsThisMonth: created(boundary(month, 1), boundary(month + 1, 1)) };
  return result;
}
