import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { historicalRelativePath, legacyArchive, ordinaryPath, preservedPath } from "../../tools/preservation-paths.mjs";

function fixture(t: { after(callback: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "crm-preservation-paths-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name: string, content = "preserved") => {
    const target = join(root, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { flag: "wx" });
    return target;
  };
  return { root, put };
}

test("historical legacy trees and explicitly copied root files have exact archive destinations", () => {
  for (const name of ["application/models/Admin.php", "system/core/Common.php", "include/dist/assets/logo.png", "vendor/font.txt",
    "index.php", "composer.json", "composer.lock", ".htaccess", "readme.rst", ".gitignore", "start-local.ps1", "stop-local.ps1",
    "start-sqlite-demo.ps1", "nextjs/.env.example", "nextjs/.env.mysql.example"])
    assert.equal(historicalRelativePath(name), `${legacyArchive}/${name}`);
  assert.equal(historicalRelativePath("application\\models\\Admin.php"), `${legacyArchive}/application/models/Admin.php`);
});

test("private data and existing actual environments retain their original paths", () => {
  for (const name of ["nextjs/.local-data/report.json", "nextjs/.private/profile.json", "nextjs/backups/source.sql",
    "nextjs/.env.local", "nextjs/.env.mysql.runtime.local", "server/.local-data/demo.sqlite", "assets/photos/original.pdf",
    ".local-dev/crm.sqlite", "license.txt", ".editorconfig"])
    assert.equal(historicalRelativePath(name), name);
  assert.equal(historicalRelativePath("nextjs/src/app/page.tsx"), "src/app/page.tsx");
  assert.equal(historicalRelativePath("frontend/src/app/page.tsx"), "src/app/page.tsx");
  assert.equal(historicalRelativePath("backend/.local-data/demo.sqlite"), "server/.local-data/demo.sqlite");
  assert.equal(historicalRelativePath("nextjs/assets/quotation-pdf/font.ttf"), "resources/quotation-pdf/font.ttf");
});

test("absolute, traversal, empty, control, ADS and Windows-normalizing paths are refused", () => {
  for (const name of ["", ".", "..", "../outside", "application/../outside", "application/./source.php", "/outside", "C:\\outside",
    "\\\\host\\share\\outside", "application//file.php", "application/file.php:stream", "application/file.php ", "application/file.php.",
    "application/\0file.php", "application/\nfile.php"])
    assert.throws(() => historicalRelativePath(name));
});

test("archive resolution never falls back to a replacement live file", t => {
  const { root, put } = fixture(t);
  put("application/models/Admin.php", "replacement");
  assert.throws(() => preservedPath(root, "application/models/Admin.php"));
  put(`${legacyArchive}/application/models/Admin.php`, "original");
  assert.equal(readFileSync(preservedPath(root, "application/models/Admin.php"), "utf8"), "original");
});

test("ordinary-path access and historical resolution are deliberately separate", t => {
  const { root, put } = fixture(t);
  const active = put(".env.example", "new template");
  const historical = put(`${legacyArchive}/nextjs/.env.example`, "old template");
  assert.equal(ordinaryPath(root, ".env.example"), active);
  assert.equal(preservedPath(root, "nextjs/.env.example"), historical);
  assert.throws(() => ordinaryPath(root, "../escape"));
});

test("file and directory contracts reject nonmatching entries", t => {
  const { root, put } = fixture(t);
  put(`${legacyArchive}/application/source.php`);
  assert.equal(preservedPath(root, "application", "directory"), resolve(root, legacyArchive, "application"));
  assert.throws(() => preservedPath(root, "application"));
  assert.throws(() => preservedPath(root, "application/source.php", "directory"));
});

test("ancestor junctions or symlinks are refused even when their target stays in the workspace", t => {
  const { root, put } = fixture(t);
  put("real/source.php");
  mkdirSync(join(root, legacyArchive), { recursive: true });
  symlinkSync(join(root, "real"), join(root, legacyArchive, "application"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => preservedPath(root, "application/source.php"));
});

test("missing private inputs are refused without searching or writing replacements", t => {
  const { root, put } = fixture(t);
  put(".local-data/report.json", "unrelated moved copy");
  assert.throws(() => preservedPath(root, "nextjs/.local-data/report.json"));
});
