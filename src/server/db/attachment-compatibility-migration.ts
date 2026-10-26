/** M1–9 remain immutable. This one known table is rebuilt transactionally;
 * original rowids, bytes, references and audit rows are copied without changes. */
export const ATTACHMENT_COMPATIBILITY_SCHEMA_SQL = `
PRAGMA defer_foreign_keys=ON;
CREATE TEMP TABLE crm_log_compatibility_audit_copy AS
SELECT rowid AS original_rowid,* FROM crm_department_log_attachment_audit_events;
CREATE TEMP TABLE crm_log_compatibility_sequence_copy AS
SELECT rowid AS original_rowid,seq FROM sqlite_sequence WHERE name='crm_department_log_attachment_audit_events';
DROP TABLE crm_department_log_attachment_audit_events;
CREATE TABLE crm_log_attachment_compatibility_copy (
  id TEXT PRIMARY KEY,
  log_id INTEGER NOT NULL UNIQUE REFERENCES crm_department_work_logs(id) ON DELETE RESTRICT,
  uploaded_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  file_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK(file_size>0 AND file_size<=52428800),
  content_sha256 TEXT NOT NULL,
  content BLOB NOT NULL CHECK(length(content)=file_size),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
INSERT INTO crm_log_attachment_compatibility_copy(rowid,id,log_id,uploaded_by,file_name,media_type,file_size,content_sha256,content,created_at)
SELECT rowid,id,log_id,uploaded_by,file_name,media_type,file_size,content_sha256,content,created_at FROM crm_department_log_attachments;
DROP TABLE crm_department_log_attachments;
ALTER TABLE crm_log_attachment_compatibility_copy RENAME TO crm_department_log_attachments;
CREATE TRIGGER crm_log_attachment_parent BEFORE INSERT ON crm_department_log_attachments
WHEN NOT EXISTS(SELECT 1 FROM crm_department_work_logs l WHERE l.id=NEW.log_id AND l.actor_user_id=NEW.uploaded_by)
BEGIN SELECT RAISE(ABORT,'Attachment author must match work log'); END;
CREATE TRIGGER crm_log_attachment_no_update BEFORE UPDATE ON crm_department_log_attachments
BEGIN SELECT RAISE(ABORT,'Log attachments are immutable'); END;
CREATE TRIGGER crm_log_attachment_no_delete BEFORE DELETE ON crm_department_log_attachments
BEGIN SELECT RAISE(ABORT,'Log attachments are immutable'); END;
CREATE TRIGGER crm_log_attachment_department_limit BEFORE INSERT ON crm_department_log_attachments
WHEN NEW.file_size > CASE (SELECT department FROM crm_department_work_logs WHERE id=NEW.log_id)
  WHEN 'Electrical' THEN 52428800 WHEN 'Civil' THEN 52428800
  WHEN 'Switchgear' THEN 52428800 WHEN 'Maintenance' THEN 52428800 ELSE 16384000 END
BEGIN SELECT RAISE(ABORT,'Attachment exceeds department limit'); END;
CREATE TABLE crm_department_log_attachment_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  log_id INTEGER NOT NULL REFERENCES crm_department_work_logs(id) ON DELETE RESTRICT,
  attachment_id TEXT NOT NULL REFERENCES crm_department_log_attachments(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action='log_attachments.create'),
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
INSERT INTO crm_department_log_attachment_audit_events(rowid,id,actor_user_id,log_id,attachment_id,action,occurred_at)
SELECT original_rowid,id,actor_user_id,log_id,attachment_id,action,occurred_at FROM crm_log_compatibility_audit_copy;
UPDATE sqlite_sequence SET rowid=(SELECT original_rowid FROM crm_log_compatibility_sequence_copy),seq=(SELECT seq FROM crm_log_compatibility_sequence_copy)
WHERE name='crm_department_log_attachment_audit_events' AND EXISTS(SELECT 1 FROM crm_log_compatibility_sequence_copy);
INSERT INTO sqlite_sequence(rowid,name,seq)
SELECT original_rowid,'crm_department_log_attachment_audit_events',seq FROM crm_log_compatibility_sequence_copy
WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='crm_department_log_attachment_audit_events');
CREATE INDEX idx_log_attachment_audit_parent ON crm_department_log_attachment_audit_events(log_id,id);
CREATE TRIGGER crm_log_attachment_audit_no_update BEFORE UPDATE ON crm_department_log_attachment_audit_events
BEGIN SELECT RAISE(ABORT,'Audit records are immutable'); END;
CREATE TRIGGER crm_log_attachment_audit_no_delete BEFORE DELETE ON crm_department_log_attachment_audit_events
BEGIN SELECT RAISE(ABORT,'Audit records are immutable'); END;
DROP TABLE crm_log_compatibility_audit_copy;
DROP TABLE crm_log_compatibility_sequence_copy;
`;
