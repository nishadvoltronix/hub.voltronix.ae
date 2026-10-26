import assert from "node:assert/strict";
import test from "node:test";
import { reconcileAttachmentOwnership, type AttachmentOwnershipEvidence, type OriginalFileEvidence } from "./attachment-reconciliation.js";

const hash = (digit: string) => digit.repeat(64);
const files: OriginalFileEvidence[] = [
  { path: "assets/photos/one.pdf", sha256: hash("1") },
  { path: "assets/photos/two.pdf", sha256: hash("2") },
];

test("filename-like hints and non-authoritative rows never verify ownership", () => {
  const records: AttachmentOwnershipEvidence[] = [
    { recordKey: "development:1", authority: "non-authoritative", storagePath: "assets/photos/one.pdf", parentKey: "task:1", uploaderKey: "user:1" },
    { recordKey: "historical:filename-only", authority: "authoritative", parentKey: "task:2", uploaderKey: "user:2" },
  ];
  const result = reconcileAttachmentOwnership(files, records);
  assert.equal(result.verified.length, 0);
  assert.equal(result.nonAuthoritativeHints.length, 1);
  assert.deepEqual(result.missing.map(item => item.recordKeys), [["historical:filename-only"]]);
  assert.deepEqual(result.orphaned.flatMap(item => item.filePaths), ["assets/photos/one.pdf", "assets/photos/two.pdf"]);
});

test("one complete authoritative digest relationship verifies exactly one file", () => {
  const result = reconcileAttachmentOwnership(files, [{ recordKey: "export:7", authority: "authoritative", sha256: hash("1"),
    parentKey: "task:4", uploaderKey: "user:9" }]);
  assert.deepEqual(result.verified[0], { filePaths: ["assets/photos/one.pdf"], recordKeys: ["export:7"],
    reason: "One authoritative record uniquely binds file, parent and uploader" });
  assert.deepEqual(result.orphaned.flatMap(item => item.filePaths), ["assets/photos/two.pdf"]);
});

test("missing parents, duplicate bytes and conflicting records remain ambiguous", () => {
  const duplicateFiles = [...files, { path: "assets/photos/copy.pdf", sha256: hash("1") }];
  const result = reconcileAttachmentOwnership(duplicateFiles, [
    { recordKey: "export:duplicate", authority: "authoritative", sha256: hash("1"), parentKey: "task:4", uploaderKey: "user:9" },
    { recordKey: "export:no-uploader", authority: "authoritative", storagePath: "assets/photos/two.pdf", parentKey: "task:5" },
  ]);
  assert.equal(result.verified.length, 0);
  assert.equal(result.ambiguous.length, 2);
  assert.deepEqual(result.ambiguous[0]!.filePaths, ["assets/photos/copy.pdf", "assets/photos/one.pdf"]);
  assert.deepEqual(result.ambiguous[1]!.filePaths, ["assets/photos/two.pdf"]);
  assert.equal(result.orphaned.length, 0);
});

test("conflicting authoritative claims to one file are not silently selected", () => {
  const result = reconcileAttachmentOwnership(files.slice(0, 1), [
    { recordKey: "export:a", authority: "authoritative", sha256: hash("1"), parentKey: "task:1", uploaderKey: "user:1" },
    { recordKey: "export:b", authority: "authoritative", storagePath: "assets/photos/one.pdf", parentKey: "task:2", uploaderKey: "user:2" },
  ]);
  assert.equal(result.verified.length, 0);
  assert.deepEqual(result.ambiguous[0]!.recordKeys, ["export:a", "export:b"]);
  assert.equal(result.orphaned.length, 0);
});

test("invalid paths and digests stop reconciliation", () => {
  assert.throws(() => reconcileAttachmentOwnership([{ path: "../private.pdf", sha256: hash("1") }], []));
  assert.throws(() => reconcileAttachmentOwnership([{ path: "assets/photos/a.pdf", sha256: "filename-only" }], []));
});
