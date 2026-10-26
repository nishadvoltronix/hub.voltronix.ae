import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditPublication, classifyPublicationPath, inspectCandidateContent, normalizePublicationPath, reviewedFixtureFindings, validateReviewedFixtures, validateTemplate } from "./audit-publication.mjs";

const unifiedTemplate = 'NODE_ENV=production\nAPP_ORIGIN=https://hub.voltronix.ae\nCRM_API_INSTANCE_ID=hub-crm\nCRM_DATABASE_MODE=disabled\nCRM_MYSQL_NETWORK_DISABLED=1\nZOHO_ENABLED=false\nNEXT_TELEMETRY_DISABLED=1\nCRM_WEB_HOST=127.0.0.1\nCRM_WEB_PORT=3301\nCRM_FRONTEND_BACKEND=express\nCRM_EXPRESS_ORIGIN=http://127.0.0.1:3302\nCRM_API_ENVIRONMENT=production\nCRM_API_HOST=127.0.0.1\nCRM_API_PORT=3302\n';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "crm-publication-synthetic-"));
  t.after(() => rmSync(root, { recursive: true }));
  const put = (path, value = "// Synthetic test fixture only.\n") => {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, value);
  };
  for (const path of ["server", "src", "tests", "scripts", "public", "resources", "shared/contracts", "tools"]) mkdirSync(join(root, path), { recursive: true });
  for (const path of [".editorconfig", "license.txt", "start-local.ps1", "start-sqlite-demo.ps1", "stop-local.ps1", "docs/PUBLICATION-README.md", "docs/PUBLICATION.gitignore",
    "deploy/ubuntu/nginx.conf.example", "deploy/ubuntu/hub-crm.service",
    "docs/manual-deployment-guide.md", "docs/final-release-checklist.md", "docs/mysql-production-operator-guide.md",
    "docs/runtime-excluded-assets.md", "docs/staging-acceptance.md", "docs/backend-production-environment.md",
    "docs/legacy-production-compatibility.md", "docs/production-preparation-report.md", "docs/single-project-layout.md", "docs/hub-rename.md"]) put(path);
  for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.server.json', 'tsconfig.server.build.json', 'tsconfig.demo.json']) put(path, '{}\n');
  for (const path of ['next.config.ts', 'eslint.config.mjs']) put(path);
  put('.env.example', unifiedTemplate);
  return { root, put, audit: options => auditPublication(root, { git: false, inventory: null, ...options }) };
}

test("positive path boundary excludes real environments and all unreviewed examples", () => {
  for (const path of ["server/.env", ".env.local", "server/src/.env.example", "docs/.env.example", "config-templates/application.env.example"]) {
    assert.notEqual(classifyPublicationPath(path), "source");
    assert.notEqual(classifyPublicationPath(path), "template");
  }
  assert.equal(classifyPublicationPath("server/.env.example"), "template");
  assert.equal(classifyPublicationPath(".env.example"), "template");
});

test("path traversal, drive paths, UNC paths, controls and alias tails are invalid", () => {
  for (const path of ["../src/a.ts", "server/../a.ts", "G:/a.ts", "\\\\server\\a.ts", "backend\\src\\a.ts", "/a.ts", "server//a.ts", "server/a.ts.", "server/a.ts ", "server/a\u0000.ts"]) {
    assert.throws(() => normalizePublicationPath(path), /Invalid publication path/);
  }
  assert.equal(normalizePublicationPath("src/app/api/[id]/route.ts"), "src/app/api/[id]/route.ts");
});

test("private directories, legacy PHP, archives and original business files never qualify", () => {
  for (const path of [".git/objects/a", "assets/photos/document.pdf", "nextjs/.local-data/evidence.json", "server/.private/profile.json", ".private-legacy/source/index.php", "server/src/credentials.json", "server/src/backup.dump", "server/src/database.sqlite", "server/src/data.7z", "server/demo-sqlite/ui-reference.php", "public/new-upload.png", "server/assets/quotation-pdf/sign.jpg", "resources/quotation-pdf/switchgear_bg4.png"]) {
    assert.ok(!["source", "template", "pinned-passive-asset"].includes(classifyPublicationPath(path)), path);
  }
});

test("deployment publication includes one Hub service, proxy and root/historical environment templates only", () => {
  for (const path of ["deploy/ubuntu/nginx.conf.example", "deploy/ubuntu/hub-crm.service"]) {
    assert.equal(classifyPublicationPath(path), "source");
  }
  for (const path of [".env.example", "server/.env.example"]) assert.equal(classifyPublicationPath(path), "template");
  for (const path of ["deploy/ubuntu/nginx.conf", "deploy/ubuntu/backend.env", "deploy/ubuntu/cert.pem", "deploy/ubuntu/other.service", "deploy/debian/voltronix-crm-api.service",
    "deploy/ubuntu/hub-api.env.example", "deploy/ubuntu/hub-web.env.example", "deploy/ubuntu/hub-crm-web.service", "deploy/ubuntu/hub-crm-api.service",
    "deploy/ubuntu/bills-crm.service", "tools/run-bills.mjs", "tools/prepare-bills-package.mjs"]) {
    assert.notEqual(classifyPublicationPath(path), "source");
    assert.notEqual(classifyPublicationPath(path), "template");
  }
});

