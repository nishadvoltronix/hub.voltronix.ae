// Durable coordination for remote-coupled writes, not historical imported business records.
export const LEAD_MUTATIONS_SCHEMA_SQL = `
CREATE TABLE crm_lead_operations (
  operation_id TEXT PRIMARY KEY,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  task_id INTEGER REFERENCES tasks(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('lead.stage','note.create','note.edit','deal.create')),
  request_hash TEXT NOT NULL CHECK (length(request_hash)=64),
  state TEXT NOT NULL CHECK (state IN ('inflight','completed','reconciliation')),
  remote_effect_possible INTEGER NOT NULL DEFAULT 0 CHECK (remote_effect_possible IN (0,1)),
  remote_id TEXT,
  remote_references TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(remote_references) AND json_type(remote_references)='object'),
  result_task_id INTEGER REFERENCES tasks(id) ON DELETE RESTRICT,
  result_note_id INTEGER REFERENCES job_notes(id) ON DELETE RESTRICT,
  result_version INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_lead_operation_busy_task ON crm_lead_operations(task_id) WHERE state!='completed' AND task_id IS NOT NULL;
CREATE UNIQUE INDEX idx_deal_operation_busy_actor ON crm_lead_operations(actor_user_id) WHERE state!='completed' AND kind='deal.create';
CREATE INDEX idx_lead_operation_actor ON crm_lead_operations(actor_user_id,created_at);
CREATE TABLE crm_lead_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL UNIQUE REFERENCES crm_lead_operations(operation_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('lead.stage','note.create','note.edit','deal.create')),
  changed_fields TEXT NOT NULL CHECK (json_valid(changed_fields) AND json_type(changed_fields)='array'),
  occurred_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_lead_audit_task ON crm_lead_audit_events(task_id,id);
CREATE TRIGGER crm_lead_audit_no_update BEFORE UPDATE ON crm_lead_audit_events
BEGIN SELECT RAISE(ABORT, 'Audit records are immutable'); END;
CREATE TRIGGER crm_lead_audit_no_delete BEFORE DELETE ON crm_lead_audit_events
BEGIN SELECT RAISE(ABORT, 'Audit records are immutable'); END;
`;
