# Hub CRM

The clean development project is `G:\hub.voltronix.ae`. Next.js, Express, tests and deployment templates share one project root, one dependency installation and one normal configuration file. The original `G:\crm.voltronix.ae`, its Git history, private files and existing work remain in place. See [PROJECT-STRUCTURE.md](PROJECT-STRUCTURE.md), [the source audit](docs/project-audit.md), and [the verification report](docs/clean-project-verification.md) for the directory map, exclusions and actual check results.

```text
hub.voltronix.ae/
  package.json
  package-lock.json
  .env.example       safe template, tracked
  .env               private runtime configuration; ignored and never packaged
  src/               Next.js frontend
  server/            Express API source
  public/            approved UI assets
  shared/contracts/  shared types and API contracts
```

## Install and configure

Use Node.js **24.x**. Install independently inside the new folder:

```powershell
Set-Location -LiteralPath 'G:\hub.voltronix.ae'
node --version
npm ci --include=dev --ignore-scripts --no-audit --no-fund
```

Development dependencies are needed for TypeScript and tests. Skipping dependency lifecycle scripts prevents install-time setup; tests using `better-sqlite3` also need its platform-specific native binary. See the verification report for actual installation results. Do not copy another project's dependencies or Windows native binaries to Linux.

**No actual `.env` or credentials are supplied.** When you choose to configure this copy, review the safe root `.env.example` and create an ordinary root `.env` only if it is absent. Preserve any existing file; never overwrite it. PowerShell:

```powershell
node --input-type=module -e "import fs from 'node:fs'; fs.writeFileSync('.env', fs.readFileSync('.env.example'), {flag: 'wx', mode: 0o600})"
```

The same command works on Linux. Exclusive creation refuses an existing file or link without overwriting it; mode 0600 restricts permissions on systems that support Unix file modes. The [manual deployment guide](docs/manual-deployment-guide.md) explains production service file permissions and the app-local Node path. Do not create separate frontend/backend environment files or install dependencies inside `server/` or `shared/contracts/`.

The root template sets `APP_ORIGIN=https://hub.voltronix.ae`, web `127.0.0.1:3301` and API `127.0.0.1:3302`. These ports require availability checks; existing server ports 3001/3002 must not be reused. Keep `CRM_EXPRESS_ORIGIN` aligned with the selected API host/port. Explicit process settings override the root file; use a clean shell without unrelated CRM settings. Automated verification may supply all 14 safe settings to a child process without creating `.env`. Missing required configuration refuses startup.

The default configuration keeps **database access and Zoho synchronization disabled**. Login HTML, UI assets and liveness work; readiness, authentication and CRM data endpoints return unavailable. The launcher also supports an explicitly configured **existing native MySQL schema** through `CRM_DATABASE_MODE=mysql-native`; it verifies database readiness before starting either listener. This mode does not support the legacy PHP database and does not create tables or users. See the [environment guide](docs/backend-production-environment.md) for the required settings.

## Develop, test, build and start

[The environment guide](docs/backend-production-environment.md) documents the root `.env` settings, including the separate native Zoho outbound profile, user bindings and read-only inbound synchronization. Keep credentials private and never use `NEXT_PUBLIC_*` for them or commit the file. Preserve your existing `.env` when updating configuration. The retained `server/.env.example` describes older native-schema tooling; it is not a second environment file for this application. Legacy PHP database compatibility remains unavailable.

```powershell
npm run dev
```

Development uses the same explicit Hub configuration and ports, compiles shared contracts, starts the Express source API and starts Next development mode. Next refreshes frontend changes; restart after API/shared-contract edits. The configured HTTPS origin remains authoritative; a loopback preview is not production HTTPS acceptance. Ctrl+C stops the launcher's own services.

Run checks independently so a failed suite does not hide later results:

```sh
npm run typecheck
npm run lint
npm run test:server
npm run test:demo
npm run test:web
npm run test:tools
```

