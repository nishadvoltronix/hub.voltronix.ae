    # One root environment for Hub CRM

Next.js and Express use one project root and one ignored `.env` file. The launcher reads it for `npm run dev`, `npm run build`, `npm run hub:check` and `npm start`. The default is database-disabled. An explicit `mysql-native` mode connects the existing native CRM runtime after its identity, schema and privilege checks pass. The named Zoho outbound profile and read-only inbound synchronization described below are separate selections. A legacy PHP database adapter is not implemented.

These are local preparation instructions for manual deployment, not a deployment receipt. No live database acceptance, Linux host acceptance or public cutover is established by the commands below.

**Superseding owner clarification, 2026-10-20:** The database identity in the private root `.env` belongs to the existing production instance on `webserver01`. Preserve the file and existing database. The new local MySQL 8.4.11 engine is a different instance and is not selected as Hub's database. All work in this preparation run remains local; no production connection or schema/account change has been performed.

The secure offline configuration check confirmed that the owner-supplied identity matches the saved UUID, without verifying the remote server. Outbound `ZOHO_ENABLED=true` is selected, while `ZOHO_SYNC_ENABLED=false` and `ZOHO_SYNC_PRINCIPAL_ID` is absent. The missing verified existing-administrator ID is a concrete polling activation blocker; an interval is already configured. Preserve the recorded provider preflight and existing workflow evidence; do not invent a principal or change the local `.env` to bypass this requirement.

`127.0.0.1` means the host running the process. The same `127.0.0.1:3306` setting addresses the Windows PC when Hub runs locally and the server's MySQL listener when Hub runs on `webserver01`; it never establishes a remote connection or tunnel by itself. Earlier local connection refusals do not show that the existing production database is absent. On the host, use read-only identity/schema/grant/account verification first and stop for review if the selected database is missing or incompatible. The fresh-database and bootstrap procedures below are retained only for a separately approved fresh target.

## File location and permissions

Use the root `.env` beside `package.json`. Preserve an existing file; create one from `.env.example` only when it is absent. `.env.example` is tracked; the real `.env` is ignored and excluded from packages. Do not create `server/.env`, `.env.local` or other dotenv overrides for this launcher. The retained `server/.env.example` documents older explicit tools, not a second configuration source.

An absent `.env` is allowed when the process supplies all required settings. Explicit process values take precedence over the file, so use a clean process environment without unrelated CRM or debug settings. Values are single-line literals with no interpolation; quote values containing `#` or spaces. Never print the file or put credentials in `NEXT_PUBLIC_*` settings, source code or shell command arguments.

For local Linux use, keep the file owned by the build user with mode 0600. For the Ubuntu service, use an ordinary release-local file owned by `root:hub-crm` with mode 0640. Linked files and extra dotenv sources are refused. The service reads this file through the launcher; systemd does not load an `EnvironmentFile`. See the [manual deployment guide](manual-deployment-guide.md) for the host layout.

## Common settings

| Setting | Value / requirement |
| --- | --- |
| `NODE_ENV` | `production`; the launcher selects Next development mode for `npm run dev` |
| `APP_ORIGIN` | Canonical public HTTPS origin, for example `https://hub.voltronix.ae`, with no port, path or trailing slash |
| `CRM_API_INSTANCE_ID` | An explicit lowercase instance slug, for example `hub-crm` |
| `NEXT_TELEMETRY_DISABLED` | `1` |
| `CRM_FRONTEND_BACKEND` | `express` |
| `CRM_WEB_HOST` | `127.0.0.1` or `::1` |
| `CRM_WEB_PORT` | Explicit unused port from 1024 to 65535; template uses `3301` |
| `CRM_API_ENVIRONMENT` | `production` |
| `CRM_API_HOST` | `127.0.0.1` or `::1` |
| `CRM_API_PORT` | Explicit unused port different from the web port; template uses `3302` |
| `CRM_EXPRESS_ORIGIN` | Loopback HTTP origin matching API host and port exactly, for example `http://127.0.0.1:3302`; no `/api/v1` suffix |
| `ZOHO_ENABLED` | `false` by default; `true` requires the complete native outbound profile below |
| `ZOHO_SYNC_ENABLED` | Absent/`false` by default; `true` selects the separate inbound poller with the explicit administrator and interval below |

The template ports are examples. Prior host notes identify 3001/3002 as occupied; verify actual listeners on the intended server before choosing ports. Update the dedicated Nginx upstream when changing the web port. Do not stop unrelated services to free a port. The configured HTTPS origin controls secure cookies and CSRF checks; a local HTTP preview does not prove production sign-in works.

## Database mode

Keep the default mode for a UI/liveness preview or while the database's compatibility is unknown:

```dotenv
CRM_DATABASE_MODE=disabled
CRM_MYSQL_NETWORK_DISABLED=1
```

This mode does not connect to MySQL. Native runtime fields must remain inactive or commented. Authentication and data operations remain unavailable; no demo database or direct Next database fallback is selected.

For an **already provisioned native CRM database**, select:

```dotenv
CRM_DATABASE_MODE=mysql-native
CRM_MYSQL_NETWORK_DISABLED=0
CRM_RUNTIME_ENABLE=approved-production-mysql-crm-runtime
CRM_RUNTIME_SOURCE=environment
```

All of the following fields are required in native mode. Values must describe the actual target and its provisioning; the approval fields are records of that work, not a replacement for it.

