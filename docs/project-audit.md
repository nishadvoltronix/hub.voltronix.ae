# Clean project audit

The clean project is `G:\hub.voltronix.ae`. The original `G:\crm.voltronix.ae` was inspected and preserved, including its uncommitted work. Source was selected from the verified latest Hub preparation archive under the original's `release/bills-production-prep-20261017` worktree, rather than copying old runtime data or Git history. That historical worktree name is not the new application name.

The initial copy contained 785 source files, excluding three historical reports from the 788-file source candidate. Subsequent changes are confined to the new sibling project; final file counts and checks are in [the verification report](clean-project-verification.md). No original files or directories were deleted to make this copy. Exclusion below means not copied, not deleted.

## All original top-level items

| Original item | Classification | Decision and reason |
| --- | --- | --- |
| `.git/` | Private/history | Preserve original history; do not copy or initialize Git in the new folder during this task. |
| `.local-data/` | Local/private data | Preserve original databases, state and private profiles; exclude. |
| `.local-dev/` | Local/private data | Preserve development evidence/data; exclude. |
| `.next/` | Generated | Rebuild inside the new project. |
| `.private-legacy/` | Private source/evidence | Preserve historical inputs; exclude from the new source. |
| `assets/` | Mixed historical/private assets | Preserve all 538 original files; exclude the historical tree. Runtime uses separately reviewed asset paths below. |
| `backend/` | Verified non-runtime residue | Contains an empty historical `.env`; no source/package entrypoint was found. Exclude without modifying it. |
| `config-templates/` | Older inactive templates | Three application/MySQL-local/Zoho-sandbox examples are not used by current Hub startup. Preserve original, omit duplicates. |
| `deploy/` | Required deployment templates | Keep the reviewed Hub unit and Nginx template only. No server configuration is applied. |
| `docs/` | Documentation, mixed history | Keep seven essential guides; add current structure/audit/verification docs. Omit the three superseded preparation/layout/rename reports. |
| `hub-deploy-20261017/` | Derived deployment copy | Preserve separately; do not nest an earlier deployment-only project in this development copy. |
| `nextjs/` | Historical/private residue | Contains historical environment files, `.htaccess` and local state, with no current source/package entrypoint. Preserve about 4,250 files in place; exclude. |
| `node_modules/` | Generated dependencies | Install independently from the root lockfile; do not copy. |
| `public/` | Required reviewed public assets | Copy 22 reviewed CSS/font/image files. Exclude internal manifest and original-upload-derived favicon. |
| `release/` | Derived packages/worktrees | Preserve original releases and worktrees. Do not copy nested releases or build outputs. New verification/package artifacts may be generated separately. |
| `resources/` | Mixed runtime/private assets | Of 11 original PDF-resource files, keep six reviewed fonts/notices only; exclude private marks and provenance. |
| `scripts/` | Required build/test/operator tooling | Retain referenced tools and their validation helpers. Explicit live or migration tools are not normal setup commands. |
| `server/` | Required backend/test/tooling source | Retain API source, tests, scripts, isolated reference code, safe template and reviewed fonts. Exclude local state, real environments and compiled output. |
| `shared/` | Required shared source/configuration | Retain contracts source, package metadata and compiler configuration; rebuild `dist/`. |
| `src/` | Required application source | Authoritative Next application and web bridge. |
| `tests/` | Required test tooling/source | Retain tests, helpers, synthetic fixtures and reference code; missing private evidence is a disclosed limitation. |
| `tools/` | Required tooling | Retain launchers, source/package auditors and tests. Historical audit metadata does not itself authorize publication. |
| `.editorconfig` | Build/development tooling | Retain formatting configuration. |
| `.env.example` | Required configuration template | Retain only safe Hub settings. Do not copy or manufacture a real environment file. |
| `.gitignore` | Required tooling/safety policy | Retain and review private/generated exclusions. Ignore rules supplement content review. |
| `AGENTS.md` | Required contributor instructions | Retain repository-specific agent guidance. |
| `eslint.config.mjs` | Required lint configuration | Retain; lint covers source and tests. |
| `license.txt` | Historical PHP license | Original CodeIgniter MIT notice does not license the new CRM. Preserve in the original; do not present it as the new application's license. |
| `next-env.d.ts` | Generated type support | Regenerate with Next; do not copy an old generated file. |
| `next.config.ts` | Required Next configuration | Retain single-root contracts, security headers and asset-tracing rules. |
| `package-lock.json` | Required dependency lock | One root lockfile; install independently and verify against the manifest. |
| `package.json` | Required package/commands | Retain full development/test commands and reviewed startup changes, not the deployment-only trimmed script set. |
| `README.md` | Required documentation | Replace in the new copy with current setup and later Git review instructions. |
| `start-local.ps1` | Retained explicit tooling | Keep source helper; normal startup uses the Hub launcher. |
| `start-sqlite-demo.ps1` | Retained reference tooling | Keep source helper; never auto-run or seed a demo during normal setup. |
| `stop-local.ps1` | Retained explicit tooling | Keep helper; do not run it against original processes as part of this task. |
| `tsconfig.demo.json` | Required test configuration | Retain for isolated reference/demo source and tests. |
| `tsconfig.json` | Required web/typecheck configuration | Retain Next source, tests, scripts and generated type includes. |
| `tsconfig.server.build.json` | Required API build configuration | Retain; extends the server configuration and emits `server/dist/`. |
| `tsconfig.server.json` | Required API/typecheck configuration | Retain for API, tests and script imports. |
| `tsconfig.tsbuildinfo` | Generated compiler cache | Rebuild locally; do not copy. |

