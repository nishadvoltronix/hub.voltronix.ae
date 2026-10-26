import { createHash } from "node:crypto";
import type { SqliteDatabase } from "./connection";
import { LEADS_SCHEMA_SQL } from "./leads-migration";
import { DASHBOARD_SCHEMA_SQL } from "./dashboard-migration";
import { JOBS_SCHEMA_SQL } from "./jobs-migration";
import { LEAD_MUTATIONS_SCHEMA_SQL } from "./lead-mutations-migration";
import { DEPARTMENTS_SCHEMA_SQL } from "./departments-migration";
import { ATTACHMENTS_SCHEMA_SQL } from "./attachments-migration";
import { COMMERCIAL_SCHEMA_SQL } from "./commercial-migration";
import { LOG_ATTACHMENTS_SCHEMA_SQL } from "./log-attachments-migration";
import { ATTACHMENT_COMPATIBILITY_SCHEMA_SQL } from "./attachment-compatibility-migration";

// Fresh SQLite design for the implemented slice; not a reconstruction of unavailable MySQL DDL.
// users: Admin.php:566-620; permissions: Admin.php:629-739 and Permissions.php.
// tasks identity/ownership: Admin.php:12-34,94-159; Task_model.php:397-432.
// departments_assign: Admin.php:109-154,1602-1606. Local users.id differs from external users.user_id.
export const migrations = [{
  version: 1,
  name: "sqlite_auth_and_assignment_foundation",
  sql: `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT UNIQUE,
  username TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  department TEXT,
  department_role TEXT,
  role TEXT,
  quote_access INTEGER NOT NULL DEFAULT 0 CHECK (quote_access IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE TABLE permission_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  group_id INTEGER REFERENCES permission_groups(id) ON DELETE RESTRICT,
  description TEXT
) STRICT;
CREATE TABLE admin_user_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  UNIQUE (admin_user_id, permission_id)
) STRICT;
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zoho_crm_id TEXT UNIQUE,
  assigned_to TEXT REFERENCES users(user_id) ON DELETE RESTRICT,
  deal_crm_created_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  deal_name TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE INDEX idx_tasks_assigned_to ON tasks(assigned_to);
CREATE TABLE departments_assign (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  department TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Assigned',
  assigned_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  assigned_date TEXT,
  assigned_time TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE INDEX idx_departments_latest ON departments_assign(task_id, department, id DESC);
CREATE INDEX idx_departments_user ON departments_assign(user_id, task_id);
CREATE TABLE crm_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL,
  password_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at)
) STRICT;
CREATE INDEX idx_sessions_user ON crm_sessions(user_id);
CREATE INDEX idx_sessions_expiry ON crm_sessions(expires_at);
CREATE TABLE crm_login_attempts (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 0)
) STRICT;
CREATE INDEX idx_login_attempts_window ON crm_login_attempts(window_start);
`,
}, {
  version: 2,
  name: "local_user_and_permission_settings",
  // Permissions.php and views/Permissions supply the editable fields. Versions and
  // append-only audit records are new concurrency/security controls, not imported history.
  sql: `
ALTER TABLE users ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
ALTER TABLE users ADD COLUMN grants_version INTEGER NOT NULL DEFAULT 1 CHECK (grants_version >= 1);
ALTER TABLE users ADD COLUMN department_assigned_by INTEGER REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE users ADD COLUMN department_assigned_date TEXT;
ALTER TABLE permission_groups ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
ALTER TABLE permissions ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
CREATE TABLE crm_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_type TEXT NOT NULL CHECK (target_type IN ('users', 'permission_groups', 'permissions')),
  target_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'users.create', 'users.update', 'users.status', 'users.department',
    'groups.create', 'groups.update', 'permissions.create', 'permissions.update', 'grants.replace'
  )),
  changed_fields TEXT NOT NULL CHECK (json_valid(changed_fields) AND json_type(changed_fields) = 'array'),
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE INDEX idx_audit_target ON crm_audit_events(target_type, target_id, id);
CREATE INDEX idx_audit_actor ON crm_audit_events(actor_user_id, id);
CREATE TRIGGER crm_audit_events_no_update BEFORE UPDATE ON crm_audit_events
BEGIN SELECT RAISE(ABORT, 'Audit records are immutable'); END;
CREATE TRIGGER crm_audit_events_no_delete BEFORE DELETE ON crm_audit_events
BEGIN SELECT RAISE(ABORT, 'Audit records are immutable'); END;
`,
}, {
  version: 3,
  name: "dashboard_and_lead_read_models",
  sql: LEADS_SCHEMA_SQL + DASHBOARD_SCHEMA_SQL,
}, {
  version: 4,
  name: "local_job_status_and_remarks",
  sql: JOBS_SCHEMA_SQL,
}, {
  version: 5,
  name: "lead_mutation_operations",
  sql: LEAD_MUTATIONS_SCHEMA_SQL,
}, {
  version: 6,
  name: "department_assignments_and_logs",
  sql: DEPARTMENTS_SCHEMA_SQL,
}, {
  version: 7,
  name: "private_local_attachments",
  sql: ATTACHMENTS_SCHEMA_SQL,
}, {
  version: 8,
  name: "commercial_persistence",
  sql: COMMERCIAL_SCHEMA_SQL,
}, {
  version: 9,
  name: "department_log_attachments",
  sql: LOG_ATTACHMENTS_SCHEMA_SQL,
}, {
  version: 10,
  name: "source_department_attachment_limits",
  sql: ATTACHMENT_COMPATIBILITY_SCHEMA_SQL,
}] as const;