test("deployment documentation is an exact reviewed selection, not permission for internal reports", () => {
  for (const path of ["docs/manual-deployment-guide.md", "docs/final-release-checklist.md", "docs/mysql-production-operator-guide.md",
    "docs/runtime-excluded-assets.md", "docs/staging-acceptance.md", "docs/backend-production-environment.md", "docs/hub-rename.md"]) {
    assert.equal(classifyPublicationPath(path), "source");
  }
  for (const path of ["docs/crm-readiness-report.md", "docs/approval.json", "docs/customer-export.md", "docs/.env.example"]) {
    assert.notEqual(classifyPublicationPath(path), "source");
  }
});

test("only exact approved placeholder template values and keys pass", () => {
  const safe = unifiedTemplate;
  assert.deepEqual(validateTemplate(".env.example", Buffer.from(safe)), []);
  for (const body of [safe + "TOKEN=synthetic\n", safe + "APP_ORIGIN=https://hub.voltronix.ae\n", safe.replace("express", "other"), safe.replace("http://127.0.0.1:3302", "https://example.invalid"), safe.replace('CRM_DATABASE_MODE=disabled', 'CRM_DATABASE_MODE=native'), safe.replace('https://hub.voltronix.ae', 'https://bills.voltronix.ae'), safe.replace('hub-crm', 'bills-crm'), "# none\n"]) {
    assert.ok(validateTemplate(".env.example", Buffer.from(body)).length);
  }
});

test("clean project documentation is optional and remains an exact content-checked selection", t => {
  const { put, audit } = fixture(t);
  const paths = ["PROJECT-STRUCTURE.md", "docs/clean-project-verification.md", "docs/project-audit.md"];
  assert.ok(!audit().rejected.some(row => paths.includes(row.path)));
  for (const path of paths) {
    assert.equal(classifyPublicationPath(path), "source");
    put(path, "# Synthetic project documentation\n");
  }
  assert.ok(paths.every(path => audit().files.some(row => row.path === path)));
  assert.notEqual(classifyPublicationPath("docs/unreviewed-project-data.json"), "source");
  put("docs/project-audit.md", "SQLite format 3\u0000synthetic");
  assert.ok(audit().rejected.some(row => row.path === "docs/project-audit.md"));
});

test("credential detector scans template comments and reports categories only", () => {
  const syntheticCanary = "SYNTHETIC_PUBLICATION_CANARY";
  const detectors = { knownCredentials: bytes => bytes.includes(Buffer.from(syntheticCanary)) ? ["synthetic-known-credential"] : [] };
  const findings = inspectCandidateContent(".env.example", Buffer.from(`# ${syntheticCanary}\n`), detectors);
  assert.ok(findings.includes("synthetic-known-credential"));
  assert.ok(!JSON.stringify(findings).includes(syntheticCanary));
});

test("private bytes disguised as source and database/profile JSON fail closed", () => {
  for (const bytes of [Buffer.from("SQLite format 3\0synthetic"), Buffer.from("%PDF-1.7\nsynthetic"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]), Buffer.from([0xff, 0xfe]), Buffer.from("INSERT INTO users VALUES ('synthetic');")]) {
    assert.ok(inspectCandidateContent("server/src/example.ts", bytes).length);
  }
  assert.ok(inspectCandidateContent("server/src/example.json", Buffer.from('{"password":"synthetic"}')).includes("private-profile-or-record-json"));
  assert.ok(inspectCandidateContent("server/src/example.ts", Buffer.from("synthetic private copy"), { privateContent: () => ["synthetic-private-content"] }).includes("synthetic-private-content"));
});

test("passive binary extension is insufficient and pinned assets reject changed bytes", () => {
  assert.ok(inspectCandidateContent("public/new.png", Buffer.from("synthetic")).includes("path-not-allowlisted"));
  assert.ok(inspectCandidateContent("public/legacy/assets/images/logo-voltronix.png", Buffer.from("synthetic")).includes("unreviewed-passive-asset-bytes"));
});

test("frozen exact source inventory blocks a newly added ordinary-looking file", t => {
  const { put, audit } = fixture(t);
  put("server/src/a.ts", "export const a = 1;\n");
  const first = audit();
  const inventory = first.files.map(file => file.source);
  put("server/src/customer-data.json", '{"name":"synthetic customer"}\n');
  const second = audit({ inventory });
  assert.ok(second.rejected.some(row => row.path === "server/src/customer-data.json" && row.reasons.includes("source-not-in-frozen-review-inventory")));
  assert.ok(!second.files.some(row => row.path.endsWith("customer-data.json")));
});

