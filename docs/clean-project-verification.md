# Clean Hub project verification

Verified locally on 17 October 2026 in `G:\hub.voltronix.ae` with Windows, Node.js 24.19.0 and npm 11.17.0. This is a full development source project with a database-disabled startup foundation. It is **not production-ready**: the full test run has 62 failures involving intentionally excluded private evidence/assets, and the legacy database adapter is unimplemented.

## Delivered source and preserved originals

The new sibling directory was created without copying Git history. The authoritative source candidate was the latest reviewed Hub preparation worktree at `G:\crm.voltronix.ae\release\bills-production-prep-20261017`, checked against its full source archive. All 788 candidate source files matched the prepared working files. Archive SHA-256:

```text
a0eaed8f749d4ef0cb605909908a9161cf2267ed2483bb105f18fa61fe8a9c04
```

785 files were initially copied. The final source allowlist contains 789 files after adding current structure/audit/verification documentation and a development smoke check. All 186 original test files were preserved. No new deployment archive was needed for this development-project task; the existing deployment-only package remains in the original workspace.

The three omitted, superseded reports were `docs/production-preparation-report.md`, `docs/single-project-layout.md` and `docs/hub-rename.md`. They remain in the original preparation worktree. No files were deleted from either project. The [complete top-level audit](project-audit.md) classifies all 41 original items; [PROJECT-STRUCTURE.md](../PROJECT-STRUCTURE.md) describes the retained source and startup flow.

No `.git`, actual environment, dependency installation, build output, original database, upload, session, private legacy snapshot, private PDF mark or nested release was copied. `backend/` and `nextjs/` contain no active application source/package entrypoints; their original environments and state remain untouched. `config-templates/` contains unused historical templates rather than current Hub configuration. The reviewed public UI assets and both required copies of the PDF fonts/notices were retained.

Installation and verification subsequently generated new `node_modules/`, `.next/`, compiler output, type metadata, ignored `release/` evidence and `.local-data/` test reports. Tests created and wrote fresh synthetic SQLite fixtures. These are newly generated local outputs, not copied user databases, and are excluded from source publication. No original or production database was accessed, migrated, seeded or changed. No production server, Zoho or GitHub was contacted for this cleanup.

The local receipt `release/clean-project-source.json` records each copied path/hash, exclusions, and initial original/preparation Git HEAD, status and index hashes. `release/clean-project-final.json` records the final comparison and exact source changes. These receipts stay local and are ignored. There is no `.git` or actual root/server `.env` in the new project.

## Installation, compilation and startup results

| Check | Result |
| --- | --- |
| Root manifest versus lockfile | Dependency and development-dependency maps match; root lockfile unchanged. One install, linked shared-contract package. |
| Dependency install | Passed: `npm ci --include=dev --ignore-scripts --offline --no-audit --no-fund`; 294 packages. No lifecycle setup ran. The installed Windows SQLite prebuild worked in synthetic tests. |
| Imports | 715 source/tool files, 1,942 relative or alias imports audited, zero unresolved local source imports. |
| Typecheck | Passed: `npm run typecheck` (contracts, Next route types/web, API and isolated reference code). |
| Lint | Passed: `npm run lint`; changed launcher/publication tools also passed targeted ESLint. |
| Production build | Passed: contracts, Express and Next production outputs via `node tools/run-hub.mjs build`, with all safe settings supplied only to that child process. |
| Missing configuration | Passed: sanitized process without `.env` exits 1 before opening listeners; reports missing explicit `NODE_ENV`. |
| Development startup | 4 checks passed with explicit synthetic process settings and owned ephemeral loopback ports. |
| Built production startup/isolation | 12 checks passed, including combined start and the foundation HTTP smoke. |

Build verification did not create a fake `.env`. A clean OS-only child environment was combined with the 14 safe values parsed from `.env.example`; the build then ran the normal Hub build entrypoint. Startup checks substituted available ephemeral loopback ports. Original processes and the illustrative ports 3301/3302 were not appropriated or stopped.

The 12 production checks used `node --test tools/hub-foundation-smoke.mjs release/production-smoke.mjs`. The local ignored second harness adapts the retained development smoke to `tools/run-hub.mjs start`; it creates no environment file. The normal `tools/singleproject-smoke.mjs` was not run because it specifically expects an actual configured root `.env`.