| Setting | Requirement |
| --- | --- |
| `CRM_MYSQL_HOST` | `127.0.0.1`; production MySQL is co-located TCP only |
| `CRM_MYSQL_PORT` | Keep the selected production target at `3306`; the runtime also supports `3308` for separately approved fixtures, which are not selected here |
| `CRM_MYSQL_DATABASE` | The existing native schema name; lowercase letters, digits and underscores, beginning with a letter |
| `CRM_MYSQL_USER` | Dedicated runtime identity with the native table privilege contract; not `root` or a MySQL system account |
| `CRM_MYSQL_PASSWORD` | That account's real password |
| `CRM_MYSQL_SERVER_UUID` | Verified server UUID; the runtime checks the connected server against it |
| `CRM_MYSQL_APPROVED` | `true` after the target and use have been reviewed |
| `CRM_MYSQL_APPROVAL_REFERENCE` | Actual target/use review reference |
| `CRM_MYSQL_PROVISIONING_REFERENCE` | Actual native schema/user provisioning reference |
| `CRM_MYSQL_ISSUER_COMPANY` | `VOLTRONIX CONTRACTING LLC` or `VOLTRONIX SWITCHGEAR LLC` |
| `CRM_MYSQL_ISSUER_SALESPERSON` | Approved display name used in quotations |

Private JSON profiles and `CRM_RUNTIME_PROFILE` are not selected by this root workflow. The native runtime retains its server identity, exact migration/schema and privilege validation. No startup command creates schemas, changes grants, migrates, seeds or creates a default login. Only explicitly enabled inbound polling imports provider records after the API starts. Missing values, an unreachable server or incompatible schema prevent native startup.

Do not point this mode at the existing PHP CRM database or run native migrations against it. Shared table names do not make the schemas compatible. Historical authentication, permissions, quotations, attachments and concurrent-write mappings remain unresolved; see the [legacy compatibility audit](legacy-production-compatibility.md). Preparing native settings locally does not verify the target; its readiness and workflow acceptance must pass before real users rely on it.

For the selected existing production database, the operator must compare the connected server UUID to the private configured value, confirm MySQL 8.4.11 and the native v1–v5 schema/grant contract, and inspect the existing active administrator and intended permissions without changing records. `hub:check` performs runtime dependency reads, but does not establish administrator access or complete workflow acceptance. Keep inbound polling disabled during these checks. If the existing schema is a PHP schema, incomplete native schema or a different server identity, stop and review compatibility; do not initialize a new database, run migrations, alter grants or bootstrap a replacement account to make the check pass.

### Create the first native administrator explicitly

**Separate fresh-target procedure only; not part of the current existing-production-database deployment.** An already provisioned, completely empty native database can receive its first administrator after explicit approval through a separate operator command. Normal build/start never runs it. Do not run this procedure on the selected existing database or use it for account recovery. For a separately approved fresh target, configure that target above, then privately create `server/.local-data/operators/native-admin-bootstrap.json` with this shape:

```json
{
  "version": 1,
  "requestId": "<new-request-UUID>",
  "reference": "<operator-review-reference>",
  "target": {
    "database": "<configured-native-database>",
    "serverUuid": "<verified-server-UUID>"
  },
  "administrator": {
    "name": "<administrator-name>",
    "email": "<administrator-email>",
    "password": "<private-strong-password>"
  }
}
```

Replace placeholders privately. Use canonical JSON with two-space indentation, no comments, duplicate keys or extra fields. The password must contain at least 12 characters and fit within 72 UTF-8 bytes. The request target must match the configured database and server UUID exactly. The request and both private parent directories require owner-only access: on Linux use private directories with mode 0700 and a regular request file with mode 0600; on Windows use an owner-only ACL. Links and hard links are refused. This ignored request contains a real password and must stay outside the source package and chat.

Run these commands from the project root using Node 24:

```sh
node tools/bootstrap-native-admin.mjs check
node tools/bootstrap-native-admin.mjs apply
```

On the Ubuntu host, use the verified app-local Node 24 from the manual deployment guide, from the canonical operator release root. Do not rely on a global Node installation. The equivalent commands are:

```sh
node_bin=/var/www/hub.voltronix_ae/runtime/node/bin/node
env -i HOME="$HOME" PATH="$(dirname "$node_bin"):/usr/bin:/bin" \
  "$node_bin" tools/bootstrap-native-admin.mjs check
env -i HOME="$HOME" PATH="$(dirname "$node_bin"):/usr/bin:/bin" \
  "$node_bin" tools/bootstrap-native-admin.mjs apply
```

Keep the reviewed root `.env` and protected request in that operator copy. These commands load its root configuration; they do not use inherited application credentials. The operator tools require the reviewed `tsx` development dependency installed in this private setup copy.

`check` verifies the native target and empty application tables with SELECTs only. `apply` takes the application transaction lock, checks emptiness again and atomically creates one active user, one permission group, all 21 canonical permissions, 20 administrator grants and an audit event. The restrictive `leads.manage.agents` grant is intentionally omitted. Passwords are hashed; there is no default password or imported external identity. No command creates tables, changes MySQL grants, migrates the PHP database or enables Zoho.

An attempt receipt is written before database work. Reusing its request ID is refused, including after a failure or an uncertain result. Review the retained receipts and actual database state before any further action; do not delete a receipt or choose a new ID simply to retry. After successful creation, verify normal login and authorization, then handle the password-bearing request under the operator's credential-retention procedure. The utility refuses a database containing any existing application rows; it is not an account recovery or existing-user replacement tool.

