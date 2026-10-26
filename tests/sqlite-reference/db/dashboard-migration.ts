// Admin::pending_accounts_summary reads received_amount; Jobs::assign_accounts_department
// writes job-account assignments. This is not the Zoho customer Accounts entity.
// Nullable values preserve absence; no payment event or financial history is seeded.
export const DASHBOARD_SCHEMA_SQL = `
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  assigned_by_id TEXT,
  assigned_time TEXT,
  payment_status TEXT,
  received_amount TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE INDEX idx_accounts_task ON accounts(task_id);
CREATE INDEX idx_tasks_created ON tasks(created_at);
`;
