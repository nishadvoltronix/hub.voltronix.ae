// Read models verified in Admin.php:12-94,426-489,1926-2004,
// Task_model.php:440-479 and Leads_Pipeline/{Pipeline,Search_Agent_Pipeline,Lead_Details}.php.
// This extends the new SQLite schema; it does not import or reconstruct old records.
export const LEADS_SCHEMA_SQL = `
ALTER TABLE tasks ADD COLUMN account_name TEXT;
ALTER TABLE tasks ADD COLUMN customer_name TEXT;
ALTER TABLE tasks ADD COLUMN customer_email TEXT;
ALTER TABLE tasks ADD COLUMN customer_contact TEXT;
ALTER TABLE tasks ADD COLUMN address TEXT;
ALTER TABLE tasks ADD COLUMN complaint_info TEXT;
ALTER TABLE tasks ADD COLUMN remark TEXT;
ALTER TABLE tasks ADD COLUMN notes TEXT;
ALTER TABLE tasks ADD COLUMN assign_notes TEXT;
ALTER TABLE tasks ADD COLUMN owner_id TEXT;
ALTER TABLE tasks ADD COLUMN deal_number TEXT;
ALTER TABLE tasks ADD COLUMN enq_number TEXT;
ALTER TABLE tasks ADD COLUMN qual_deal_number TEXT;
ALTER TABLE tasks ADD COLUMN site_deal_number TEXT;
ALTER TABLE tasks ADD COLUMN quote_deal_number TEXT;
ALTER TABLE tasks ADD COLUMN job_deal_number TEXT;
ALTER TABLE tasks ADD COLUMN lost_deal_number TEXT;
ALTER TABLE tasks ADD COLUMN enq_deal_date TEXT;
ALTER TABLE tasks ADD COLUMN qual_deal_date TEXT;
ALTER TABLE tasks ADD COLUMN site_deal_date TEXT;
ALTER TABLE tasks ADD COLUMN quote_deal_date TEXT;
ALTER TABLE tasks ADD COLUMN job_deal_date TEXT;
ALTER TABLE tasks ADD COLUMN lost_deal_date TEXT;
ALTER TABLE tasks ADD COLUMN quote_number TEXT;
ALTER TABLE tasks ADD COLUMN service_charge TEXT;
ALTER TABLE tasks ADD COLUMN Job_Status TEXT;
CREATE INDEX idx_tasks_pipeline_status ON tasks(status, created_at DESC, id DESC);
CREATE INDEX idx_tasks_pipeline_owner ON tasks(assigned_to, created_at DESC, id DESC);
CREATE TABLE job_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id TEXT NOT NULL REFERENCES tasks(zoho_crm_id) ON DELETE RESTRICT,
  note_title TEXT NOT NULL,
  note_content TEXT NOT NULL,
  zoho_note_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE INDEX idx_job_notes_deal ON job_notes(deal_id, created_at DESC, id DESC);
CREATE TABLE tasks_status_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  Task_ID INTEGER NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  User_ID INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  Status TEXT NOT NULL,
  Task_Log_Create_Date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE INDEX idx_task_status_history ON tasks_status_log(Task_ID, Task_Log_Create_Date DESC, id DESC);
`;