## Zoho credentials and metadata check

The root file may contain these three inactive integration credentials:

```dotenv
ZOHO_ENABLED=false
ZOHO_CLIENT_ID=<your-client-id>
ZOHO_CLIENT_SECRET=<your-client-secret>
ZOHO_REFRESH_TOKEN=<your-refresh-token>
```

Use actual private values rather than the placeholders. Storing them does not start an integration. The launcher excludes their values from the Next child environment; the shared root file still needs filesystem protection.

The checker requires the confirmed **US** data center explicitly:

```sh
npm run hub:check:zoho -- --data-center=us
```

Only the US data center is supported by this wrapper. It reads the three credentials from the root file without using ambient credential overrides. `ZOHO_ENABLED=false` is required. Process debug/network-disable vetoes still apply. Missing credentials refuse the check; it does not open a consent flow or create a refresh token.

To inspect the explicitly selected mappings used during local verification:

```sh
npm run hub:check:zoho -- --data-center=us --account-profile=standard-account-contact-email-v1 --deal-profile=legacy-conversion-fields-v1 --stage-profile=voltronix-stage-labels-v1
```

These flags change metadata expectations only. They do not select runtime mappings or enable synchronization. Without them, the checker retains its legacy default expectations. `--help` lists accepted profiles; arbitrary endpoints, credentials and duplicate flags are refused.

The checker performs one OAuth refresh, a production organization probe and field-metadata reads for Accounts, Contacts, Deals, Products and Quotes. It does not import business records, write CRM records, persist an access token, replace the saved grant, or enable schedules/webhooks/synchronization.

Exit code **2** means the metadata report was produced; it deliberately does not claim production acceptance. Exit code **1** means refusal/failure; `--help` exits **0**. Organization ownership is not pinned to an operator-approved ID by this checker. Successful metadata reads do not establish accepted field mappings, write ownership, reconciliation or runtime readiness. Keep `ZOHO_ENABLED=false` after a completed check.

### Explicit native outbound profile

The normal launcher can select the fixed `voltronix-native-outbound-v1` profile with an already provisioned native database. This is an outbound workflow integration: it does not import existing Zoho records or create a background synchronization schedule. Leave the actual activation flag false until database, user binding and end-to-end workflow verification have passed.

Keep the three private credentials above and add these independently confirmed values:

```dotenv
ZOHO_ORGANIZATION_ID=<confirmed-production-organization-id>
ZOHO_ACCOUNT_OWNER_ID=<confirmed-current-Zoho-user-id>
ZOHO_PROFILE=voltronix-native-outbound-v1
ZOHO_DEAL_PIPELINE="Standard (Standard)"
ZOHO_AUTOMATION_POLICY=suppressed
```

The pipeline is an explicit selected label, not a default inferred from metadata. `Standard (Standard)` is the observed label for the current account; another deployment must verify its actual label. This named profile pins the account/contact email mapping, Voltronix department/PO-box and stage labels, v8 `Quoted_Items`, VAT at 5%, and native reference-number rules. Startup requires the sole active visible Standard layout, matches its Stage option IDs and exact internal/reference/display labels against both module metadata and the selected default pipeline, and binds its verified layout ID to Deal writes and readback. The production stage mapping uses `voltronix-stage-reference-values-v1`: Site Visit is sent as `Site Visit`, although its internal metadata value is `Needs Analysis`. A module-wide picklist match alone is insufficient.

The selected Deal layout requires Deal name, Account, Expected Closing Date, Pipeline, Stage and Department. The preflight verifies each layout field's `required` flag as well as system-mandatory metadata and refuses any additional unsupported requirement before granting write authority. Remote Deal creation requires the user's explicit valid date; it is sent as `Closing_Date` and verified on readback. No date is inferred from the current day or other unrelated data.

`DEAL-` and `QUOTE-` references derive from verified provider autonumbers. New `HUB-SITE-`, `HUB-JOB-` and `HUB-LOST-` references stay **only in Hub's database**: the historical application's counter scans nonempty remote references, so these Hub references must never be written into its stage-number fields. Existing remote stage references are preserved and verified unchanged. Owner and organization IDs must come from an independent account review. Startup checks the production organization, current active owner, exact required metadata and field capacities, picklists, quotation precision and tax settings before exposing write transports. It never chooses another profile or falls back to local creation after remote activation fails.

Activation additionally requires protected, verified mappings from each local actor to the correct active `VZ_app_users` record in the pinned organization. An email resemblance or a copied external ID is insufficient. Creating the first local administrator does not establish this binding. The separate binding operator verifies the exact remote record and persists the association with a native audit event; missing bindings refuse outbound writes.

First inspect existing bindings. Preserve a valid binding; do not reapply it. Only if a binding is missing and the proposed identity and local-account change have been reviewed, prepare `server/.local-data/operators/zoho-user-binding.json` with canonical JSON and owner-only file/directory protections:

```json
{
  "version": 1,
  "requestId": "<new-request-UUID>",
  "reference": "<operator-review-reference>",
  "target": {
    "database": "<configured-native-database>",
    "serverUuid": "<verified-server-UUID>",
    "organizationId": "<independently-confirmed-production-organization-id>"
  },
  "actorUserId": "<authorized-local-operator-id>",
  "localUserId": "<local-user-to-bind>",
  "externalUserId": "<verified-VZ_app_users-record-id>",
  "expectedVersion": 1
}
```

