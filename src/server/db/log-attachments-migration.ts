// Optional file in the original five department work-log forms. Bytes deliberately
// live outside task_attachment so broad lead/task file access never grants log access.
export const LOG_ATTACHMENTS_SCHEMA_SQL = `
CREATE TABLE crm_department_log_attachments (
  id TEXT PRIMARY KEY,
  log_id INTEGER NOT NULL UNIQUE REFERENCES crm_department_work_logs(id) ON DELETE RESTRICT,
  uploaded_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  file_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK(file_size>0 AND file_size<=16384000),
  content_sha256 TEXT NOT NULL,
  content BLOB NOT NULL CHECK(length(content)=file_size),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE TRIGGER crm_log_attachment_parent BEFORE INSERT ON crm_department_log_attachments
WHEN NOT EXISTS(SELECT 1 FROM crm_department_work_logs l WHERE l.id=NEW.log_id AND l.actor_user_id=NEW.uploaded_by)
BEGIN SELECT RAISE(ABORT,'Attachment author must match work log'); END;
CREATE TRIGGER crm_log_attachment_no_update BEFORE UPDATE ON crm_department_log_attachments
BEGIN SELECT RAISE(ABORT,'Log attachments are immutable'); END;
CREATE TRIGGER crm_log_attachment_no_delete BEFORE DELETE ON crm_department_log_attachments
BEGIN SELECT RAISE(ABORT,'Log attachments are immutable'); END;
CREATE TABLE crm_department_log_attachment_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  log_id INTEGER NOT NULL REFERENCES crm_department_work_logs(id) ON DELETE RESTRICT,
  attachment_id TEXT NOT NULL REFERENCES crm_department_log_attachments(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action='log_attachments.create'),
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE INDEX idx_log_attachment_audit_parent ON crm_department_log_attachment_audit_events(log_id,id);
CREATE TRIGGER crm_log_attachment_audit_no_update BEFORE UPDATE ON crm_department_log_attachment_audit_events
BEGIN SELECT RAISE(ABORT,'Audit records are immutable'); END;
CREATE TRIGGER crm_log_attachment_audit_no_delete BEFORE DELETE ON crm_department_log_attachment_audit_events
BEGIN SELECT RAISE(ABORT,'Audit records are immutable'); END;
`;
