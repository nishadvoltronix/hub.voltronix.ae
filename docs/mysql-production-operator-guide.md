> Native-schema operator procedure only. This guide applies to the explicitly selected new empty Hub database, never to the existing PHP CRM database or database-disabled preview. The current [Hub runbook](manual-deployment-guide.md) controls deployment and the [environment guide](backend-production-environment.md) controls normal root configuration. Historical CRM compatibility remains unavailable.

# MySQL production operator guide — Ubuntu 24.04

Prepared 2026-10-14. **All server commands below are future owner-operated procedures: NOT RUN.** No server, database, account, grant, credential or private profile was created or changed while preparing this guide. The local SQLite demo is outside its scope. Passing offline tests is not MySQL acceptance, authorization to migrate an existing target, or proof of recoverability.

**Current update, 2026-10-19:** the native lineage includes v4 for verified Zoho user bindings and v8 quotation persistence, and additive v5 for inbound synchronization provenance, leases, receipts and source quotations. Verification results identify their tested lineage in the [current verification notes](backend-production-environment.md#local-verification-2026-10-19). The dated 2026-10-14 evidence at the end remains historical. No Linux deployment or acceptance of the configured production database is established. The active application uses one root `.env`; the migration operator still uses its separately protected profile.

Use with the [manual deployment guide](manual-deployment-guide.md) and [staging acceptance gates](staging-acceptance.md). Detailed local evidence remains in the separately retained repository readiness report, not the runtime candidate. Do not use older direct-Next/SQLite/v1-only recovery instructions for this runtime.

## 1. Supported target and responsibility boundaries

The implemented target is **Oracle MySQL 8.4.11 on the same host as Express**, TCP `127.0.0.1`, port `3306` or `3308`. MySQL-compatible products, other versions, remote hosts, `localhost` socket selection and IPv6 production connections are not accepted. The driver does not implement remote MySQL TLS; never expose its port publicly or redirect this connection through an unreviewed tunnel/proxy.

Production validation in `server/src/crm/config/mysql.ts` requires:

| Setting | Exact constraint / origin |
| --- | --- |
| Database | Owner-provided name matching `^[a-z][a-z0-9_]{0,63}$`; not `mysql`, `sys`, `information_schema` or `performance_schema`. No name is provisioned by the application. |
| Username | Owner-provided name matching `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$`; not `root`, `mysql.sys`, `mysql.session` or `mysql.infoschema` (case-insensitive check). Use separate migration, runtime, backup and restore authority. |
| Password | Owner-provided nonempty value; at most 4,096 characters **and** 4,096 UTF-8 bytes; no NUL. This validation is not a password-strength policy. Obtain through the approved administrator/secret-custody process. |
| Server UUID | Actual `@@server_uuid`, obtained privately from the approved target, matching the separately approved profile. Never substitute a generated example. |
| MySQL account host | `CURRENT_USER()` must be the selected username followed by `@127.0.0.1`; wildcard and `@localhost` accounts are not accepted. Verify TCP account matching rather than assuming it. |
| Roles/grants | No active or mandatory roles, no global/dynamic/delegable/extra grants. Migration and runtime direct-grant contracts below are different. |
| Migration server settings | `partial_revokes=ON` prevents underscores in schema-level grants being wildcard patterns. If binary logging is ON, `log_bin_trust_function_creators=ON` is required for the limited migration identity to create the reviewed triggers without `SUPER`. The tool checks these settings; it does not change them. |
| Session checks | Autocommit, foreign-key checks and unique checks must all be enabled before migration. Application leases additionally establish strict SQL mode, UTC and bounded transaction settings. |

Changing server-wide settings can affect other workloads: inspect them first and obtain host-operator approval. Do not grant `SUPER`, `SYSTEM_USER`, `FILE`, `SET_ANY_DEFINER`, `GRANT OPTION` or broad roles to make a refusal disappear. Account provisioning/password policy, authentication plugin compatibility, DB storage capacity, `max_allowed_packet`, connection limits and backup monitoring require real-host acceptance. The application supports department attachments up to 52,428,800 bytes; packet/memory/backup sizing must account for SQL protocol and hex-dump expansion, not just that raw file size.

Use separate Unix operators where possible. The running API must not be able to read migration, administrator, backup or restore credentials. Run the root operator command from a **separate physical copy of the same reviewed single-root release**, owned by its operator, with its own private profile under `server/`. Do not put migration credentials into the service user's readable release tree. Do not use a symlinked `.local-data` directory or private profile to share credentials between releases.

## 2. Private configuration: exact supported mechanism

This section retains the guarded native-schema JSON configuration option used by explicit operator tools. The normal Hub launcher instead uses the [root environment configuration](backend-production-environment.md#database-mode); do not combine its environment source with a runtime JSON profile. The native migration operator requires its separate private JSON and the reviewed new empty target. No `NEXT_PUBLIC_*` database setting exists. The uppercase `DATABASE_PROVIDER` / `MYSQL_*` TypeScript parser fields are an internal object contract, not an additional dotenv credential loader.

Within `server/` of each selected physical release (paths below are relative to `server/`, not the repository root):

- Runtime profile: `.local-data/operators/mysql-crm-runtime.json`, read by the API; production profile version **2**.
- Migration profile: `.local-data/operators/mysql-crm-migration.json`, read only by the explicit operator CLI; profile version **1**. It is not accepted as the API runtime profile.
- Private directories and file must belong to the invoking Unix UID. Directories should be `0700`, file `0600`; no group/other mode bits, symlinks, aliases or hard links. Canonical JSON uses two-space indentation, unique keys and no BOM; maximum 16,384 bytes. The reader never creates or fixes these files/permissions.
- Provision privately using the owner's approved secret workflow **after** authorization. Do not echo/cat a populated profile into a terminal, send it in chat, store it in Git, or use command-line password arguments. This document contains intentionally invalid placeholders, not ready-to-activate identities.

Production runtime template (replace every angle-bracket placeholder privately; preserve key order/formatting as canonical JSON):

```json
{
  "version": 2,
  "mysql": {
    "provider": "mysql",
    "environment": "production",
    "host": "127.0.0.1",
    "port": 3306,
    "database": "<OWNER_APPROVED_SCHEMA>",
    "user": "<OWNER_APPROVED_RUNTIME_USER>",
    "password": "<OWNER_SUPPLIED_RUNTIME_PASSWORD>"
  },
  "approval": {
    "approved": true,
    "reference": "<ACTUAL_RUNTIME_APPROVAL_REFERENCE>",
    "provisioningReference": "<ACTUAL_PROVISIONING_RECEIPT_REFERENCE>",
    "serverUuid": "<ACTUAL_TARGET_SERVER_UUID>"
  },
  "issuer": {
    "company": "<OWNER_APPROVED_ISSUING_COMPANY>",
    "salesperson": "<OWNER_APPROVED_SALESPERSON_DISPLAY_NAME>"
  }
}
```

Runtime references match `^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$`. The issuer company must be exactly one of `VOLTRONIX CONTRACTING LLC` or `VOLTRONIX SWITCHGEAR LLC`, chosen by the owner, not inferred from a customer/account. The salesperson must be trimmed, printable with the supplied PDF font coverage, contain a letter/digit, and be at most 200 characters without CR/LF/Tab. New quotation creation snapshots this issuer; changing configuration must not rewrite historical snapshots. Approved fonts/backgrounds/signature/stamp assets are separately provisioned and licensed; the sanitized candidate does not prove they are available.

Runtime selectors belong only to the backend service environment:

```dotenv
CRM_API_ENVIRONMENT=production
CRM_API_HOST=127.0.0.1
CRM_API_PORT=3002
APP_ORIGIN=https://<OWNER_APPROVED_PUBLIC_HOSTNAME>
CRM_RUNTIME_ENABLE=approved-production-mysql-crm-runtime
CRM_RUNTIME_PROFILE=.local-data/operators/mysql-crm-runtime.json
```

`APP_ORIGIN` is an exact canonical HTTPS DNS origin without a path, trailing slash or non-default port. API port is explicit, 1024–65535, and must be free/approved. `CRM_MYSQL_NETWORK_DISABLED=1` vetoes connections; leave it absent only in the separately authorized MySQL process. Do not remove the existing SQLite demo veto or alter its `.env`. The API dotenv loader permits only its documented supported keys; a service manager may provide them without an actual `server/.env`. See the environment contract for current keys rather than treating this JSON-option selector example as the complete key list. Runtime version 2 has no daily expiry: credential/approval revocation and restart are explicit operator responsibilities. The older local version 1 remains time-bounded and test-fixture-scoped.

Migration template, under `server/` in the **operator** release copy:

```json
{
  "version": 1,
  "mysql": {
    "provider": "mysql",
    "environment": "production",
    "host": "127.0.0.1",
    "port": 3306,
    "database": "<OWNER_APPROVED_SCHEMA>",
    "user": "<OWNER_APPROVED_MIGRATION_USER>",
    "password": "<OWNER_SUPPLIED_MIGRATION_PASSWORD>"
  },
  "runtimeUser": "<OWNER_APPROVED_DISTINCT_RUNTIME_USER>",
  "approval": {
    "approved": true,
    "reference": "<ACTUAL_CHANGE_APPROVAL_REFERENCE>",
    "validFrom": "<ACTUAL_UTC_ISO_START>",
    "validUntil": "<ACTUAL_UTC_ISO_END>",
    "serverUuid": "<ACTUAL_TARGET_SERVER_UUID>",
    "exclusiveOperatorWindow": true,
    "schemaChanges": true,
    "backupReference": "<ACTUAL_VERIFIED_BACKUP_OR_EMPTY_TARGET_RECEIPT>",
    "rollbackPlanReference": "<ACTUAL_REVIEWED_RECOVERY_PLAN_REFERENCE>"
  }
}
```

Migration references are 8–200 trimmed ASCII characters matching `^[A-Za-z0-9][A-Za-z0-9 .:_/-]*$`. UTC ISO timestamps must enclose the current time, with a window no longer than 24 hours. Migration and runtime usernames must differ. `approved:true`, references and acknowledgement flags record approval; they do not establish it or prove a backup was restored. For a fresh target, the backup reference must identify the genuine empty-target/provisioning evidence and recovery disposition, not a fabricated backup. For an existing target, a verified pre-change backup and accepted restoration procedure are mandatory. Approval expiry during DDL can leave a deliberately retained incomplete migration; do not extend it and blindly retry.

## 3. Future identity, provisioning and exact grants

**NOT RUN.** An owner-authorized DBA must first verify the host, server UUID, available schema names and absence of the proposed accounts across **all host variants**. Do not use `IF NOT EXISTS` to adopt an unrelated schema/account. Stop on any collision. Provisioning is never an application startup action.

Use the matching Oracle 8.4.11 `mysql` and `mysqldump` clients. On the host, inspect their `--version` and `--help` before running the templates. A private client option file is a separate native-MySQL tool facility, **not** an application environment file. Its `[client]` section contains the authorized user/password; store it outside the release, owned by its operator and mode `0600`. It must not select a database: the first identity check runs before the new schema exists. Host/port are pinned explicitly, and subsequent schema-specific commands pin the database as well. Do not use `MYSQL_PWD`, `-pPASSWORD`, shell command substitutions or terminal history to carry secrets. `--defaults-file` must be the first option, and `--no-login-paths` prevents an unrelated login-path file from selecting an identity. Reject unexpected defaults/options during review.

Use a protected, non-recorded operator console and private input/output files. These example paths and identifiers are placeholders, not existing project paths or invented credentials. A populated SQL file must be created by the authorized owner using an editor/secret workflow that does not retain insecure swap, backup, command history or terminal transcripts. Password literals must be correctly SQL-quoted by that workflow; do not perform blind string replacement or use shell interpolation to construct SQL.

Read-only identity SQL, saved in a reviewed private input file:

```sql
SELECT DATABASE(), VERSION(), @@version_comment, @@server_uuid, @@port,
       CURRENT_USER(), CURRENT_ROLE(), @@global.mandatory_roles,
       @@global.partial_revokes, @@global.log_bin,
       @@global.log_bin_trust_function_creators,
       @@session.autocommit, @@session.foreign_key_checks, @@session.unique_checks;
```

Pre-provision identity check, with **all placeholders replaced/reviewed first**; output stays in private evidence rather than chat/build logs. Do not select the not-yet-created database; `DATABASE()` should be null at this step:

```bash
MYSQL_HISTFILE=/dev/null mysql --defaults-file='<PRIVATE_CLIENT_OPTION_FILE>' \
  --no-login-paths --protocol=TCP --host=127.0.0.1 --port='<APPROVED_3306_OR_3308>' \
  --local-infile=0 --binary-mode --batch \
  < '<PRIVATE_REVIEWED_IDENTITY_SQL>' > '<PRIVATE_IDENTITY_RECEIPT>' 2> '<PRIVATE_ERROR_RECEIPT>'
```

Run subsequent commands only after checking exit status and comparing the private results to the genuine approval. Never publish `SHOW CREATE USER` output or account password hashes. `SHOW GRANTS` and identity metadata should also remain private operational evidence.

Provisioning SQL template (**separate authorization required; NOT RUN**), for a positively identified **new** schema and new accounts only:

```sql
CREATE DATABASE `<OWNER_APPROVED_SCHEMA>` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
CREATE USER '<OWNER_APPROVED_MIGRATION_USER>'@'127.0.0.1'
  IDENTIFIED BY '<OWNER_SUPPLIED_CORRECTLY_SQL_QUOTED_MIGRATION_PASSWORD>';
CREATE USER '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1'
  IDENTIFIED BY '<OWNER_SUPPLIED_CORRECTLY_SQL_QUOTED_RUNTIME_PASSWORD>';
GRANT SELECT, INSERT, UPDATE, CREATE, ALTER, REFERENCES, TRIGGER
  ON `<OWNER_APPROVED_SCHEMA>`.* TO '<OWNER_APPROVED_MIGRATION_USER>'@'127.0.0.1';
```

Execute reviewed provisioning SQL only using separately authorized DBA access, never the application identity; direct stdout/stderr to protected receipts as above. No password or actual profile content belongs in reports. If any statement fails, retain partial state and investigate; do not drop/recreate accounts or schemas. No automatic database import or first-user seed is provided. A new empty schema has **no CRM login account**: approved account/data onboarding remains a separate prerequisite, not permission to reuse or reset local demo accounts.

After successful provisioning, repeat the identity SQL with the approved schema selected and new private receipt paths. Verify `DATABASE()` equals the approved name and the server identity remains unchanged before migration:

```bash
MYSQL_HISTFILE=/dev/null mysql --defaults-file='<PRIVATE_CLIENT_OPTION_FILE>' \
  --no-login-paths --protocol=TCP --host=127.0.0.1 --port='<APPROVED_3306_OR_3308>' \
  --database='<APPROVED_SCHEMA>' --local-infile=0 --binary-mode --batch \
  < '<PRIVATE_REVIEWED_IDENTITY_SQL>' > '<NEW_PRIVATE_SCHEMA_IDENTITY_RECEIPT>' 2> '<NEW_PRIVATE_SCHEMA_ERROR_RECEIPT>'
```

Apply the following runtime grants **after** the versioned tables exist. Each line is part of the exact reviewed map in `server/src/crm/db/mysql/runtime-privileges.ts`; extra rights and schema-wide runtime grants are refused:

```sql
GRANT SELECT, INSERT, UPDATE ON `<OWNER_APPROVED_SCHEMA>`.`users` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON `<OWNER_APPROVED_SCHEMA>`.`permission_groups` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON `<OWNER_APPROVED_SCHEMA>`.`permissions` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT, DELETE ON `<OWNER_APPROVED_SCHEMA>`.`admin_user_permissions` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON `<OWNER_APPROVED_SCHEMA>`.`tasks` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON `<OWNER_APPROVED_SCHEMA>`.`departments_assign` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `<OWNER_APPROVED_SCHEMA>`.`crm_sessions` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `<OWNER_APPROVED_SCHEMA>`.`crm_login_attempts` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT ON `<OWNER_APPROVED_SCHEMA>`.`crm_audit_events` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON `<OWNER_APPROVED_SCHEMA>`.`job_notes` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT ON `<OWNER_APPROVED_SCHEMA>`.`tasks_status_log` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT ON `<OWNER_APPROVED_SCHEMA>`.`accounts` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT ON `<OWNER_APPROVED_SCHEMA>`.`crm_job_audit_events` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON `<OWNER_APPROVED_SCHEMA>`.`crm_lead_operations` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT ON `<OWNER_APPROVED_SCHEMA>`.`crm_lead_audit_events` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT ON `<OWNER_APPROVED_SCHEMA>`.`crm_department_work_logs` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT ON `<OWNER_APPROVED_SCHEMA>`.`crm_department_audit_events` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT ON `<OWNER_APPROVED_SCHEMA>`.`task_attachment` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT ON `<OWNER_APPROVED_SCHEMA>`.`crm_attachment_audit_events` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON `<OWNER_APPROVED_SCHEMA>`.`products` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON `<OWNER_APPROVED_SCHEMA>`.`crm_quotations` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT, DELETE ON `<OWNER_APPROVED_SCHEMA>`.`proposal_items` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON `<OWNER_APPROVED_SCHEMA>`.`crm_commercial_operations` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT ON `<OWNER_APPROVED_SCHEMA>`.`crm_commercial_audit_events` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT ON `<OWNER_APPROVED_SCHEMA>`.`crm_department_log_attachments` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT ON `<OWNER_APPROVED_SCHEMA>`.`crm_department_log_attachment_audit_events` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT ON `<OWNER_APPROVED_SCHEMA>`.`crm_local_tasks` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON `<OWNER_APPROVED_SCHEMA>`.`crm_local_notes` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT ON `<OWNER_APPROVED_SCHEMA>`.`crm_local_operations` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT ON `<OWNER_APPROVED_SCHEMA>`.`crm_local_audit` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON `<OWNER_APPROVED_SCHEMA>`.`crm_percentage_quotations` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON `<OWNER_APPROVED_SCHEMA>`.`crm_zoho_quotations` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `<OWNER_APPROVED_SCHEMA>`.`crm_zoho_quotation_items` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT ON `<OWNER_APPROVED_SCHEMA>`.`crm_zoho_user_bindings` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT ON `<OWNER_APPROVED_SCHEMA>`.`crm_zoho_user_binding_audit` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON `<OWNER_APPROVED_SCHEMA>`.`crm_zoho_sync_source` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT ON `<OWNER_APPROVED_SCHEMA>`.`crm_zoho_sync_runs` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON `<OWNER_APPROVED_SCHEMA>`.`crm_zoho_sync_records` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT ON `<OWNER_APPROVED_SCHEMA>`.`crm_zoho_sync_events` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON `<OWNER_APPROVED_SCHEMA>`.`crm_zoho_inbound_quotations` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT, UPDATE ON `<OWNER_APPROVED_SCHEMA>`.`crm_app_lock` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
GRANT SELECT ON `<OWNER_APPROVED_SCHEMA>`.`crm_mysql_schema_migrations` TO '<OWNER_APPROVED_RUNTIME_USER>'@'127.0.0.1';
```

The runtime cannot write the migration ledger or modify/delete immutable audit records. The application lock's `UPDATE` privilege is required by the target's `SELECT ... FOR UPDATE`; it is not authorization to change that row. MySQL creates triggers under the migration identity as their definer. Retain and protect that identity with its required object rights; do not casually drop it after migration. Definer lifecycle/credential access and restore mapping need DBA review; no automatic grant/credential cleanup is performed.

## 4. Explicit inspection, migration and verification

**Not run on the manual production deployment target.** Local isolated fixtures have exercised the native lineage. Before any approved existing-native-target migration, establish the maintenance/write-freeze window, verified backup and independent restore evidence. Stop only the verified CRM service using the main deployment guide, not unrelated services. Review must identify this release, exact target, authorized changes, recovery decision-maker and retention of partially committed DDL. This does not permit migration of the historical PHP database.

From the canonical operator release root, with its separately approved private migration profile under `server/` and production dependencies installed once at the root, use the verified app-local Node 24 installation from the deployment guide. Keep these variables in the same dedicated operator shell; do not rely on a global `node` or `npm`:

```bash
cd '<OWNER_APPROVED_OPERATOR_PROJECT_ROOT>'
node_bin=/var/www/hub.voltronix_ae/runtime/node/bin/node
npm_cli=/var/www/hub.voltronix_ae/runtime/node/lib/node_modules/npm/bin/npm-cli.js
"$node_bin" --version
env -i HOME="$HOME" PATH="$(dirname "$node_bin"):/usr/bin:/bin" \
  "$node_bin" "$npm_cli" run mysql:operator -- inspect
```

The root wrapper runs `node dist/operations/mysql-cli.js inspect` inside `server/` (the project-root entry path is `server/dist/operations/mysql-cli.js`), requires no `tsx`/development dependency, performs identity/direct-grant checks and reports only status plus installed/pending migration counts. It never creates a database or changes application/schema data. It accepts empty, exact-prefix and current lineages; unknown objects, failed `applying` receipts or drift refuse. A missing profile/refused identity is not a reason to copy another environment's credentials. Never use a production profile to test a staging database.

After approved preconditions pass:

```bash
env -i HOME="$HOME" PATH="$(dirname "$node_bin"):/usr/bin:/bin" \
  "$node_bin" "$npm_cli" run mysql:operator -- migrate --acknowledge-additive-mysql-ddl-and-retained-failures
# Only after the previous command succeeds:
env -i HOME="$HOME" PATH="$(dirname "$node_bin"):/usr/bin:/bin" \
  "$node_bin" "$npm_cli" run mysql:operator -- inspect
```

Check each exit status before continuing. Expected ordered migrations are:

| Version | Name | Statements |
| --- | --- | --- |
| 1 | `mysql_application_foundation` | 47 |
| 2 | `mysql_local_workflows_percentage_v2` | 17 |
| 3 | `mysql_department_attachment_limits` | 2 |
| 4 | `mysql_verified_zoho_v8_workflows` | 17 |
| 5 | `mysql_zoho_inbound_sync` | 18 |

Current v5 target: 40 application tables plus `crm_app_lock` and `crm_mysql_schema_migrations` = **42 tables**, 48 named expected indexes and 55 triggers. These counts come from the native MySQL manifests, independently of the SQLite demo. Empty-target acceptance expects 5 applied; an approved exact-v1 upgrade expects 4; exact-v3 expects 2; exact-v4 expects 1; a separately authorized repeat on a current schema expects 0. Repeating a failed migration is prohibited. Existing v1–v4 checksums remain unchanged. Migration v5 adds five synchronization tables without importing provider records; its runtime grant change also adds `UPDATE` on `products` for refreshes. Review the complete exact grant map above after migration.

After native provisioning/readiness passes, use the separate [first-administrator and verified-user binding procedures](backend-production-environment.md#create-the-first-native-administrator-explicitly). Startup never initializes a database or creates a login account.

MySQL DDL implicitly commits. The engine records `applying` before DDL, retains failures, and refuses automatic resume, adoption, repair or down migration. There is no `--force`, reset, cleanup, seed, import or automatic retry. Investigate an interrupted schema with the original private evidence and an explicit recovery decision; do not edit ledger rows to make the guard pass.

The inspector checks lineage, object inventory, expected indexes and the versioned department attachment shape. It is **not** a complete proof that every FK, CHECK, trigger body and real InnoDB behavior is correct. Independent staging acceptance must compare actual `SHOW CREATE TABLE`/trigger definitions and catalog constraints to the manifest and exercise them. API runtime checks additionally verify its exact table privileges and complete current schema on connections. `/api/v1/health/ready` exercises configured database readiness; `/api/v1/health/live` alone does not prove DB usability. Use main-guide commands for service startup/health without logging in to the preserved demo.

## 5. Backups: trusted artifacts, not a guessed recovery promise

**BLOCKED until an owner assigns backup custody, retention, RPO/RTO and a successful independent restore rehearsal.** No backup was taken from a MySQL target in this phase. A backup command exit code or a checksum alone does not prove recoverability. Native MySQL tools below replace no existing private backups and do not implement a new application backup CLI.

The backup operator must use a distinct authorized identity, not the runtime or migration password. For this InnoDB schema and the stated dump flags, review `SELECT` and `TRIGGER` on the exact schema with the installed server/client; avoid global authority, `FILE`, `PROCESS`, `RELOAD` or `LOCK TABLES` unless an independently reviewed backup method actually requires them. The `--no-tablespaces` and `--single-transaction` choices avoid relying on those broader privileges. Keep identity proof and any grant refusal private; do not widen rights automatically. A backup identity is not accepted as a runtime profile.

Freeze schema DDL for the entire dump. For a pre-migration/restore-comparison checkpoint, also establish a CRM write freeze so accounts, sessions, quotation history, attachment BLOBs and logical snapshots can be compared consistently. Concurrent application use changes session/auth rows; do not label those differences corruption without evidence. Do not perform a test login to make a frozen snapshot pass.

After verifying the exact source and private destination, an illustrative **future** dump command is:

```bash
umask 077
set -o noclobber
mysqldump --defaults-file='<PRIVATE_BACKUP_CLIENT_OPTION_FILE>' \
  --no-login-paths --protocol=TCP --host=127.0.0.1 --port='<APPROVED_3306_OR_3308>' \
  --single-transaction --quick --hex-blob --no-tablespaces --set-gtid-purged=OFF \
  --skip-add-drop-table --triggers --max-allowed-packet=256M \
  '<EXACT_APPROVED_SOURCE_SCHEMA>' > '<NEW_PRIVATE_DUMP_PATH>' 2> '<NEW_PRIVATE_DUMP_ERROR_PATH>'
# Check the dump exit status before doing anything else. A failure is retained, not retried over the file.
```

Use new exclusive output paths, not existing backups. The example packet setting is a tool capacity choice to validate on the real host, not an application upload-limit change; provision server/client resources and disk for the largest hex-encoded rows. Do **not** add `--databases` or `--all-databases`: those can embed original database selection/creation. Do not add `--add-drop-table`, `--force`, routines/events or privileged/system-schema dumps. Review the resulting SQL, including version-conditional comments and trigger definers, before treating it as an importable artifact.

Record digest and size privately without printing data or credential-bearing diagnostics:

```bash
sha256sum '<NEW_PRIVATE_DUMP_PATH>' > '<NEW_PRIVATE_CHECKSUM_RECEIPT>'
stat --format='%s' '<NEW_PRIVATE_DUMP_PATH>' > '<NEW_PRIVATE_SIZE_RECEIPT>'
```

Keep an independently protected manifest of source release/build, exact server/schema identity, v1–v5 checksums/state, UTC checkpoint, owner approval, exit results, row/BLOB counts and logical invariants. Hash passwords/session token hashes/row values only inside protected comparison tooling; do not publish these values or their digests. No absent historical baseline may be invented.

Encrypt backups before any authorized off-server transfer, using the owner's approved key custody and recovery process. Do not store the sole key beside the backup, rely solely on the office server's disk, or consider an untested encryption tool invocation sufficient. Approve retention/rotation, capacity alarms, missed-backup alerts, access auditing and a restore schedule; **no off-server connection or retention deletion is authorized by this document**. Logical dumps alone do not supply arbitrary point-in-time recovery. If the chosen RPO needs binlog recovery, separately design, protect and rehearse binlog retention/position linkage; do not improvise `RESET` or replay on an existing target.

## 6. Source-independent restore rehearsal and rollback

**BLOCKED / NOT RUN. No generic unreviewed dump replay is safe.** `--database` on a client is not a sandbox: `USE`, database-qualified statements, executable comments, definers or client directives in SQL can redirect/expand effects. Never pipe a downloaded/untrusted dump into a DBA connection or use blind `sed`/regex replacements to remove schema names, definers, constraints or safety checks.

An owner-authorized independent operator must first:

1. Obtain the retained encrypted backup, checksum/manifest, reviewed matching release, separately backed-up approved private assets and a documented secret/provisioning procedure. Rehearsal must not read missing rows/assets/credentials from the original live source as a fallback.
2. Verify provenance and digest, decrypt into a new protected location, and review the **complete executable SQL**, including version-conditional comments. Confirm no `CREATE DATABASE`, `USE`, system/cross-schema references, unsafe client commands, unexpected routines/events, grants/users, destructive DDL or replacement/upsert statements. Review any temporary constraint-disabling behavior generated by the dump; re-enabling FK checks does not retroactively validate imported rows.
3. Provision a separately authorized **new empty isolated schema/server** and narrowly scoped restore identity. Prove target identity and emptiness before any input execution. Do not use an existing CRM/demo/production target. Use a distinct new private profile and approval with the restored target's actual UUID/schema/account, not the source runtime/migration profile.
4. Approve the exact trigger-definer plan. The restore identity may not have authority to recreate the original explicit definer. Either provision an independently reviewed compatible definer on the isolated target or prepare a new reviewed restore artifact with a deliberately audited definer mapping. Preserve the original dump and retain both digests/change evidence. Do not grant global definer rights or strip definers to bypass this review.
5. Ensure the restore identity cannot write outside the new selected schema. Privilege failures are blockers, not permission to retry as root. A scoped identity and SQL review are both required. Confirm client version/options and how comments, binary input and delimiters are handled; do not rely on `--one-database` as an isolation boundary.

Only **after** those conditions are explicitly accepted, the owner may execute this conditional native-client template; it has not been executed or certified here:

```bash
MYSQL_HISTFILE=/dev/null mysql --defaults-file='<PRIVATE_ISOLATED_RESTORE_CLIENT_OPTION_FILE>' \
  --no-login-paths --protocol=TCP --host=127.0.0.1 --port='<APPROVED_3306_OR_3308>' \
  --database='<NEW_APPROVED_EMPTY_RESTORE_SCHEMA>' --local-infile=0 --binary-mode --batch \
  --max-allowed-packet=256M \
  < '<COMPLETE_REVIEWED_RESTORE_SQL>' > '<NEW_PRIVATE_RESTORE_RECEIPT>' 2> '<NEW_PRIVATE_RESTORE_ERROR_RECEIPT>'
```

Stop on failure, retain the partial new target and receipts, and obtain a fresh disposition. Do not rerun, reset or clean the partial schema. The currently delivered application has no automated artifact-aware restore, integrity-comparison or point-in-time-recovery command. Until the conditional procedure is independently rehearsed, recovery acceptance remains BLOCKED.

After successful restore, before any login or application write:

- With separately approved migration-operator authority, run the read-only `mysql:operator -- inspect` from the restored-target operator copy. Expect installed 5/pending 0 for a current v5 backup; match an older backup to its own retained release and recorded lineage. Do not run migrations first and thereby change the restored snapshot.
- Independently verify actual table/FK/CHECK/index/trigger definitions against the backup's recorded lineage (v1–v5 for the current release) and compare the retained migration ledger. Validate every FK relationship against data; do not infer integrity merely because `foreign_key_checks=1` now.
- Compare source checkpoint and restored target logical schema/rows, immutable audits, account states/password hashes/grants, sessions/login attempts, operation journals, historical quote amounts/policies/inputs/issuer snapshots, saved new percentage quotes, BLOB byte lengths/content hashes, file metadata and exact row counts. Compare protected values in memory/private tooling; report only counts/pass-fail. The local demo's 37/419 is **not** a baseline for a different MySQL target.
- Inspect the separately provisioned runtime grants using the runtime identity, create a new approved runtime profile pointing only at the restored target, and test schema/identity readiness/reconnect using the matched release. Source profiles and service configuration remain unchanged. Verify compatible PDF assets without copying private customer uploads or inventing attachment ownership.
- Record the pre-acceptance restore snapshot, then separately authorize bounded synthetic CRUD, permissions, concurrency, transaction rollback, uncertain-commit handling and end-to-end HTTPS tests. A test login changes authentication state; it must never be used before the immutable restore comparison or against the preserved demo.
- Demonstrate recovery elapsed time against owner-approved RTO, data checkpoint against RPO, application reconnect, and independent operator reproducibility. Preserve failures and all evidence.

Rollback is a decision, not `ROLLBACK` around DDL. Use the main guide's service lifecycle only after confirming process ownership. Freeze new writes, preserve the failed release/target/logs, and choose:

- **Application-only rollback:** use the previously retained immutable release only if it has been independently proven compatible with the current schema, stored quote policy and configuration. Do not assume an older version understands v2/v3/v4/v5, inbound synchronization state or verified Zoho records. Re-check readiness and restricted smoke tests before unfreezing writes.
- **Database recovery:** restore a verified checkpoint into a new isolated target as above, reconcile the approved data-loss window and post-checkpoint writes, then seek separate authorization to change runtime target selection and restart only CRM services. Never restore over the failed/current database, replay a dump automatically, edit historical values, or mutate migration ledger state.

There is intentionally no destructive down-migration/reset command. Deployment/cutover, credential creation/rotation, target switching, restoration, production writes and off-server backup transfer remain owner-operated, separately authorized actions.

## 7. Historical evidence, 2026-10-14

The following paragraphs preserve the original preparation evidence and its status at that date. They are superseded for current local verification by the dated update above and the [current verification notes](backend-production-environment.md#local-verification-2026-10-19); they are not current claims that no real MySQL test has run.

Prepared code uses the existing architecture: `src/operations/mysql-command.ts`, `src/operations/mysql-cli.ts`, `src/crm/config/mysql.ts`, `src/crm/db/mysql/{migrations,runtime-privileges}.ts` and `src/runtime/{configuration,private-profile}.ts`. The isolated test harness now has 11 MySQL cases, 5 HTTP cases and 6 optional Chromium cases; successful test preparation is not a real run.

Focused offline evidence from this implementation: 21/21 operator/migration/privilege tests, 40/40 existing harness/native-write tests, 2/2 native-case orchestration tests; final changed operator/fixture/orchestration rerun 18/18. Direct backend typecheck and scoped lint passed; lint initially identified unsafe cleanup control flow, which was fixed and rerun. The parent readiness report records the later coordinated full-suite/build results separately. These counts overlap and must not be added into a fictitious unique total.

No approved MySQL target/profile was available. Real Oracle DDL, complete installed constraint acceptance, production privilege behavior, native write/concurrency/reconnect, independent backup/restore, issuer/asset delivery and Ubuntu operational acceptance remain **BLOCKED / NOT RUN**. Required next owner inputs are the exact isolated target/provisioning approval, private identities/UUID, actual issuer/assets, account/data onboarding decision, backup custody/retention/RPO/RTO and recovery reviewer. Do not resolve these by modifying the working SQLite database or by reusing the compromised Zoho credential.