Use the existing target user's actual current `users.version`; never assume version 1 from historical bootstrap examples. The operator must be active and hold both `users.write` and `permissions.manage`. The target user must be active, and its email must match the exact active custom record verified in the pinned organization. Run `node tools/bind-zoho-user.mjs check` first; review its result and the local account effect before separately approving `node tools/bind-zoho-user.mjs apply`. Both work while `ZOHO_ENABLED=false`; the provider session is always read-only. `apply` records the immutable binding and audit, increments the target user's version and revokes that user's sessions, requiring sign-in again. It never creates or edits a Zoho user. Existing attempts, existing bindings, conflicting identities and stale versions require manual review; do not retry with a new request ID to evade a refusal.

On Ubuntu, use the same verified app-local Node and dedicated operator copy as first-administrator setup:

```sh
env -i HOME="$HOME" PATH="$(dirname "$node_bin"):/usr/bin:/bin" \
  "$node_bin" tools/bind-zoho-user.mjs check
env -i HOME="$HOME" PATH="$(dirname "$node_bin"):/usr/bin:/bin" \
  "$node_bin" tools/bind-zoho-user.mjs apply
```

After this explicit preparation and acceptance, replace the single `ZOHO_ENABLED=false` assignment with `ZOHO_ENABLED=true`; do not add a duplicate assignment. An optional `ZOHO_NETWORK_DISABLED=1` veto prevents selected integration startup. `build` validates the configuration offline. Normal `check`/`start` open a read-only preflight before listeners and include the selected integration in dependency readiness. Failure prevents startup; shutdown closes the owned database and integration sessions. Pure database constructors used by bootstrap and migration commands do not open Zoho sessions.

Every production write requests an empty trigger list and cadence skipping. The integration does not call email endpoints. Provider-side behavior still requires acceptance in the actual account. The Next child receives blank database/Zoho configuration values and `ZOHO_ENABLED=false`; these values and the OAuth session stay in the backend process. This process separation does not prevent a trusted server administrator from reading the root environment file.

Quotation attention and internal notes are retained in native storage; they are not invented as remote fields. The quotation issuer comes from the approved native runtime settings, not the customer's department. Private PDF marks still require separate installation. Explicitly local workflows retain their local identity; selecting remote creation requires the verified remote receipt before the UI reports success.

### Initial Zoho import and ongoing inbound synchronization

This separate, read-only provider connection imports existing Products, Deals, Deal Notes, historical Quotes and the `VZ_app_users` directory from the pinned production organization into the native Hub database. Later passes refresh changed records and process explicit provider deletion records for Products, Deals, Quotes and directory entries. It makes no Zoho business-record writes. `ZOHO_ENABLED` controls outbound workflows independently; importing the directory does not create login accounts, permissions or verified outbound actor bindings.

Settings → Users shows the saved Zoho directory to administrators holding both `users.write` and `permissions.manage`. The paginated directory contains source identity/status, synchronization times and the exact linked local account, if any. A link is verified only while the source and local accounts are active and their external identity and source/binding/local emails agree. A stale or conflicting link is marked for review; similar names or email addresses never create an account or binding. The existing binding operator remains the way to establish that association.

Managers can search and filter imported pipeline records by the source custom-user assignment even when that salesperson has no local login. This display/filter fallback grants no access: a salesperson's own pipeline and sales dashboard still require the verified `tasks.assigned_to` mapping. A normal inbound pass re-evaluates saved Deal assignments after a binding is added, without resetting the checkpoint or requiring a newer Deal timestamp. These reads cover imported Deals; assignments to an unconverted Zoho Lead are outside this importer.

First verify the selected existing native v5 schema and runtime grants without changing them. Inspect the existing active local administrator through an authorized account inspection and use its actual local `users.id` for `ZOHO_SYNC_PRINCIPAL_ID`. Never guess an ID, use the MySQL login name or copy a provider user ID. The selected administrator must remain active and hold both `users.write` and `permissions.manage`; the store rechecks these permissions when acquiring, renewing and applying a sync pass. Missing schema, grants or administrator access requires review before any corrective database change. Only for a separately approved fresh target may the bootstrap receipt (`status: "ADMINISTRATOR_CREATED"` and `userId`) supply this ID; it is not a current setup prerequisite.

Keep the three private OAuth credentials and verified `ZOHO_ORGANIZATION_ID`. Add one assignment for each setting, preserving any previous values as comments:

```dotenv
ZOHO_SYNC_ENABLED=false
ZOHO_SYNC_INTERVAL_SECONDS=300
ZOHO_SYNC_PRINCIPAL_ID=<actual-authorized-local-administrator-id>
```

The interval must be 60–86400 seconds. It is the delay after a pass finishes, not a promise that data is always that recent. The principal ID is a positive decimal local ID. These settings must be complete for the manual tool even while automatic polling is disabled. An ambient or root `ZOHO_NETWORK_DISABLED=1` veto is respected. The tool has two separate commands: `node tools/sync-zoho.mjs check` and `node tools/sync-zoho.mjs run`. They use the private root environment and do not accept credentials on the command line. Do not run them together as an unattended setup sequence.

#### Guarded manual activation on the existing target

These are future operator steps on the confirmed deployment host, not commands to run against the Windows engine. Do not connect to the host from the current local preparation task. Use a protected matching operator copy with the reviewed root `.env`, installed `tsx` dependency and verified app-local Node 24. Keep `ZOHO_SYNC_ENABLED=false`; verify that no existing Hub poller owns an active lease. Preserve the current checkpoint, sync receipts and application data.

