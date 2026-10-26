import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertOrdinaryPath, privateAccess } from "../mysql-auth/files.js";
import { assessLegacySchema, sharedDatabaseWork } from "./assessment.js";
import { legacyMetadataLimitations, legacyMetadataQueries } from "./metadata.js";
import { sourceContract, sourceContractEvidence } from "./source-contract.js";

export const legacySnapshotPath = ".local-data/operators/legacy-schema-metadata.json";
export const legacySnapshotByteLimit = 8 * 1024 * 1024;
export class LegacyInspectionError extends Error {
  constructor() { super("Legacy inspection refused. Use plan, queries or assess; assess requires a private, ordinary, canonical metadata JSON file. No database or environment was changed."); this.name = "LegacyInspectionError"; }
}

/** Only reads this explicit metadata file; never dotenv, SQL dumps, profiles,
 * business rows or credentials. ACL inspection never repairs existing access. */
export function readLegacySnapshot(packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  privacy: (path: string) => void = privateAccess): unknown {
  let fd: number | undefined;
  try {
    const root = resolve(packageRoot), path = resolve(root, legacySnapshotPath);
    assertOrdinaryPath(root, path);
    if (!lstatSync(root).isDirectory()) throw new Error();
    for (const part of [".local-data", ".local-data/operators"]) {
      const parent = resolve(root, part);
      if (!lstatSync(parent).isDirectory()) throw new Error();
      privacy(parent);
    }
    privacy(path);
    const before = lstatSync(path);
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > legacySnapshotByteLimit) throw new Error();
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) throw new Error();
    // Allocate only the already bounded size plus a growth sentinel. Never use
    // an unbounded readFile on a descriptor whose file could grow during read.
    const buffer = Buffer.alloc(opened.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const read = readSync(fd, buffer, used, buffer.length - used, null);
      if (!read) break;
      used += read;
    }
    if (used !== opened.size) throw new Error();
    const source = buffer.subarray(0, used).toString("utf8").replace(/\r\n/g, "\n");
    const value: unknown = JSON.parse(source);
    if (source.trim() !== JSON.stringify(value, null, 2)) throw new Error();
    assertOrdinaryPath(root, path);
    const after = lstatSync(path), consumed = fstatSync(fd);
    for (const stat of [after, consumed]) {
      if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== opened.dev || stat.ino !== opened.ino
        || stat.size !== opened.size || stat.mtimeMs !== opened.mtimeMs || stat.ctimeMs !== opened.ctimeMs) throw new Error();
    }
    return value;
  } catch { throw new LegacyInspectionError(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function runLegacyInspection(args: readonly string[], readSnapshot: () => unknown = readLegacySnapshot): { exitCode: number; output: unknown } {
  try {
    if (args.length !== 1) throw new LegacyInspectionError();
    switch (args[0]) {
      case "plan": return { exitCode: 0, output: { status: "PREPARATION_ONLY", deploymentReady: false, sharedDatabaseWritesEnabled: false,
        sourceEvidence: sourceContractEvidence, sourceTables: sourceContract, requiredWork: sharedDatabaseWork,
        nextStep: "Later, inspect the actual server/schema and current PHP source. No live connection or runtime adapter is included in this offline tool." } };
      case "queries": return { exitCode: 0, output: { status: "QUERY_PLAN_ONLY", deploymentReady: false, sharedDatabaseWritesEnabled: false, queries: legacyMetadataQueries,
        parameters: "Bind the same selected application schema to each ? using the query adapter; never interpolate it.",
        limitations: legacyMetadataLimitations,
        collection: "collectLegacySchemaMetadata accepts a caller-owned, authorized, deadline-bounded query port. It opens no connection. No command in this CLI executes these queries." } };
      case "assess": return { exitCode: 2, output: assessLegacySchema(readSnapshot()) };
      default: throw new LegacyInspectionError();
    }
  } catch { return { exitCode: 1, output: { status: "REFUSED", deploymentReady: false, sharedDatabaseWritesEnabled: false,
    message: new LegacyInspectionError().message } }; }
}