interface AppliedMigration { version: number; name: string; checksum: string }
function checksum(sql: string): string { return createHash("sha256").update(sql).digest("hex"); }
function hasHistory(db: SqliteDatabase): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'crm_schema_migrations'").get();
}
function verifyHistory(db: SqliteDatabase): AppliedMigration[] {
  const rows = db.prepare("SELECT version, name, checksum FROM crm_schema_migrations ORDER BY version").all() as AppliedMigration[];
  for (const [index, row] of rows.entries()) {
    const migration = migrations[index];
    if (!migration || row.version !== migration.version || row.name !== migration.name || row.checksum !== checksum(migration.sql)) {
      throw new Error("Migration history mismatch. Restore or investigate the database; no migration was applied.");
    }
  }
  return rows;
}

export function assertMigrationsCurrent(db: SqliteDatabase): void {
  if (!hasHistory(db) || verifyHistory(db).length !== migrations.length) {
    throw new Error("SQLite migrations are required. Run npm run db:migrate explicitly.");
  }
}

/** Entire migration batch uses one immediate transaction. Existing unknown schemas are refused. */
export function migrateDatabase(db: SqliteDatabase): number {
  if (db.readonly) throw new Error("Migrations require writable access.");
  if (db.pragma("foreign_keys", { simple: true }) !== 1) throw new Error("Foreign keys must be enabled.");
  return db.transaction(() => {
    if (!hasHistory(db)) {
      // GLOB keeps the underscore literal; LIKE would also hide user tables such
      // as sqliteXhistory and could adopt an unrecognized populated database.
      const existing = db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1").get();
      if (existing) throw new Error("Unrecognized existing schema. Migration refuses to adopt or overwrite it.");
      db.exec(`CREATE TABLE crm_schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT`);
    }
    const applied = verifyHistory(db);
    const insert = db.prepare("INSERT INTO crm_schema_migrations (version, name, checksum) VALUES (?, ?, ?)");
    for (const migration of migrations.slice(applied.length)) {
      db.exec(migration.sql);
      insert.run(migration.version, migration.name, checksum(migration.sql));
    }
    return migrations.length - applied.length;
  }).immediate();
}
