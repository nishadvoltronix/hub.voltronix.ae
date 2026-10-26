import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scripts = ["start-local.ps1", "start-sqlite-demo.ps1", "stop-local.ps1"];

test("single-root repository resolves Next, Express and shared contracts without a PHP runtime", () => {
  for (const name of ["package.json", "package-lock.json", "src/app/layout.tsx", "tests/sqlite-reference/db/connection.ts",
    "shared/contracts/package.json", "server/src/cli.ts", "tsconfig.server.json", "tsconfig.server.build.json"])
    assert.equal(existsSync(join(root, name)), true, name);
  const controller = readFileSync(join(root, "server/demo-sqlite/control.ts"), "utf8");
  assert.match(controller, /join\(workspaceRoot, "node_modules\/next\/dist\/server\/lib\/start-server\.js"\), workspaceRoot/);
  assert.ok(!controller.includes('"../../nextjs/'));
  for (const name of ["package.json"]) {
    const manifest = JSON.parse(readFileSync(join(root, name), "utf8")) as { dependencies: Record<string, string>; scripts: Record<string, string> };
    assert.equal(manifest.dependencies["@voltronix/crm-contracts"], "file:./shared/contracts");
    assert.ok(Object.values(manifest.scripts).every(value => !/\bphp\b|composer/.test(value)));
  }
});

test("Express compiles under server and keeps the existing runtime independent of Next", () => {
  const build = JSON.parse(readFileSync(join(root, "tsconfig.server.build.json"), "utf8")) as {
    extends: string; compilerOptions: { rootDir: string; outDir: string }; include: string[];
  };
  assert.equal(build.extends, "./tsconfig.server.json");
  assert.equal(build.compilerOptions.rootDir, "server/src");
  assert.equal(build.compilerOptions.outDir, "server/dist");
  assert.deepEqual(build.include, ["server/src/**/*.ts"]);
  assert.equal(existsSync(join(root, "server/package.json")), false);
  assert.equal(existsSync(join(root, "server/package-lock.json")), false);
});

test("local wrappers preserve explicit demo actions, work from their own directory and never auto-initialize", () => {
  const start = readFileSync(join(root, scripts[0]!), "utf8"), demo = readFileSync(join(root, scripts[1]!), "utf8"), stop = readFileSync(join(root, scripts[2]!), "utf8");
  assert.match(start, /Join-Path \$PSScriptRoot 'start-sqlite-demo.ps1'/);
  assert.match(start, /if \(\$Restart\)\s*\{\s*& \$launcherPath -Action stop\s*\}/);
  assert.match(start, /& \$launcherPath -Action start/);
  assert.match(stop, /start-sqlite-demo.ps1'\) -Action stop/);
  assert.match(demo, /Join-Path \$PSScriptRoot 'server'/);
  assert.match(demo, /node --import tsx demo-sqlite\/control.ts @demoArguments/);
  assert.match(demo, /finally\s*\{\s*Pop-Location\s*\}/);
  assert.match(demo, /if \(\$commandExitCode -ne 0\)/);
  for (const source of [start, demo, stop]) assert.doesNotMatch(source, /php\.exe|\.php\b|-Action init|Set-Content|WriteAllText|Stop-Process/);
});

test("all PowerShell launchers parse without executing any action", { skip: process.platform !== "win32" }, () => {
  const paths = scripts.map(name => "'" + join(root, name).replaceAll("'", "''") + "'").join(",");
  const command = `$ErrorActionPreference='Stop'; foreach ($scriptPath in @(${paths})) { $parseErrors=$null; $tokens=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($scriptPath,[ref]$tokens,[ref]$parseErrors); if ($parseErrors.Count -gt 0) { throw 'Invalid launcher syntax.' } }`;
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
