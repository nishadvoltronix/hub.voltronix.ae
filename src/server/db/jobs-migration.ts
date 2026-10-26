// Fully local writes: Jobs::hold_full_job and Jobs::save_admin_remarks.
// hold_by stores the source external identity, while the new immutable audit records
// the authenticated local identity even for an account with no external linkage.
export const JOBS_SCHEMA_SQL = `
ALTER TABLE tasks ADD COLUMN Admin_Remarks TEXT;
ALTER TABLE tasks ADD COLUMN hold_by TEXT;
ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
CREATE TABLE crm_job_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('jobs.status', 'jobs.remarks')),
  changed_fields TEXT NOT NULL CHECK (json_valid(changed_fields) AND json_type(changed_fields)='array'),
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE INDEX idx_job_audit_task ON crm_job_audit_events(task_id,id);
CREATE INDEX idx_job_audit_actor ON crm_job_audit_events(actor_user_id,id);
CREATE TRIGGER crm_job_audit_events_no_update BEFORE UPDATE ON crm_job_audit_events
BEGIN SELECT RAISE(ABORT, 'Audit records are immutable'); END;
CREATE TRIGGER crm_job_audit_events_no_delete BEFORE DELETE ON crm_job_audit_events
BEGIN SELECT RAISE(ABORT, 'Audit records are immutable'); END;
`;
