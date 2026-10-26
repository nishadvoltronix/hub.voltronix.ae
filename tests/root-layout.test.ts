import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import nextConfig from "../next.config";

const root = fileURLToPath(new URL("..", import.meta.url));
const json = (name: string) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));

test("single-root package owns Next, Express and public contracts without nested install commands", () => {
  const manifest = json("package.json");
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, "module");
  for (const dependency of ["next", "react", "express", "helmet", "@voltronix/crm-contracts"]) {
    assert.equal(typeof manifest.dependencies[dependency], "string");
  }
  assert.equal(manifest.dependencies["@voltronix/crm-contracts"], "file:./shared/contracts");
  for (const script of ["dev", "build", "start", "lint", "typecheck", "test"]) {
    assert.equal(typeof manifest.scripts[script], "string");
  }
  for (const command of Object.values(manifest.scripts)) {
    assert.equal(typeof command, "string");
    assert.doesNotMatch(command as string, /(?:^|\s)(?:frontend|backend)[/\\]|--prefix\s+(?:frontend|backend)\b/);
  }
  for (const name of ["src/app", "public", "server/src", "shared/contracts/src", "resources/quotation-pdf"]) {
    assert.equal(existsSync(new URL(`../${name}`, import.meta.url)), true);
  }
  for (const name of ["frontend", "backend", "server/package.json", "server/package-lock.json", "shared/contracts/package-lock.json"]) {
    assert.equal(existsSync(new URL(`../${name}`, import.meta.url)), false, `${name} must not be required by the single-root application`);
  }
});

test("root Next tracing preserves PDF resources while excluding independent Express and private data", () => {
  assert.equal(nextConfig.turbopack?.root?.replaceAll("\\", "/").replace(/\/$/, ""), root.replaceAll("\\", "/").replace(/\/$/, ""));
  assert.deepEqual(nextConfig.transpilePackages, ["@voltronix/crm-contracts"]);
  assert.ok(nextConfig.outputFileTracingIncludes?.["/api/quotations/*/pdf"]?.includes("./resources/quotation-pdf/**/*"));
  const exclusions = nextConfig.outputFileTracingExcludes?.["/*"] ?? [];
  for (const path of ["./server/**/*", "./.env*", "./.local-data/**/*", "./.private-legacy/**/*", "./assets/**/*"]) {
    assert.ok(exclusions.includes(path), path);
  }
});

test("root Next TypeScript scope does not accidentally include retained originals or Express compilation", () => {
  const config = json("tsconfig.json");
  assert.ok(config.include.includes("src/**/*.tsx"));
  assert.ok(config.include.includes("tests/**/*.ts"));
  assert.equal(config.include.includes("**/*.ts"), false);
  for (const path of ["server", "release", ".private-legacy", ".local-data", "node_modules"]) {
    assert.ok(config.exclude.includes(path));
  }
  assert.deepEqual(config.compilerOptions.paths, { "@/*": ["./src/*"] });
});