test("known-secret candidate is not hashed and does not leak through report metadata", t => {
  const { put, audit } = fixture(t);
  const canary = "SYNTHETIC_CANARY_DO_NOT_PRINT";
  put("server/src/a.ts", `// ${canary}`);
  const result = audit({ detectors: { knownCredentials: bytes => bytes.includes(Buffer.from(canary)) ? ["synthetic-known-credential"] : [] } });
  assert.ok(result.rejected.some(row => row.path === "server/src/a.ts"));
  assert.ok(!result.files.some(row => row.path === "server/src/a.ts"));
  assert.ok(!JSON.stringify(result).includes(canary));
  assert.equal(result.publicationDecision, "NO-GO");
});

test("ignored environment/private inputs are neither inspected nor included", t => {
  const { root, put, audit } = fixture(t);
  const canary = "SYNTHETIC_PRIVATE_UNREADABLE_CANARY";
  put("server/.env", canary);
  put("server/.local-data/customer.json", canary);
  put("server/src/safe.ts", "export const safe = true;\n");
  let readPrivate = false;
  const result = audit({ detectors: { knownCredentials: bytes => { if (bytes.includes(Buffer.from(canary))) readPrivate = true; return []; } } });
  assert.equal(readPrivate, false);
  assert.ok(!JSON.stringify(result).includes(canary));
  assert.equal(readFileSync(join(root, "server/.env"), "utf8"), canary);
});

test("symlink directory escape is refused without reading its target", t => {
  const { root, put, audit } = fixture(t);
  put("outside/safe.ts", "// synthetic outside target\n");
  symlinkSync(join(root, "outside"), join(root, "server/src"), process.platform === "win32" ? "junction" : "dir");
  const result = audit();
  assert.ok(!result.files.some(row => row.path.startsWith("server/src/")));
});

test("hard-linked candidate sources are refused", t => {
  const { root, put, audit } = fixture(t);
  put("outside/a.ts", "// synthetic source\n");
  mkdirSync(join(root, "server/src"), { recursive: true });
  linkSync(join(root, "outside/a.ts"), join(root, "server/src/a.ts"));
  assert.ok(audit().rejected.some(row => row.path === "server/src/a.ts"));
});

test("mapped public documentation replaces internal README without touching it", t => {
  const { root, put, audit } = fixture(t);
  const privateText = "Synthetic internal-only report.";
  put("README.md", privateText);
  put("docs/private-report.md", privateText);
  put("server/README.md", privateText);
  const first = audit(), second = audit();
  assert.equal(first.files.find(file => file.path === "README.md").source, "docs/PUBLICATION-README.md");
  assert.ok(!first.files.some(file => file.source === "server/README.md"));
  assert.equal(first.manifestSha256, second.manifestSha256);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), privateText);
});

test("reviewed synthetic exceptions bind the exact source bytes, path and category", () => {
  const bytes = Buffer.from("// synthetic fixture body\n");
  const path = "server/tests/synthetic.test.ts";
  const records = [{ path, sha256: createHash("sha256").update(bytes).digest("hex"), categories: ["literal-password-candidate"] }];
  assert.deepEqual(reviewedFixtureFindings(path, bytes, ["literal-password-candidate", "credential-bearing-url-candidate"], records), ["credential-bearing-url-candidate"]);
  assert.deepEqual(reviewedFixtureFindings(path, Buffer.concat([bytes, Buffer.from("changed")]), ["literal-password-candidate"], records), ["literal-password-candidate"]);
  assert.deepEqual(reviewedFixtureFindings("server/tests/other.test.ts", bytes, ["literal-password-candidate"], records), ["literal-password-candidate"]);
  assert.throws(() => validateReviewedFixtures([{ ...records[0], path: "server/src/server.ts" }]), /Invalid reviewed fixture inventory/);
  assert.throws(() => validateReviewedFixtures([{ ...records[0], categories: ["known-zoho-client-secret"] }]), /Invalid reviewed fixture inventory/);
});

test("synthetic generic exception cannot bypass exact known credentials or private copies", t => {
  const { put, audit } = fixture(t);
  const path = "server/tests/synthetic.test.ts", bytes = Buffer.from("// synthetic fixture body\n");
  put(path, bytes);
  const reviewedFixtures = [{ path, sha256: createHash("sha256").update(bytes).digest("hex"), categories: ["literal-password-candidate"] }];
  const result = audit({ reviewedFixtures, detectors: {
    genericCredentials: content => content.equals(bytes) ? ["literal-password-candidate"] : [],
    knownCredentials: content => content.equals(bytes) ? ["synthetic-known-credential"] : [],
    privateContent: content => content.equals(bytes) ? ["synthetic-private-copy"] : [],
  } });
  assert.deepEqual(result.rejected.find(row => row.path === path).reasons, ["synthetic-known-credential", "synthetic-private-copy"]);
  assert.equal(result.reviewedSyntheticMatches.length, 1);
});

test("mapped documents reject malformed encoding and binary payloads", t => {
  const { put, audit } = fixture(t);
  put("docs/PUBLICATION-README.md", Buffer.from([0xff, 0xfe, 0x01]));
  put("docs/PUBLICATION.gitignore", Buffer.from("SQLite format 3\0synthetic"));
  assert.equal(audit().rejected.length, 2);
});