1. **Check using reads only.** After the existing database identity, schema, grants and actual administrator ID have been verified, run from that operator project's root:

```sh
node_bin=/var/www/hub.voltronix_ae/runtime/node/bin/node
env -i HOME="$HOME" PATH="$(dirname "$node_bin"):/usr/bin:/bin" \
  "$node_bin" tools/sync-zoho.mjs check
```

Require exit 0 and `status: "CHECKED_READ_ONLY"`. Review the returned state, generation, checkpoint availability, last success, counts, error code and `leaseActive`. This status only means the dependency/status reads passed: a failed/partial state, retained conflicts, unexpected target/principal or active lease is a stop for review. Do not infer that an import has succeeded.

2. **Approve and perform one bounded import.** This step writes projections and sync state into the existing Hub database while making no Zoho business-record writes. Review that effect and the backup/recovery evidence before executing the separate command:

```sh
env -i HOME="$HOME" PATH="$(dirname "$node_bin"):/usr/bin:/bin" \
  "$node_bin" tools/sync-zoho.mjs run
```

Without a durable checkpoint this reads the complete supported record set; with an existing checkpoint it performs an incremental pass with a five-minute overlap. Do not reset the checkpoint to force a fresh import. Require exit 0, `status: "completed"` and reviewed counts with no unresolved conflicts. Exit **2** means partial results/conflicts or another live lease; exit **1** means refusal/failure. Stop on either; retain evidence and do not automatically retry or delete leases, journals, provenance or checkpoints.

Deal Notes are reconciled from the complete bounded Notes collection on every pass. Zoho Lead conversion can attach an old note to a newly visible Deal without changing the note's `Modified_Time`, so filtering Notes by the checkpoint can permanently miss that history. Other modules retain their incremental time filter. Notes pagination, request, row and byte limits still apply, and a partial or failed read never advances the checkpoint. This adds a paginated Notes read and local identity/merge comparisons each pass. Existing notes and their parent tasks are fetched in batches of at most 200 bound IDs inside the existing transaction after Deal reconciliation, avoiding two database round trips per note while retaining the application lock and every conflict check. A note observed under a different Deal remains a conflict attached to its actual local parent; it is never moved automatically. An unchanged active note with exactly matching source, projection and local parent is counted in the run receipt without a duplicate per-note event or provenance update; its `lastSyncedAt` remains the last material reconciliation time. The run's last-success time and receipt describe the latest complete observation. Source changes, local conflicts and pending outbound operations continue through the normal audited reconciliation.

3. **Review the completed pass and application views.** Run the same `check` command again. Confirm the stored state is `ready`, the expected generation/checkpoint and last-success time advanced, no lease remains active and no retained conflicts are reported. Verify authorized Hub views and counts, imported-record read-only behavior, source assignment visibility and denied access for unauthorized users. Login/logout and permission checks require a valid existing application account. A command's zero exit code alone does not accept these workflows.

4. **Enable polling only after that review.** In the protected host root `.env`, change the single `ZOHO_SYNC_ENABLED=false` assignment to `true`, retaining the verified principal and interval. This is a future operator configuration change; the local saved `.env` remains unchanged. After approval of the service change, restart only the verified Hub service using its actual unit name (the proposed unit is `hub-crm.service`), then check its health/identity and persisted sync status after the first pass:

```sh
sudo systemctl restart hub-crm.service
sudo systemctl status hub-crm.service --no-pager
env -i HOME="$HOME" PATH="$(dirname "$node_bin"):/usr/bin:/bin" \
  "$node_bin" tools/sync-zoho.mjs check
```

Confirm a successful scheduled pass advances the stored generation/last-success time; merely seeing an active service or readiness 200 does not prove polling ran. If polling needs to be stopped, restore `ZOHO_SYNC_ENABLED=false` and restart only Hub under the same service approval, retaining all imported data and checkpoints.

The equivalent manual package commands are `npm run hub:sync:zoho -- check` and `npm run hub:sync:zoho -- run`. Outbound `ZOHO_ENABLED` is independent: verified actor bindings and its existing workflow acceptance still apply.

Normal `start`/`dev`/`api` with polling enabled validates the administrator and source before listening, then starts its first pass after the HTTP listener succeeds. Builds, readiness checks, first-administrator setup and migrations never start the poller. One process schedules serial passes; a durable database lease also prevents overlap with another process or the manual tool. Shutdown cancels provider reads and drains the pass before closing MySQL. The Next child receives `ZOHO_SYNC_ENABLED=false` and blank interval/principal values.

Freshness is separate from dependency readiness. A later provider failure keeps already imported data accessible, while stored state reports the last success, failed/partial status and counts. Newly imported source records are read-only in Hub: edit them through the existing CRM/Zoho workflow and allow the next successful pass to refresh Hub. Existing native outbound records retain their write workflow unless a source conflict or deletion blocks it. Conflicts are retained for review rather than overwritten automatically. Polling is not an atomic provider snapshot, and there is no public webhook endpoint.

Notes from other modules, historical attachments and PHP-only work logs, files, receipts and local accounts are excluded. Notes deletion coverage is unavailable. Other deletion feeds cover at most 60 days, so an older checkpoint is refused rather than silently claimed current. Historical quotations show their recorded source amounts without inventing currency, tax calculations or a native PDF; they are not editable native quotations. The directory import never grants application access or establishes an outbound actor binding.

