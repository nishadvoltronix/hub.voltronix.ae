// Admincrm::update_attachments_files / Admin::add_task_attachments.
// New bytes live in private SQLite so metadata, content and audit commit/backup together.
export const ATTACHMENTS_SCHEMA_SQL = `
CREATE TABLE task_attachment (
  id TEXT PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  user_id TEXT,
  uploaded_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  file_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK(file_size>0 AND file_size<=16384000),
  content_sha256 TEXT NOT NULL,
  content BLOB NOT NULL CHECK(length(content)=file_size),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE INDEX idx_task_attachment_parent ON task_attachment(task_id,created_at DESC,id);
CREATE TABLE crm_attachment_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  attachment_id TEXT NOT NULL REFERENCES task_attachment(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action='attachments.create'),
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE TRIGGER crm_attachment_audit_no_update BEFORE UPDATE ON crm_attachment_audit_events
BEGIN SELECT RAISE(ABORT,'Audit records are immutable'); END;
CREATE TRIGGER crm_attachment_audit_no_delete BEFORE DELETE ON crm_attachment_audit_events
BEGIN SELECT RAISE(ABORT,'Audit records are immutable'); END;
`;