Observed startup behavior: Hub login HTML and built/public assets return 200; API identity matches the configured instance/origin; readiness, authentication and representative CRM data routes return 503 without creating sessions. A replaced API receives only identity probes, never browser credentials. Missing/invalid configuration and occupied ports refuse startup. Stopping owned smoke processes releases both listeners. No fallback to unrelated services on ports 3001/3002 is part of normal Hub development/build/start.

## Full test results and private dependencies

All suites were run independently so one failure did not hide later results. The contracts/server compilers ran before the applicable suites. MySQL network access was disabled and Zoho remained off. The test bodies were:

```text
node tools/run-local.mjs test:server
node tools/run-local.mjs test:demo
node --import tsx --test --test-concurrency=2 tests/*.test.ts
npm run test:tools
node --test tools/development-smoke.mjs
node --test tools/hub-foundation-smoke.mjs release/production-smoke.mjs
```

| Suite | Executed | Passed | Failed |
| --- | ---: | ---: | ---: |
| API/server | 883 | 856 | 27 |
| Isolated demo/reference | 222 | 218 | 4 |
| Web/domain | 479 | 448 | 31 |
| Tools | 99 | 99 | 0 |
| Development smoke | 4 | 4 | 0 |
| Built production smoke | 12 | 12 | 0 |
| **Total** | **1,699** | **1,637** | **62** |

There were no skips or cancellations in these runs. The demo historical harness fails during module loading, so its unavailable inner subtests are not additional executed tests. Earlier focused tool/template runs are included in the full tools suite, not double-counted. The aggregate `npm test` cannot currently pass; it stops at the first failing suite. Tests were not removed, weakened or marked skipped to hide missing private evidence.

The 62 failures were triaged as follows:

| Files | Failures | Excluded prerequisite |
| --- | ---: | --- |
| `server/tests/crm-quotation-pdf.test.ts` | 26 | 25 private quotation backgrounds/signatures/stamps, including one downstream expected-error mismatch; one archived PHP font-provenance input. |
| `server/tests/mysql-target-writes.test.ts` | 1 | Quotation background during synthetic PDF rendering. |
| `server/demo-sqlite/historical-harness-reproduction.test.ts` | 1 | `.private-legacy` source/evidence at module import. |
| `server/demo-sqlite/runtime.test.ts` | 1 | Missing private PDF assets cause unavailable rendering instead of the expected success. |
| `server/demo-sqlite/workflow.test.ts` | 2 | Private quotation background. |
| `tests/quotation-pdf.test.ts` | 21 | 20 private PDF asset cases and one archived font-evidence case. |
| `tests/commercial-persistence.test.ts` | 1 | Private `databg.png` quotation background. |
| Nine preserved-source suites listed below | 9 | Excluded `.private-legacy` evidence. |

The nine source-preservation suites are `tests/attachments-source-layout.test.ts`, `tests/catalog-source-layout.test.ts`, `tests/department-work-layout.test.ts`, `tests/job-source-details-layout.test.ts`, `tests/jobs-source-actions-layout.test.ts`, `tests/navigation-source-labels.test.ts`, `tests/pipeline-entry.test.ts`, `tests/preserved-font-notice.test.ts`, and `tests/work-log-date.test.ts`.

Affected retained implementation includes `src/server/quotation-pdf/render.ts`, `server/src/crm/quotation-pdf/render.ts`, the reference PDF renderer, `tests/helpers/preserved-source.ts`, and historical preservation/harness tools. The source stays present; private inputs remain outside the clean project. See [runtime asset boundaries](runtime-excluded-assets.md). Successful compilation does not make these PDF paths functional without their separately reviewed assets.

Additional historical tools were not represented as passing: `verify:boundaries` expects absent `docs/express-api-contracts.md` and old route counts; `scripts/verify-staging-docs.ps1` expects four historical documents not included here; `verify:local` assumes the old layout/private manifest/Git context. Live MySQL, Zoho, historical-data acceptance, Linux service/TLS and server deployment checks were not run.

Local logs are `release/install.log`, `typecheck.log`, `lint.log`, `build.log`, `tests-server.log`, `tests-demo.log`, `tests-web.log`, `tests-tools.log`, and `production-smoke.log`. The missing-configuration result is `release/missing-configuration.json`. Logs and synthetic evidence are ignored, not source publication inputs.

## Configuration and database boundaries

