// Current commercial fields from Admincrm3318/4268 and proposal_items, plus explicit
// coordination/version/audit infrastructure. No historical rows or actor data are seeded.
export const COMMERCIAL_SCHEMA_SQL = `
ALTER TABLE tasks ADD COLUMN quote_id TEXT;
ALTER TABLE tasks ADD COLUMN p_box TEXT;
ALTER TABLE tasks ADD COLUMN trn TEXT;
ALTER TABLE tasks ADD COLUMN tax_total TEXT;
ALTER TABLE users ADD COLUMN company TEXT;
ALTER TABLE users ADD COLUMN sale_name TEXT;
CREATE TABLE products (
  product_id TEXT PRIMARY KEY,
  product_name TEXT NOT NULL,
  description TEXT,
  unit_price TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_products_name ON products(product_name,product_id);
CREATE TABLE crm_quotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
  external_id TEXT NOT NULL UNIQUE,
  quote_number TEXT NOT NULL,
  header_json TEXT NOT NULL CHECK(json_valid(header_json) AND json_type(header_json)='object'),
  totals_json TEXT NOT NULL CHECK(json_valid(totals_json) AND json_type(totals_json)='object'),
  calculation_policy TEXT NOT NULL CHECK(calculation_policy='percentage-create-v1'),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  remote_modified_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(id,task_id)
) STRICT;
CREATE INDEX idx_quotations_number ON crm_quotations(quote_number,id);
CREATE TABLE proposal_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id INTEGER NOT NULL REFERENCES crm_quotations(id) ON DELETE RESTRICT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK(position>=0 AND position<200),
  product_id TEXT NOT NULL REFERENCES products(product_id) ON DELETE RESTRICT,
  product_name TEXT NOT NULL,
  product_description TEXT NOT NULL,
  uom TEXT NOT NULL,
  quantity TEXT NOT NULL,
  service_charge TEXT NOT NULL,
  item_discount TEXT NOT NULL,
  total TEXT NOT NULL,
  UNIQUE(quotation_id,position),
  FOREIGN KEY(quotation_id,task_id) REFERENCES crm_quotations(id,task_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX idx_proposal_items_task ON proposal_items(task_id,quotation_id,position);
CREATE TABLE crm_commercial_operations (
  operation_id TEXT PRIMARY KEY,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  task_id INTEGER REFERENCES tasks(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('product.create','quote.create','quote.edit')),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  state TEXT NOT NULL CHECK(state IN ('inflight','completed','reconciliation')),
  remote_effect_possible INTEGER NOT NULL DEFAULT 0 CHECK(remote_effect_possible IN (0,1)),
  remote_references TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(remote_references) AND json_type(remote_references)='object'),
  result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND json_type(result_json)='object')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_commercial_busy_task ON crm_commercial_operations(task_id) WHERE state!='completed' AND task_id IS NOT NULL;
CREATE UNIQUE INDEX idx_product_busy_actor ON crm_commercial_operations(actor_user_id) WHERE state!='completed' AND kind='product.create';
CREATE TABLE crm_commercial_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  task_id INTEGER REFERENCES tasks(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL UNIQUE REFERENCES crm_commercial_operations(operation_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('product.create','quote.create','quote.edit')),
  target_id TEXT NOT NULL,
  changed_fields TEXT NOT NULL CHECK(json_valid(changed_fields) AND json_type(changed_fields)='array'),
  occurred_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER crm_commercial_audit_no_update BEFORE UPDATE ON crm_commercial_audit_events
BEGIN SELECT RAISE(ABORT,'Audit records are immutable'); END;
CREATE TRIGGER crm_commercial_audit_no_delete BEFORE DELETE ON crm_commercial_audit_events
BEGIN SELECT RAISE(ABORT,'Audit records are immutable'); END;
`;
