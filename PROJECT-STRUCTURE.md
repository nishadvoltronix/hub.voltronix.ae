# Hub CRM project structure

This is the full source project at `G:\hub.voltronix.ae`, including development and test tooling. It is separate from the preserved original `G:\crm.voltronix.ae` and the earlier deployment-only copy. There is one root package and lockfile; `shared/contracts/package.json` describes a linked local contracts package, not another application or dependency installation.

```text
hub.voltronix.ae/
  src/                         Next.js pages, components and server-only bridge
  server/
    src/                       Express API, domain code and guarded adapters
    tests/                     API, authorization and compatibility tests
    scripts/                   Explicit inspection and integration tooling
    demo-sqlite/                Isolated reference implementation and tests
    assets/quotation-pdf/       Reviewed font files and notices only
    .env.example               Reference for older explicit backend tools
  shared/contracts/            Shared API types, package metadata and compiler config
  public/legacy/assets/        Reviewed CSS, icons and company UI images
  resources/quotation-pdf/     Reviewed fonts/notices used by compatibility code
  tests/                       Frontend/domain tests and synthetic reference fixtures
  scripts/                     Root validation, inspection and integration tools
  tools/                       Hub launchers, environment validation, audits and packagers
  deploy/ubuntu/               Hub service and Nginx templates
  docs/                        Environment, audit, verification, deployment and rollback
  .env.example                 The single normal Hub configuration template
  .gitignore                   Private/generated file exclusions
  package.json                 Root dependencies and commands
  package-lock.json            Root dependency lock
  next.config.ts               Next build/runtime configuration
  tsconfig*.json               Web, server, server build and reference-test configuration
  eslint.config.mjs            Lint configuration
  AGENTS.md                    Repository instructions for coding agents
  .editorconfig                Text formatting rules
  start-local.ps1              Retained explicit local tooling helper
  stop-local.ps1               Retained explicit local tooling helper
  start-sqlite-demo.ps1         Retained isolated demo helper; not normal setup
  README.md                    Setup and everyday commands
  PROJECT-STRUCTURE.md          This guide
```

The root `.env` is deliberately absent from the delivered source. Create it later from the reviewed `.env.example` or supply all supported settings explicitly to a process. Do not create an additional frontend/backend environment file. `config-templates/` was not copied: its older unused templates were not part of the current Hub startup and would duplicate inactive configuration choices.

## Startup flow

1. `npm run build` enters `tools/run-hub.mjs`. `tools/hub-environment.mjs` validates the ordinary root `.env`, if present, and explicit process settings. It rejects additional dotenv files, unsupported secrets and database activation.
2. Build runs the contracts compiler, the server compiler and Next build. Outputs are `shared/contracts/dist/`, `server/dist/` and `.next/`; these are generated locally, ignored by Git and excluded from source packages.
3. `npm start` verifies both loopback ports, starts the database-disabled Express API and checks `/api/v1/health/identity` before starting Next. The web bridge repeats that identity check before forwarding browser credentials.
4. Browsers reach Next; Next's server-side bridge reaches only the explicitly configured loopback Express origin. No production database adapter is composed. Readiness/authentication/data remain unavailable until a compatible persistence design exists.
5. `npm run dev` follows the same configuration and listener isolation, compiling contracts and using the Express TypeScript source plus Next development mode. Restart after API or contract edits.

Next uses `src/app/` and `src/proxy.ts`; Express starts through `server/src/server.ts`. `server/src/cli.ts` is an older explicitly configured runtime entrypoint; the normal Hub launcher bypasses native database composition. The single-root build does not use the original `backend/` or `nextjs/` directories.

## Why retained areas may look similar

`src/server/`, `server/src/crm/` and `tests/sqlite-reference/` have separate roles and active imports: server-side web code/compatibility, API business logic, and regression reference fixtures. Removing them solely for similar names would remove implementation or test evidence. The retained native database and Zoho source is not authorization to run it. Normal Hub launchers refuse its activation; explicit operator tools must remain gated and separate from build/start.

Fonts appear in both `resources/quotation-pdf/` and `server/assets/quotation-pdf/` because the two retained renderer implementations resolve different exact paths. Keep the font notices with them. Private company backgrounds, signatures, stamps, original attachments and provenance files were not copied; affected PDF and preservation tests may require unavailable private inputs. See [asset boundaries](docs/runtime-excluded-assets.md).

`node_modules/`, `.next/`, compiled `dist/`, `next-env.d.ts`, build metadata and any `release/` verification artifacts can appear after local checks. Verification can also create new synthetic test reports under ignored `.local-data/`; none were copied from the original project. These are generated outputs, not additional applications. Tests write fresh isolated synthetic SQLite fixtures. No original Git history, live environment, database, upload, session or private legacy snapshot is part of the clean source.

See [the top-level audit](docs/project-audit.md) for all original items and [the verification report](docs/clean-project-verification.md) for actual checks, unavailable inputs and limitations.
