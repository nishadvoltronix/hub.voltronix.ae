// Rebuild only the fresh Next.js assignment table: earlier rows/IDs and all fields are
// copied intact. No imported PHP table or database is modified. Null user is an explicit
// latest Unassigned event, avoiding PHP's UPDATE of every historical assignment.
export const DEPARTMENTS_SCHEMA_SQL = `
CREATE TEMP TABLE crm_assignment_sequence_backup(sequence INTEGER);
INSERT INTO crm_assignment_sequence_backup SELECT seq FROM sqlite_sequence WHERE name='departments_assign';
CREATE TABLE departments_assign_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  department TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Assigned',
  assigned_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  assigned_date TEXT,
  assigned_time TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  assigned_by_external TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1)
) STRICT;
INSERT INTO departments_assign_next(id,task_id,user_id,department,status,assigned_by,assigned_date,assigned_time,notes,created_at,updated_at)
SELECT id,task_id,user_id,department,status,assigned_by,assigned_date,assigned_time,notes,created_at,updated_at FROM departments_assign;
DROP TABLE departments_assign;
ALTER TABLE departments_assign_next RENAME TO departments_assign;
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT sequence FROM crm_assignment_sequence_backup),0)) WHERE name='departments_assign';
DROP TABLE crm_assignment_sequence_backup;
CREATE INDEX idx_departments_latest ON departments_assign(task_id,department,id DESC);
CREATE INDEX idx_departments_user ON departments_assign(user_id,task_id);
ALTER TABLE accounts ADD COLUMN actor_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT;
CREATE TABLE crm_department_work_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  department TEXT NOT NULL CHECK(department IN ('Electrical','Civil','PM','Switchgear','Maintenance')),
  assignment_id INTEGER NOT NULL REFERENCES departments_assign(id) ON DELETE RESTRICT,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  authority TEXT,
  scope TEXT,
  status TEXT NOT NULL,
  comments TEXT,
  notes TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE INDEX idx_department_logs_task ON crm_department_work_logs(task_id,department,id DESC);
CREATE TRIGGER crm_department_logs_no_update BEFORE UPDATE ON crm_department_work_logs
BEGIN SELECT RAISE(ABORT,'Work logs are immutable'); END;
CREATE TRIGGER crm_department_logs_no_delete BEFORE DELETE ON crm_department_work_logs
BEGIN SELECT RAISE(ABORT,'Work logs are immutable'); END;
CREATE TABLE crm_department_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  department TEXT NOT NULL CHECK(department IN ('Electrical','Civil','PM','Switchgear','Maintenance','Accounts')),
  action TEXT NOT NULL CHECK(action IN ('departments.assign','departments.unassign','accounts.assign','departments.status','departments.log')),
  target_id TEXT NOT NULL,
  changed_fields TEXT NOT NULL CHECK(json_valid(changed_fields) AND json_type(changed_fields)='array'),
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE INDEX idx_department_audit_task ON crm_department_audit_events(task_id,id);
CREATE TRIGGER crm_department_audit_no_update BEFORE UPDATE ON crm_department_audit_events
BEGIN SELECT RAISE(ABORT,'Audit records are immutable'); END;
CREATE TRIGGER crm_department_audit_no_delete BEFORE DELETE ON crm_department_audit_events
BEGIN SELECT RAISE(ABORT,'Audit records are immutable'); END;
`;