The safe root `.env.example` is ready. There is deliberately no actual `.env`. Normal Hub development/build/start uses one root environment file (or explicit process settings) for two managed Node services in one project. `server/.env.example` is retained as clearly marked historical CLI reference; it is not a second Hub configuration.

Before your own startup, supply/review `APP_ORIGIN`, `CRM_API_INSTANCE_ID`, available `CRM_WEB_PORT`/`CRM_API_PORT`, and matching `CRM_EXPRESS_ORIGIN`. Keep both hosts at `127.0.0.1`, `CRM_FRONTEND_BACKEND=express`, `NODE_ENV=production`, `CRM_API_ENVIRONMENT=production`, `CRM_DATABASE_MODE=disabled`, `CRM_MYSQL_NETWORK_DISABLED=1`, `ZOHO_ENABLED=false`, and `NEXT_TELEMETRY_DISABLED=1`. The development launcher selects Next development mode only for its web child. No database password, OAuth credential or default account is needed or supplied for this foundation. Full variable explanations and setup commands are in [the environment guide](backend-production-environment.md) and [README](../README.md).

Normal Hub dev/build/start refuses database/Zoho activation and does not compose a persistence adapter, initialize a database or run migrations. MySQL driver entrypoints refuse connections when `CRM_MYSQL_NETWORK_DISABLED=1` is present in their process environment. Explicit MySQL migration/operator commands do not load the shared root `.env`; a setting only in that file is not a global interlock. Those commands still require separate profile/identity/approval gates, including migration approval arguments or operator acknowledgment and an approval window. None was invoked here. The native-schema migrations are incompatible with the historical PHP CRM database and must not target it.

This is not a universal read-only mode for every retained tool: explicit SQLite migration, demo initialization, integration and operator utilities are deliberately write-capable development tools when invoked with their prerequisites. They are not normal startup commands. Production activation remains blocked pending a legacy adapter, schema/authentication/permissions/ownership evidence, compatibility/concurrent-write acceptance and recovery planning. Authenticated CRM data workflows, private attachments/PDF marks and live Zoho synchronization remain unavailable. Linux deployment/TLS/backup/rollback acceptance is also outstanding.

## Exact source edits in the new copy

Only new-project paths were edited. Compared with the 785 copied source files:

- `package.json`: ordinary `dev` uses strict Hub orchestration; previous local commands have explicit `legacy:*` names.
- `tools/run-hub.mjs`, `tools/run-hub.test.mjs`: source development mode shares configuration, identity and port guards with production startup.
- `tools/prepare-hub-package.mjs`, `tools/audit-publication.mjs`, `tools/audit-publication.test.mjs`, `tools/publication-reviewed-fixtures.json`: exact source/doc admission and reviewed fixture hashes; no blanket private-content exemptions.
- `README.md`, `docs/backend-production-environment.md`, `docs/final-release-checklist.md`, `docs/legacy-production-compatibility.md`, `docs/manual-deployment-guide.md`, `docs/mysql-production-operator-guide.md`, `docs/runtime-excluded-assets.md`: current single-root setup, evidence, exclusions, deployment/rollback limitations and later Git commands.
- `server/.env.example`: comments clarify historical scope and point to retained documentation; variables/defaults unchanged.

New source files are `PROJECT-STRUCTURE.md`, `docs/project-audit.md`, `docs/clean-project-verification.md` and `tools/development-smoke.mjs`. The root `.env.example`, lockfile, application business source, tests outside the listed tool changes, private originals and all original Git changes were preserved.

Source publication checks combine the exact path allowlist, safe-template validation, generic credential/private-content rules, known historical credential matching and historical private-file byte matching. Results are recorded locally in `release/source-audit.json`. The known-credential comparison covers the historical Zoho controller's client-secret value(s), not every historical secret. Private-copy matching covers whole-file Git blob bytes from classified historical paths, not modified, partial or untracked private data. Generic checks have exact path/hash exceptions for reviewed synthetic fixtures. No scanner proves the absence of every unknown/transformed secret or independently establishes asset rights. Dependencies, build products and synthetic test outputs are outside the selected source scan. Excluded private inputs are never copied to satisfy tests. Review the exact staged file list/diff before any future publication. [README contains the later review, commit and separate-branch push commands](../README.md#review-and-publish-to-github-later). No Git initialization, staging, commit or push was performed by this task.
