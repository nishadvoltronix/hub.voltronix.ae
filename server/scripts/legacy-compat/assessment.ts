import { legacyMetadataLimitations, validateLegacySchemaSnapshot } from "./metadata.js";
import { sourceContract, sourceContractEvidence } from "./source-contract.js";

/** Open engineering work, not another request for owner permission. None of
 * these gates can be cleared by matching table/column names alone. */
export const sharedDatabaseWork = Object.freeze([
  { code: "DEPLOYED_SOURCE_AND_DDL", detail: "Compare the deployed PHP revision and authoritative schema, including keys, constraints, defaults, triggers, routines and events; metadata visibility is not completeness." },
  { code: "LEGACY_RUNTIME_ADAPTER", detail: "Implement explicit legacy repositories/composition. The current native MySQL runtime and migrations must not adopt the existing PHP schema." },
  { code: "CONCURRENT_WRITES", detail: "Test PHP and Node editing the same rows, numbering and assignments. PHP does not participate in the native app lock or optimistic version increments." },
  { code: "IDENTITIES_AND_AUTHORIZATION", detail: "Verify local versus Zoho IDs, password algorithms, statuses and permission mapping. Keep app sessions separate and test permission revocation across applications." },
  { code: "QUOTATION_SEMANTICS", detail: "Verify quote-number/task relationships, historical totals, discounts and supported issuer/PDF behavior without rewriting historical values." },
  { code: "SHARED_ATTACHMENT_STORAGE", detail: "Map existing file bytes, ownership and private storage/delivery; sharing a database does not share filesystem uploads." },
  { code: "ZOHO_WRITER_OWNERSHIP", detail: "Designate one scheduler/webhook owner initially; implement and test the new app's actual Zoho operations, retries and reconciliation. Do not enable a second sync loop merely by copying credentials." },
  { code: "ISOLATED_COEXISTENCE_ACCEPTANCE", detail: "Rehearse both actual applications on an isolated restored copy, including conflicts and failure recovery, before pointing hub.voltronix.ae at the same live database as crm.voltronix.ae." },
  { code: "HOST_BACKUP_AND_ROLLBACK", detail: "Verify production host, HTTPS/proxy/cookies, credentials/grants, backup restore and a rollback that preserves writes made by either application." },
] as const);

export type LegacyFinding = "TABLE_NOT_OBSERVED" | "TABLE_CASE_MISMATCH" | "TABLE_CASE_COLLISION"
  | "REFERENCED_COLUMNS_NOT_OBSERVED" | "VIEW_REQUIRES_REVIEW" | "ENGINE_REQUIRES_REVIEW"
  | "PRIMARY_KEY_NOT_OBSERVED" | "GENERATED_REFERENCED_COLUMN" | "ENUM_DOMAIN_NOT_COLLECTED"
  | "EXPRESSION_INDEX_NOT_COLLECTED";

/** Pure offline name coverage, deliberately not an adapter compatibility test.
 * Report only known source names, never arbitrary extra metadata identifiers. */
export function assessLegacySchema(value: unknown) {
  const snapshot = validateLegacySchemaSnapshot(value);
  const tables = sourceContract.map(entry => {
    const matches = snapshot.tables.filter(table => table.name.toLowerCase() === entry.table.toLowerCase());
    const exact = matches.find(table => table.name === entry.table);
    const table = exact ?? (snapshot.server.lowerCaseTableNames !== 0 ? matches[0] : undefined);
    const findings: LegacyFinding[] = [];
    if (matches.length > 1) findings.push("TABLE_CASE_COLLISION");
    if (!table) findings.push(matches.length ? "TABLE_CASE_MISMATCH" : "TABLE_NOT_OBSERVED");
    const columns = snapshot.columns.filter(column => column.table === table?.name);
    const missingColumns = entry.columns.filter(name => !columns.some(column => column.name.toLowerCase() === name.toLowerCase()));
    if (table) {
      if (missingColumns.length) findings.push("REFERENCED_COLUMNS_NOT_OBSERVED");
      if (table.kind !== "BASE TABLE") findings.push("VIEW_REQUIRES_REVIEW");
      if (table.engine?.toLowerCase() !== "innodb") findings.push("ENGINE_REQUIRES_REVIEW");
      const indexes = snapshot.indexes.filter(index => index.table === table.name);
      if (!indexes.some(index => index.name.toUpperCase() === "PRIMARY" && index.unique)) findings.push("PRIMARY_KEY_NOT_OBSERVED");
      if (indexes.some(index => index.column === null)) findings.push("EXPRESSION_INDEX_NOT_COLLECTED");
      const referenced = columns.filter(column => entry.columns.some(name => name.toLowerCase() === column.name.toLowerCase()));
      if (referenced.some(column => column.generated)) findings.push("GENERATED_REFERENCED_COLUMN");
      if (referenced.some(column => ["enum", "set"].includes(column.dataType.toLowerCase()))) findings.push("ENUM_DOMAIN_NOT_COLLECTED");
    }
    return { table: entry.table, category: entry.category, observed: Boolean(table),
      referencedColumnCount: entry.columns.length, observedReferencedColumnCount: entry.columns.length - missingColumns.length,
      missingColumns, findings };
  });
  return {
    status: "PREPARATION_ONLY" as const, deploymentReady: false as const, sharedDatabaseWritesEnabled: false as const,
    scope: "offline-source-name-coverage" as const,
    sourceEvidence: sourceContractEvidence, metadataLimitations: legacyMetadataLimitations,
    server: snapshot.server,
    coverage: {
      referencedTables: tables.length, observedReferencedTables: tables.filter(table => table.observed).length,
      tablesWithAllReferencedNames: tables.filter(table => table.observed && !table.missingColumns.length).length,
      referencedColumns: tables.reduce((count, table) => count + table.referencedColumnCount, 0),
      observedReferencedColumns: tables.reduce((count, table) => count + table.observedReferencedColumnCount, 0),
      visibleTables: snapshot.tables.length, structuralFindings: tables.reduce((count, table) => count + table.findings.length, 0),
    },
    tables, requiredWork: sharedDatabaseWork,
    conclusion: "Name coverage is not schema, data, workflow or concurrent-write compatibility. No production adapter or deployment approval is established.",
  };
}