When imported Deals are present, the global dashboard identifies the imported and Hub-native populations. Won totals and the pipeline cover the visible records in Hub, which may differ from the old PHP CRM's local task set even when both use Zoho. The pipeline includes an “Other / unmapped stages” bucket so its chart and percentages use the same population. Combined pending-assignment, payment and completion totals are unavailable until legacy operational history is imported; the API returns `null` and the dashboard displays “Not imported”. Verified Hub-native subtotals remain separate, and employee workloads are labeled as local records. Zoho synchronization alone does not establish parity with the old CRM dashboard; reconciliation requires its task IDs, assignment/payment history and employee mappings.

The initial pass has a fifteen-minute deadline; incremental passes have five minutes. A 120-second database lease is renewed every 30 seconds during provider reads. Atomic apply first validates that lease, then extends it for at most 300 seconds inside the same application transaction and rechecks ownership/expiry before commit; the original pass deadline and cancellation still apply. No provider HTTP or heartbeat runs inside that transaction. Fixed resource bounds are 20,000 each of Products, Deals and Notes, 5,000 Quotes, 2,000 directory entries, 20,000 tombstones, 6,500 requests and 64 MiB of provider responses. A page/record/size limit or incomplete quotation subform refuses the pass without advancing the checkpoint. Repeating the same bounded scan does not solve an oversized initial import; investigate the reported limit and implement a separately reviewed staged import before claiming complete coverage.

Counts describe the current pass. Global state remains partial while any retained source conflicts exist, including after an otherwise empty refresh; a successful later read does not itself reconcile an earlier conflict.

Verified local bindings determine assignment access. A later binding or directory revocation re-evaluates saved source Deals even when those Deals have not changed remotely. A deleted or conflicting verified directory identity removes assignment-based access while preserving the local login and its explicit grants. Imported directory names are display information, never authorization. Inactive or deleted source Products are not offered as current quotation items. The original source creation timestamp remains pinned across repeated conflicting identity observations.

Quotation details use at most four concurrent exact-record GETs, with results restored to source order. Transient GET failures have at most two additional attempts after 500 ms and 1,000 ms; attempts count against the same request budget and cancellation interrupts the delay. This bounded read retry does not change the outbound mutation/journal retry policy.

## Build, validation and startup

Run from the project root:

```sh
npm run build
npm run hub:check
npm start
```

`build` compiles contracts, Express and Next, and validates the selected configuration without opening database or Zoho connections. It does not need a running API. `hub:check` verifies configuration, build outputs and both free loopback ports. In native mode it opens and closes the selected dependencies for read-only startup and readiness checks. Run it while the app is stopped.

`start` and `dev` require native readiness before opening application listeners when `mysql-native` is selected. Startup then verifies the API identity before starting Next. `dev` compiles contracts and uses API source/Next development mode; restart it after API or shared-contract changes. Shutdown closes the owned API/database resources. A bind conflict stops startup without terminating the existing listener.

The split `hub:check:api` also checks native database readiness; `hub:check:web` checks the web configuration/output/listener and, in native mode, the selected API identity and readiness. Starting only the web service in native mode also requires the existing API to pass both probes. Use the combined `hub:check` for a stopped complete application. Normal build/start never invokes the older `legacy:*`, migration or demo tools.

The browser bridge verifies `/api/v1/health/identity` before forwarding requests or credentials. This detects accidental cross-service routing; the public identity is not cryptographic authentication against a hostile local process.

| Probe / operation | Disabled mode | Ready native mode |
| --- | --- | --- |
| API `/api/v1/health/live` | 200 | 200 |
| API `/api/v1/health/identity` | 200, matching instance/origin | 200, matching instance/origin |
| API `/api/v1/health/ready` | 503 | 200 while dependencies pass |
| Web `/api/health/ready` | 503 | Same readiness through the identity-checked bridge |
| Web `/api/health/live`, `/login` | 200 while services are available | 200 while services are available |
| Login, sessions and CRM data | Unavailable | Require valid existing users, grants and feature acceptance |
| Zoho outbound workflows | Unavailable | Require explicit verified profile and actor bindings |

