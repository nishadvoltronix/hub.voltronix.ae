import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { credentialDetectorFromHistoricalSource, detectHistoricalPrivateCopy, parseBatchObjects, privatePathCategory, scanCredentialPatterns } from "./audit-git-history.mjs";

test("credential candidates return categories without values", () => {
  const marker = "synthetic-test-marker-not-a-real-credential";
  const result = scanCredentialPatterns(`const client_secret = '${marker}';`);
  assert.deepEqual(result, ["literal-credential-candidate"]);
  assert.equal(JSON.stringify(result).includes(marker), false);
});
test("safe placeholders and interpolated values are not literal credentials", () => {
  assert.deepEqual(scanCredentialPatterns("client_secret='YOUR_CLIENT_SECRET'; password=''; access_token='${TOKEN}';"), []);
});
test("unquoted environment values are detected without leaking matches", () => {
  assert.deepEqual(scanCredentialPatterns("CRM_SESSION_SECRET=synthetic-fixture-only\n"), ["environment-credential-candidate"]);
  assert.deepEqual(scanCredentialPatterns("CRM_SESSION_SECRET=YOUR_SESSION_SECRET\n"), []);
});
test("empty adjacent template assignments do not consume the next line as a credential", () => {
  assert.deepEqual(scanCredentialPatterns("ZOHO_CLIENT_SECRET=\r\nZOHO_REFRESH_TOKEN=\r\n"), []);
});
test("password, key and authenticated URL categories are redacted", () => {
  const result = scanCredentialPatterns("password='synthetic-fixture-password'; -----BEGIN PRIVATE KEY----- https://fixture:synthetic-only@example.invalid");
  assert.deepEqual(result, ["credential-bearing-url-candidate", "literal-password-candidate", "private-key-material"]);
});
test("private categories classify nested originals, environments, data and archives", () => {
  assert.equal(privatePathCategory("assets/photos/customer.pdf"), "original-uploads");
  assert.equal(privatePathCategory("backend/.env"), "actual-environment");
  assert.equal(privatePathCategory("backend/.env.example"), null);
  assert.equal(privatePathCategory("nextjs/.env.mysql.example"), "noncanonical-environment-template");
  assert.equal(privatePathCategory("backend/.local-data/x.sqlite"), "private-artifacts");
  assert.equal(privatePathCategory(".private-legacy/source/application/x.php"), "legacy-private-archive");
  assert.equal(privatePathCategory("x.sqlite-wal"), "database");
  assert.equal(privatePathCategory("source.sql"), "sql-requires-source-review");
});
test("batch framing preserves embedded newline and binary without printing payload", () => {
  const payload = Buffer.from([0, 10, 255, 65]), id = "a".repeat(40);
  const batch = Buffer.concat([Buffer.from(`${id} blob ${payload.length}\n`), payload, Buffer.from("\n")]);
  const result = parseBatchObjects(batch);
  assert.deepEqual(result.get(id).content, payload);
  assert.equal(result.get(id).type, "blob");
});
test("batch failure never includes a hostile raw object header", () => {
  assert.throws(() => parseBatchObjects(Buffer.from("synthetic-sensitive-header\n")), { message: "Unavailable or invalid local Git object." });
  assert.throws(() => parseBatchObjects(Buffer.from(`${"a".repeat(40)} blob 8\nshort`)), { message: "Truncated local Git object." });
});
test("exact historical credential matching returns only category and fails closed without source", () => {
  const marker = "synthetic-fixture-secret-value-only";
  const detector = credentialDetectorFromHistoricalSource(`$client_secret = '${marker}';`);
  assert.deepEqual(detector(Buffer.from(`prefix ${marker} suffix`)), ["known-zoho-client-secret"]);
  assert.deepEqual(detector("unrelated safe bytes"), []);
  assert.throws(() => credentialDetectorFromHistoricalSource("client_secret='YOUR_CLIENT_SECRET';"), { message: "Known historical credential source unavailable; comparison cannot be certified." });
});
test("renaming a private file does not bypass byte-copy matching and no digest is returned", () => {
  const content = Buffer.from("synthetic private file bytes only");
  for (const format of ["sha1", "sha256"]) {
    const id = createHash(format).update(`blob ${content.length}\0`).update(content).digest("hex");
    const forbidden = new Map([[id, ["original-uploads"]]]);
    assert.deepEqual(detectHistoricalPrivateCopy(content, format, forbidden), ["historical-private-content:original-uploads"]);
    assert.deepEqual(detectHistoricalPrivateCopy(Buffer.from("different safe bytes"), format, forbidden), []);
  }
});