## Dependency findings and retained limitations

Package commands and TypeScript configurations identify root `src/` and `server/src/` as the active frontend/backend. `next.config.ts` points the build root to this same project and links `shared/contracts`. The old `backend/` and `nextjs/` are not runtime source roots. There is no second server install or duplicate root lockfile.

Seven guides are retained because the source packagers require them: the manual deployment guide, final release checklist, backend environment guide, legacy compatibility analysis, asset boundary guide, native-schema operator reference and isolated staging reference. The deployment template test also reads the manual guide. The native-schema references have explicit scope warnings; their procedures must not target historical CRM data.

The prior `production-preparation-report.md`, `single-project-layout.md` and `hub-rename.md` were optional historical records in the package policy. They remain preserved in the old worktree; current links use this audit and the new verification report instead. No tests were omitted simply to shrink the project.

Some retained historical checks are not portable clean-project acceptance: the original boundary verifier expects missing `docs/express-api-contracts.md` and hard-coded route counts; the staging-doc parser expects four earlier staging documents; the old local-evidence verifier contains original-layout assumptions. Do not silently treat these as passed. The verification report records any corrections or remaining unavailable checks. Private source/attachment/PDF characterization remains dependent on inputs intentionally left outside this public project.

The PDF implementations `src/server/quotation-pdf/render.ts`, `server/src/crm/quotation-pdf/render.ts` and the test reference renderer require private quotation backgrounds/marks for affected output. Their source is retained; those private bytes are not. `tests/helpers/preserved-source.ts` and preservation scripts intentionally describe excluded original PHP/font evidence rather than silently reading the sibling project. Source-layout tests for attachments, departments, catalog, jobs, navigation, pipeline and work-log dates, the font/PDF suites, and `server/demo-sqlite/historical-harness-reproduction.test.ts` therefore have external-input prerequisites. Synthetic preservation-path and attachment-reconciliation tests do not need those originals. All original 186 test files were retained; new safety checks may increase the final count.

Application liveness and build completion do not prove database compatibility. The legacy adapter is unimplemented; keep database access and Zoho disabled. No existing database was connected, migrated, seeded or modified, and no production server was contacted by this cleanup.