`npm test` also runs these suites in sequence. Tests use synthetic fixtures and temporary isolated test storage; they do not require the production database. Some historical suites require original comparison files and private PDF marks that are excluded from the source package. The required originals were restored locally on 2026-10-19 with matching hashes into ignored locations; no assertions were removed. See [private asset requirements](docs/runtime-excluded-assets.md) and [the current verification notes](docs/backend-production-environment.md#local-verification-2026-10-19). Build on the destination operating system.

Build, validate and start the selected mode from the same root:

```powershell
npm run build
npm run hub:check
npm start
```

Build compiles contracts, Express and Next and validates configuration without connecting to MySQL. Start validates configuration, both ports and the Hub API identity, then manages both services together. In native MySQL mode, both `hub:check` and startup also verify the selected server identity, schema and runtime grants through a read-only readiness probe. A failed probe prevents startup; no migration, seed or account creation runs automatically. Run `hub:check` while stopped because it checks that the ports are free. No separate install inside `server/` or `shared/contracts/` is needed. Older local helpers use `legacy:*` aliases; explicit migration, demo and integration tools are not normal setup commands.

The public `/api/health/ready` endpoint checks the API through the same identity-checked bridge as other requests. It returns 503 when database access is disabled or unavailable and 200 when the configured readiness probe passes. `/api/health/live` reports process liveness only.

The selected existing production database requires verification of its existing administrator and permissions. The [explicit first-administrator procedure](docs/backend-production-environment.md#create-the-first-native-administrator-explicitly) is retained only for a separately approved, newly provisioned empty native database. It is not a current deployment step, never runs automatically and cannot replace users in an existing database.

The root file may hold `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET` and `ZOHO_REFRESH_TOKEN` for the explicit `npm run hub:check:zoho -- --data-center=us` credential and metadata check. This checker uses the confirmed US data center and accepts explicit account, deal and stage mapping profiles described in the [environment guide](docs/backend-production-environment.md#zoho-credentials-and-metadata-check). The standalone checker requires `ZOHO_ENABLED=false`; it does not enable synchronization or import CRM records. A completed metadata report exits with code 2 to distinguish it from production acceptance. The enabled outbound runtime uses its separate pinned profile, actor bindings and startup preflight.

## Remaining production blockers

**Owner clarification, 2026-10-20:** Preserve the **existing production database** configured in the private root `.env`; the owner confirmed its identity belongs to `webserver01`. This supersedes the earlier new-empty-database plan preserved in dated records. Current work remains local and the owner will deploy manually. Read-only verification must establish the existing target's native schema, grants and administrator before activation. Missing or incompatible components require review, not automatic provisioning, bootstrap or migrations. The [legacy compatibility audit](docs/legacy-production-compatibility.md) explains why the native adapter cannot use a PHP CRM schema simply because table names match.

The native runtime and named Zoho outbound integration are implemented. All eleven final outbound live application checks passed through authenticated Express HTTP using an isolated native MySQL database and the real pinned Zoho organization, including stage changes, quotation create/edit, exact financial readback, PDF output and write replay protection. That outbound baseline passed 1,797 suite tests; detailed scope and retained test records are recorded in the environment guide. The separate read-only inbound path passed a complete live source scan, native application of 22,130 observations with zero conflicts, and a real incremental refresh. See the [current inbound verification](docs/backend-production-environment.md#inbound-synchronization-verification-2026-10-19) and [initial import instructions](docs/backend-production-environment.md#initial-zoho-import-and-ongoing-inbound-synchronization). Imported records are read-only in Hub; edits in the existing CRM/Zoho appear after a successful refresh. Historical attachments and PHP-only local data are excluded.

Earlier Windows probes found no listener on the saved loopback port 3306. A new local MySQL 8.4.11 engine now runs there with a different identity and has not been selected as Hub's database. `127.0.0.1` addresses the machine running Hub: the PC locally, or the production server after manual deployment. The saved production configuration has not been repointed. The host still needs verified native v5 schema/UUID/grants, existing administrator and sync principal, outbound user bindings, HTTPS and recovery acceptance. Private PDF backgrounds/signatures/stamps require separate private installation. Percentage-only quotation discounts remain unchanged. The source package excludes legacy PHP history, customer records, uploads, private environments and private assets; retained originals remain in the original workspace.

The owner's private root configuration selects native MySQL and `ZOHO_ENABLED=true`, preserving the previous assignments. Automatic inbound polling remains disabled and `ZOHO_SYNC_PRINCIPAL_ID` is absent: the actual existing target administrator must be verified before that local ID is supplied or polling is enabled. Follow the [guarded check → one run → review → enable sequence](docs/backend-production-environment.md#guarded-manual-activation-on-the-existing-target); preserve existing checkpoints and use no guessed account ID. Offline validation does not establish connectivity to the production database. The packaged `.env.example` deliberately retains disabled defaults and contains no actual credentials or deployment identity.

The [deployment checklist](docs/final-release-checklist.md) and [manual deployment/rollback guide](docs/manual-deployment-guide.md) are future operator instructions only. They preserve existing applications and use a new isolated Hub release, app-local Node and one service. Host paths, ports, DNS and TLS must be verified. No deployment or GitHub push has been performed. Current workflow checks distinguish isolated SQLite/native MySQL fixtures from the configured database and separate Zoho metadata inspection from explicitly authorized integration tests; see the [dated verification notes](docs/backend-production-environment.md#local-verification-2026-10-19).

## Review source identity before any publication

The local audit on 20 October 2026 found an existing `.git` directory with an unborn `review/connect-local-20261017` branch, an empty index and no configured remote. Recoverable prior commits and Codex checkpoint refs still exist. Preserve that entire directory; do not initialize again, reset, clean, prune or attach the old history to the current source automatically. A remote commit does not identify the current release.

The source package verifier compares every allowlisted file and reconstructs the deterministic ZIP byte-for-byte. Keep the verified ZIP, its checksum and its `FILE-MANIFEST.json` as the source snapshot. A commit relationship must be established separately; the ZIP verifier does not certify a commit or production acceptance.

The proposed local commit procedure requires explicit approval:

1. Make a new private copy of the existing `.git` directory under ignored local evidence, preserving all existing refs, objects and files.
2. Reverify the selected source ZIP and generate a NUL-delimited path list from its manifest. Confirm that the list contains only the reviewed source files.
3. Stage only that list with `git -c core.autocrlf=false add --pathspec-from-file=<private-path-list> --pathspec-file-nul`. The machine currently has `core.autocrlf=true`; automatic line-ending conversion would change the source bytes. Do not stage the whole working tree.
4. Review staged filenames and run the source/credential checks without printing secret values. Require `git write-tree` to match the independently calculated tree for the selected manifest before committing.
5. Create a new root commit on the current branch with the approved author identity. Record its commit/tree IDs, ZIP SHA-256 and manifest SHA-256 in a new ignored release receipt; verify each committed blob against the manifest.

No staging, commit, remote configuration or push was performed during this audit. Any later publication to `https://github.com/nishadvoltronix/hub.voltronix.ae` needs separate approval and history review. Real environments, private quotation images, records, databases, uploads and generated evidence remain excluded.