Readiness reports only dependency health. Before manual production deployment, verify actual login/logout and authorization, CRM workflows, protected attachments, quotation assets/PDFs, backups and recovery, the Linux host and HTTPS. Company backgrounds/signatures/stamps were restored locally from the preserved originals, but are excluded from the source package and must be [installed privately on the target](manual-deployment-guide.md#private-quotation-assets). No `.env` value resolves those acceptance gaps; see the [release checklist](final-release-checklist.md).

## Local verification, 2026-10-19

**Historical configuration observation, 2026-10-19:** `mysql-native` and `ZOHO_ENABLED=true` were selected after the final live application checks passed. The previous environment assignments were preserved as active settings or comments, with a private backup; database settings and the fresh Hub credentials were not replaced. The enabled configuration passed offline validation. The saved endpoint at `127.0.0.1:3306` was unreachable from Windows at that time and was not repointed. The source package contained the safe disabled example only; the real `.env`, backup and private operator requests were excluded. Provisioning and first-administrator creation belonged to the then-selected fresh-target plan. That plan is now superseded: the existing production database requires read-only verification and preservation, as described at the top of this guide.

The complete synthetic test baseline passed **1,729 tests**: server 903, demo 224, web 484 and tools 118. After the Zoho and first-administrator changes, the complete server and tools suites passed again with **915** and **123** tests respectively. Together with the unchanged demo/web suites, the results at that stage totalled **1,746 passing tests**, with no failures, skips or cancellations. All three type checks passed. A separate, newly provisioned native MySQL fixture passed **22 checks** across the database, HTTP workflows and Chromium browser. Those checks used isolated synthetic data, not the saved production target.

The production build passed with the configured native MySQL settings. `npm run hub:check` failed database readiness because the configured loopback MySQL endpoint was not reachable locally. This does not verify the database schema or the deployment host. The current local configuration selects web port **3090** and API port **3002**; if those ports are retained on the server, change the dedicated Nginx web upstream to `127.0.0.1:3090` and verify both ports are available there. The generic templates remain at 3301/3302.

The US metadata check with the explicit profiles above accepted the token and observed a production environment and all five requested metadata modules. It observed **41 of 50** expected required fields and reported **17 review checks**. Contacts and Products passed the check's metadata expectations. Accounts `Owner` was reported read-only. The selected Deals mappings no longer reported department, PO-box or stage-picklist mismatches; five optional date fields were absent and the unknown-mandatory-field check remained open. `Quotes.Amount` was absent, six nested-field checks remained unchecked in this CLI, and Notes were unsupported. A separate parent/subform metadata probe observed quotation child fields compatible with the v8 codec. The `VZ_App_Status` picklist includes `Proposal`; an earlier local note incorrectly reported it missing.

The metadata CLI did not pin the organization to an approved identity, read or write business records, persist raw metadata, or enable runtime integration. Separate workflow tests must not be confused with this metadata-only result. The active credentials were subsequently replaced with a dedicated Hub OAuth client and verified against the same production organization and user. Earlier values remain commented in the private root environment for the owner's review; no credential value is recorded here. The existing CRM client was not changed. At that stage, `ZOHO_ENABLED=false` remained in the root configuration while native outbound integration was being implemented and verified. This local preparation has not established production readiness.

A separately authorized direct Zoho production test created **five synthetic records**, which remain for review. Product, Account, Contact and Deal creation, readback, conditional edit and second readback passed. Requests explicitly suppressed triggers and requested cadence skipping; no email endpoint was called. The quotation initially failed verification because Zoho returned a zero tax value for a direct `Tax` scalar. A conditional retest of the same quotation and line IDs using VAT line entries passed exact readback: subtotal `2.7`, discount `0.135`, tax `0.12825` and grand total `2.69325`. No additional records were created for that retest. The test also established that Deals `Pipeline` is mandatory. The matching source tax correction and explicit-pipeline propagation passed regressions in the final server suite. This bounded provider test does not prove native application persistence, reconciliation or complete synchronization, and runtime integration was still disabled at that stage.

Subsequent native integration work followed the user's then-selected new-empty-Hub-database plan, not the historical PHP schema. That deployment choice is now superseded; the fixture evidence remains valid for its recorded scope. A fresh isolated MySQL fixture passed eight migration-v4 and binding checks. Eleven further checks exercised normal native services against a verified synthetic Zoho provider, including native persistence, both quotation PDFs and reconciliation. These establish local behavior against controlled fixtures, not acceptance of the configured MySQL server or every live provider workflow.

The named production opener also passed a separate **read-only check against the real pinned Zoho organization and current owner**, including six modules of parent/child field metadata, the selected pipeline/stage labels and VAT settings. This check made zero business writes and did not activate the runtime. It uses operation-specific field permissions, so it resolves the earlier metadata-only `Owner` warning without ignoring permission checks. The mandatory child `Parent_Id` is verified as the implicit relationship supplied by its enclosing quotation. The five profile settings were staged privately with `ZOHO_ENABLED=false` while application-level acceptance was pending. A fresh TCP check still found the saved loopback MySQL port 3306 unavailable here; actual schema, UUID, grants, first administrator and user binding must be verified on the manual deployment target.

A later complete regression run passed **1,790 tests**: 946 server, 489 web, 224 demo and 131 tools tests, with no failures, skips or cancellations. The normal production build passed. Another fresh v4 fixture passed all **22 MySQL, HTTP and Chromium checks**, applying four migrations and zero on repeat. Subsequent fixes are verified separately below; these counts identify the tested snapshot rather than an assurance about later changes.

The first application-level live Zoho attempt retained five additional labelled records and stopped at Site Visit before quotation creation. The operation was refused with a pipeline mapping error and its blocked journal entry remains for review. Read-only layout/pipeline inspection established that the Stage option's internal value is `Needs Analysis`, while its reference/display value is `Site Visit`. The implementation now verifies that exact association and sends the display value, consistent with [Zoho's picklist API guidance](https://help.zoho.com/portal/en/community/topic/kaizen-205-answering-your-questions-managing-picklists-and-enabling-history-tracking-via-zoho-crm-apis). It does not alter the historical mapping profile, replay the blocked operation or infer success from the earlier metadata check. The corrected opener passed a fresh real-account read-only preflight, and all eleven native-service checks against the verified synthetic provider passed again with the explicit layout and corrected record values. Corrected live application acceptance was still pending at that point. Raw account metadata and operation receipts stay in ignored private storage and are excluded from source publication.

After that correction, the production build, complete lint and server typecheck passed again. The full server suite passed **950** tests and the full tools suite passed **131** tests. Together with the verified **489 web** and **224 demo** tests, this regression snapshot totalled **1,794 passing tests**, with no failures, skips or cancellations. The web-only input-limit change was also checked by its affected browser tests and web typecheck. These source checks do not replace the live workflow acceptance or deployment-host prerequisites above.

The next bounded application attempt retained one additional Contact and stopped at Deal creation because the explicit layout requires `Closing_Date`, despite module metadata reporting `system_mandatory=false`. Its blocked operation is retained. The profile now inspects the layout's `required` flags, pins the supported required inputs and rejects additional requirements before any business request. The application accepts an explicit Expected Closing Date and verifies the saved value. This corrects the documented distinction between [layout requirements and system-mandatory fields](https://help.zoho.com/portal/pt/community/topic/crm-developer-update-mandatory-field-behavior-changes-in-zoho-crm-apis); it does not silently supply a date or retry the failed operation.

The final closing-date correction passed the real-account read-only opener, all eleven native-service/synthetic-provider workflow checks, the production build, full lint and affected type checks. The complete server suite passed **953 tests**. Together with **489 web**, **224 demo** and **131 tools** tests, the latest verified suite results total **1,797 passing tests**, with no failures, skips or cancellations; the affected closing-date browser tests also passed. A fresh isolated v4 target passed provisioning, first-administrator setup and real-provider read-only user binding. None of these fixtures establishes readiness of the saved port-3306 target.

**Final live application result: all eleven checks passed.** The application ran through its normal authenticated Express HTTP routes with CSRF, a separate native MySQL fixture on port 3308, the verified actor binding and the actual pinned production Zoho organization. Checks covered Product creation, Account reuse, Contact/Deal creation, Site Visit, v8 quotation creation and conditional editing, exact financial and row-ID readback, stored local notes and issuer/PDF output, Closed Won and Closed Lost. Replaying completed operations made no additional remote writes; the two prior blocked journals remained unchanged and the earlier failed Deal was excluded from subsequent writes.

This final run created **six** labelled records and made **seven** conditional updates. Across the separately authorized direct test and all application attempts, **17 synthetic records remain in Zoho for review**. No deletion or automatic cleanup ran. Requests used empty trigger lists and requested cadence skipping; no email endpoint was called. Private receipts, record identities, account metadata, credentials and fixture databases are excluded from the package. This proves the tested local native-application path to the real provider; it does not establish public HTTPS, Linux host deployment, recovery acceptance, background synchronization or connectivity/schema readiness for the saved production MySQL endpoint.

## Inbound synchronization verification 2026-10-19

The complete bounded read of the pinned production Zoho organization passed. It made 3,925 GET requests in 465.6 seconds and retained the normalized snapshot privately. The source data included:

| Source collection | Records |
| --- | ---: |
| Products | 2,500 |
| Deals | 5,960 |
| Deal Notes | 9,840 |
| Historical Quotes | 3,784 |
| Custom user directory | 28 |
| Explicit Deal deletion records | 18 |

Another 4,559 Notes belonged to other modules and were explicitly excluded. Of the historical Quotes, 179 had no Deal link; they remain source quotations without an invented task or owner. All supplied Deal parent references were present. Source amounts, missing fields and quotation rows were retained without recomputing historical finances. No Zoho business record was created, updated or deleted by these import checks.

The retained snapshot was applied through the normal inbound coordinator to a fresh isolated native MySQL database on port 3308 with the final v5 schema. **All 22,130 observations passed: 22,112 source projections applied, 18 explicit deletions recorded, zero conflicts.** Atomic apply took 43.3 seconds; the original scan watermark was preserved. Application reads returned all 3,784 historical quotations and 5,960 active source Deals. A subsequent real-provider incremental pass used 13 GET requests, applied six later Deals, advanced the durable generation to 2 and returned 5,966 active Deals, again with zero conflicts and zero provider writes. The conditional timestamp now uses seconds with an explicit offset, and normalized timestamps are filtered defensively before applying results.

The final v5 migration preserves 255-character imported product names in the catalog and quotation item tables; new Product creation retains its existing 200-character input limit. All five migrations and exact runtime grants passed on the fresh fixture. Isolated MySQL checks also covered leases, rollback, source conflicts, read-only imported records, assignment binding/revocation, inactive products, tombstones and repeated source-identity conflicts. A conflicting replacement identity cannot overwrite the original creation timestamp or the previously applied record.

The complete server suite passed 989 tests before the final identity regression was added; the final identity/store/snapshot/source-digest checks passed all 27 tests. The complete web suite passed 490 tests, and the new 255-character quotation boundary passed in the focused commercial checks. The final demo suite passed 224 tests; the tools suite passed 139 tests. Final lint, server type checking and the production build passed. The additional regression cases are identified separately instead of presenting an older full-suite count as a new full run.

A separate private local preview also ran the normal inbound worker with a 300-second interval and outbound integration disabled. Its startup pass advanced the stored generation from 2 to 3 with zero conflicts. A short expiry test drained the worker, released its lease and closed both owned HTTP listeners; the preview was then restored under its bounded fixture approval. This process uses private fixture configuration and does not enable polling in the saved production environment.

**Historical activation state recorded 2026-10-19:** Production polling was not running from the saved root configuration. It retained `ZOHO_SYNC_ENABLED=false`, interval 300 seconds and no guessed principal ID. All earlier active assignments were preserved. At that time the saved loopback port-3306 endpoint was unreachable from Windows. The then-planned fresh-target provisioning/bootstrap sequence is superseded by the existing-production-database clarification at the top of this guide. Verify the existing target and administrator, preserve any checkpoint, and follow the guarded check → one run → review → enable sequence above. The successful local fixture and provider checks do not establish deployment, public HTTPS, backup recovery or readiness of that different database. Raw source payloads, private receipts, credentials and fixture databases remain outside the source package.
