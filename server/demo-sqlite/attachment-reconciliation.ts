import { posix } from "node:path";

export interface OriginalFileEvidence {
  path: string;
  sha256: string;
}

export interface AttachmentOwnershipEvidence {
  recordKey: string;
  authority: "authoritative" | "non-authoritative";
  storagePath?: string | null;
  sha256?: string | null;
  parentKey?: string | null;
  uploaderKey?: string | null;
}

export interface OwnershipDisposition {
  filePaths: string[];
  recordKeys: string[];
  reason: string;
}

export interface AttachmentReconciliation {
  verified: OwnershipDisposition[];
  ambiguous: OwnershipDisposition[];
  missing: OwnershipDisposition[];
  orphaned: OwnershipDisposition[];
  nonAuthoritativeHints: OwnershipDisposition[];
}

function canonicalPath(value: string): string {
  const normalized = posix.normalize(value.trim().replaceAll("\\", "/")).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || posix.isAbsolute(normalized)) {
    throw new Error("Evidence paths must be nonempty repository-relative paths");
  }
  return normalized;
}

function digest(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error("Evidence digests must be SHA-256 values");
  return normalized;
}

function present(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Reconciles only explicit paths and cryptographic digests. A display filename is
 * deliberately not accepted as evidence. Authoritative parent and uploader keys
 * are both required before one unique file/record relationship can be verified.
 */
export function reconcileAttachmentOwnership(
  originalFiles: readonly OriginalFileEvidence[],
  records: readonly AttachmentOwnershipEvidence[],
): AttachmentReconciliation {
  const files = originalFiles.map(file => ({ ...file, path: canonicalPath(file.path), sha256: digest(file.sha256) }));
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error("Original file paths must be unique");
  if (new Set(records.map(record => record.recordKey)).size !== records.length) throw new Error("Record keys must be unique");

  const pathIndex = new Map(files.map(file => [file.path, file]));
  const digestIndex = new Map<string, typeof files>();
  for (const file of files) {
    const matches = digestIndex.get(file.sha256) ?? [];
    matches.push(file);
    digestIndex.set(file.sha256, matches);
  }

  const result: AttachmentReconciliation = { verified: [], ambiguous: [], missing: [], orphaned: [], nonAuthoritativeHints: [] };
  const authoritativeMatches = new Map<string, AttachmentOwnershipEvidence[]>();

  for (const record of records) {
    const byPath = present(record.storagePath) ? [pathIndex.get(canonicalPath(record.storagePath))].filter(Boolean) : [];
    const byDigest = present(record.sha256) ? (digestIndex.get(digest(record.sha256)) ?? []) : [];
    const candidates = [...new Map([...byPath, ...byDigest].map(file => [file!.path, file!])).values()];
    const disposition: OwnershipDisposition = { filePaths: candidates.map(file => file.path).sort(), recordKeys: [record.recordKey], reason: "" };

    if (record.authority === "non-authoritative") {
      if (candidates.length) {
        disposition.reason = "Non-authoritative evidence is retained as a hint and cannot verify ownership";
        result.nonAuthoritativeHints.push(disposition);
      }
      continue;
    }

    if (!candidates.length) {
      disposition.reason = "Authoritative attachment record has no matching supplied file path or digest";
      result.missing.push(disposition);
      continue;
    }
    if (candidates.length !== 1 || !present(record.parentKey) || !present(record.uploaderKey)) {
      disposition.reason = candidates.length !== 1
        ? "Authoritative record matches multiple supplied files"
        : "Authoritative record lacks an explicit parent or uploader key";
      result.ambiguous.push(disposition);
      continue;
    }
    const file = candidates[0]!;
    const matches = authoritativeMatches.get(file.path) ?? [];
    matches.push(record);
    authoritativeMatches.set(file.path, matches);
  }

  for (const [filePath, matches] of authoritativeMatches) {
    const parents = new Set(matches.map(record => record.parentKey!.trim()));
    const uploaders = new Set(matches.map(record => record.uploaderKey!.trim()));
    const disposition = { filePaths: [filePath], recordKeys: matches.map(record => record.recordKey).sort(), reason: "" };
    const priorAmbiguities = result.ambiguous.filter(item => item.filePaths.includes(filePath));
    if (matches.length === 1 && parents.size === 1 && uploaders.size === 1 && priorAmbiguities.length === 0) {
      disposition.reason = "One authoritative record uniquely binds file, parent and uploader";
      result.verified.push(disposition);
    } else if (priorAmbiguities.length) {
      for (const ambiguity of priorAmbiguities) ambiguity.recordKeys = [...new Set([...ambiguity.recordKeys, ...disposition.recordKeys])].sort();
    } else {
      disposition.reason = "Multiple authoritative records claim the same supplied file";
      result.ambiguous.push(disposition);
    }
  }

  const claimed = new Set([...result.verified, ...result.ambiguous].flatMap(item => item.filePaths));
  for (const file of files) {
    if (!claimed.has(file.path)) result.orphaned.push({
      filePaths: [file.path], recordKeys: [],
      reason: "No available authoritative record matches this supplied file path or digest",
    });
  }
  for (const values of [result.verified, result.ambiguous, result.missing, result.orphaned, result.nonAuthoritativeHints]) values.sort((left, right) =>
    (left.filePaths[0] ?? left.recordKeys[0] ?? "").localeCompare(right.filePaths[0] ?? right.recordKeys[0] ?? ""));
  return result;
}
