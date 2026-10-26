import { mysqlDepartmentAttachmentSchemaStatements, mysqlLocalWorkflowSchemaStatements } from "./workflow-schema.js";
import { mysqlZohoWorkflowSchemaStatements } from "./zoho-schema.js";
import { mysqlInboundSchemaStatements } from "./inbound-schema.js";

/**
 * New MySQL application schema, derived from the implemented Next.js contracts.
 * This is not recovered legacy MySQL DDL and does not import or seed CRM records.
 * The old SQLite migration lineage remains immutable preservation material.
 */
const options = "ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin";
const timestamp = "VARCHAR(32) NOT NULL DEFAULT (DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i:%s'))";
const version = "BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1 AND version <= 9007199254740991)";
const changedFields = "LONGTEXT NOT NULL CHECK (JSON_VALID(changed_fields) AND JSON_TYPE(changed_fields) = 'ARRAY')";
const objectReferences = "LONGTEXT NOT NULL DEFAULT ('{}') CHECK (JSON_VALID(remote_references) AND JSON_TYPE(remote_references) = 'OBJECT')";

function table(name: string, body: string): string { return `CREATE TABLE ${name} (${body}\n) ${options}`; }
function immutable(tableName: string, prefix: string, message = "Audit records are immutable"): string[] {
  return ["UPDATE", "DELETE"].map((action) => `CREATE TRIGGER ${prefix}_no_${action.toLowerCase()} BEFORE ${action} ON ${tableName}
    FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${message}'`);
}

export const mysqlFoundationExpectedTables = [
  "users", "permission_groups", "permissions", "admin_user_permissions", "tasks", "departments_assign",
  "crm_sessions", "crm_login_attempts", "crm_audit_events", "job_notes", "tasks_status_log", "accounts",
  "crm_job_audit_events", "crm_lead_operations", "crm_lead_audit_events", "crm_department_work_logs",
  "crm_department_audit_events", "task_attachment", "crm_attachment_audit_events", "products", "crm_quotations",
  "proposal_items", "crm_commercial_operations", "crm_commercial_audit_events", "crm_department_log_attachments",
  "crm_department_log_attachment_audit_events", "crm_app_lock",
] as const;

/** Additive single statements. Only crm_app_lock's technical singleton is seeded. */
export const mysqlApplicationSchemaStatements: readonly string[] = [
  table("users", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(100) UNIQUE,
    username VARCHAR(120) NOT NULL,
    email VARCHAR(254) COLLATE utf8mb4_0900_as_ci NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    department VARCHAR(100), department_role VARCHAR(100), role VARCHAR(100),
    quote_access TINYINT NOT NULL DEFAULT 0 CHECK (quote_access IN (0, 1)),
    created_at ${timestamp}, updated_at ${timestamp},
    version ${version},
    grants_version BIGINT NOT NULL DEFAULT 1 CHECK (grants_version >= 1 AND grants_version <= 9007199254740991),
    department_assigned_by BIGINT, department_assigned_date VARCHAR(32),
    company TEXT, sale_name TEXT,
    FOREIGN KEY (department_assigned_by) REFERENCES users(id) ON DELETE RESTRICT`),
  table("permission_groups", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    \`key\` VARCHAR(120) NOT NULL UNIQUE,
    label VARCHAR(200) NOT NULL, sort_order INT NOT NULL DEFAULT 0,
    version ${version}`),
  table("permissions", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    \`key\` VARCHAR(120) NOT NULL UNIQUE,
    label VARCHAR(200) NOT NULL, group_id BIGINT, description TEXT,
    version ${version},
    FOREIGN KEY (group_id) REFERENCES permission_groups(id) ON DELETE RESTRICT`),
  table("admin_user_permissions", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    admin_user_id BIGINT NOT NULL, permission_id BIGINT NOT NULL,
    UNIQUE (admin_user_id, permission_id),
    FOREIGN KEY (admin_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE`),
  table("tasks", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    zoho_crm_id VARCHAR(100) UNIQUE, assigned_to VARCHAR(100), deal_crm_created_by BIGINT,
    deal_name TEXT NOT NULL, status VARCHAR(100) NOT NULL,
    created_at ${timestamp}, updated_at ${timestamp},
    account_name TEXT, customer_name TEXT, customer_email TEXT, customer_contact TEXT,
    address TEXT, complaint_info TEXT, remark TEXT, notes LONGTEXT, assign_notes TEXT,
    owner_id VARCHAR(100), deal_number VARCHAR(200), enq_number VARCHAR(200),
    qual_deal_number VARCHAR(200), site_deal_number VARCHAR(200), quote_deal_number VARCHAR(200),
    job_deal_number VARCHAR(200), lost_deal_number VARCHAR(200),
    enq_deal_date VARCHAR(32), qual_deal_date VARCHAR(32), site_deal_date VARCHAR(32),
    quote_deal_date VARCHAR(32), job_deal_date VARCHAR(32), lost_deal_date VARCHAR(32),
    quote_number VARCHAR(200), service_charge VARCHAR(80), Job_Status VARCHAR(100),
    Admin_Remarks TEXT, hold_by VARCHAR(100), version ${version},
    quote_id VARCHAR(100), p_box TEXT, trn TEXT, tax_total VARCHAR(80),
    FOREIGN KEY (assigned_to) REFERENCES users(user_id) ON DELETE RESTRICT,
    FOREIGN KEY (deal_crm_created_by) REFERENCES users(id) ON DELETE RESTRICT,
    INDEX idx_tasks_assigned_to (assigned_to),
    INDEX idx_tasks_pipeline_status (status, created_at DESC, id DESC),
    INDEX idx_tasks_pipeline_owner (assigned_to, created_at DESC, id DESC),
    INDEX idx_tasks_created (created_at)`),
  table("departments_assign", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    task_id BIGINT NOT NULL, user_id BIGINT, department VARCHAR(100) NOT NULL,
    status VARCHAR(100) NOT NULL DEFAULT 'Assigned', assigned_by BIGINT,
    assigned_date VARCHAR(32), assigned_time VARCHAR(32), notes TEXT,
    created_at ${timestamp}, updated_at ${timestamp}, assigned_by_external VARCHAR(100), version ${version},
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE RESTRICT,
    INDEX idx_departments_latest (task_id, department, id DESC),
    INDEX idx_departments_user (user_id, task_id)`),
  table("crm_sessions", `
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    user_id BIGINT NOT NULL,
    csrf_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    password_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at BIGINT NOT NULL CHECK (created_at >= 0 AND created_at <= 9007199254740991),
    expires_at BIGINT NOT NULL,
    CHECK (expires_at > created_at AND expires_at <= 9007199254740991),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_sessions_user (user_id), INDEX idx_sessions_expiry (expires_at)`),
  table("crm_login_attempts", `
    bucket VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    window_start BIGINT NOT NULL CHECK (window_start >= 0 AND window_start <= 9007199254740991),
    attempts INT NOT NULL CHECK (attempts >= 0),
    INDEX idx_login_attempts_window (window_start)`),
  table("crm_audit_events", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    actor_user_id BIGINT NOT NULL,
    target_type VARCHAR(40) NOT NULL CHECK (target_type IN ('users', 'permission_groups', 'permissions')),
    target_id VARCHAR(100) NOT NULL,
    action VARCHAR(40) NOT NULL CHECK (action IN ('users.create','users.update','users.status','users.department',
      'groups.create','groups.update','permissions.create','permissions.update','grants.replace')),
    changed_fields ${changedFields}, occurred_at ${timestamp},
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    INDEX idx_audit_target (target_type, target_id, id), INDEX idx_audit_actor (actor_user_id, id)`),
  table("job_notes", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    deal_id VARCHAR(100) NOT NULL, note_title TEXT NOT NULL, note_content LONGTEXT NOT NULL,
    zoho_note_id VARCHAR(100) UNIQUE, created_at ${timestamp}, updated_at ${timestamp},
    FOREIGN KEY (deal_id) REFERENCES tasks(zoho_crm_id) ON DELETE RESTRICT,
    INDEX idx_job_notes_deal (deal_id, created_at DESC, id DESC)`),
  table("tasks_status_log", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    Task_ID BIGINT NOT NULL, User_ID BIGINT, Status VARCHAR(100) NOT NULL,
    Task_Log_Create_Date ${timestamp},
    FOREIGN KEY (Task_ID) REFERENCES tasks(id) ON DELETE RESTRICT,
    FOREIGN KEY (User_ID) REFERENCES users(id) ON DELETE RESTRICT,
    INDEX idx_task_status_history (Task_ID, Task_Log_Create_Date DESC, id DESC)`),
  table("accounts", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    task_id BIGINT NOT NULL, user_id BIGINT, assigned_by_id VARCHAR(100), assigned_time VARCHAR(32),
    payment_status VARCHAR(100), received_amount VARCHAR(80), created_at ${timestamp}, actor_user_id BIGINT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    INDEX idx_accounts_task (task_id)`),
  table("crm_job_audit_events", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, actor_user_id BIGINT NOT NULL, task_id BIGINT NOT NULL,
    action VARCHAR(40) NOT NULL CHECK (action IN ('jobs.status', 'jobs.remarks')),
    changed_fields ${changedFields}, occurred_at ${timestamp},
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    INDEX idx_job_audit_task (task_id, id), INDEX idx_job_audit_actor (actor_user_id, id)`),
  table("crm_lead_operations", `
    operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    actor_user_id BIGINT NOT NULL, task_id BIGINT,
    kind VARCHAR(40) NOT NULL CHECK (kind IN ('lead.stage','note.create','note.edit','deal.create')),
    request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (CHAR_LENGTH(request_hash)=64),
    state VARCHAR(20) NOT NULL CHECK (state IN ('inflight','completed','reconciliation')),
    remote_effect_possible TINYINT NOT NULL DEFAULT 0 CHECK (remote_effect_possible IN (0,1)),
    remote_id VARCHAR(100), remote_references ${objectReferences},
    result_task_id BIGINT, result_note_id BIGINT, result_version BIGINT,
    created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL,
    busy_task_id BIGINT GENERATED ALWAYS AS (CASE WHEN state <> 'completed' THEN task_id ELSE NULL END) STORED,
    busy_actor_id BIGINT GENERATED ALWAYS AS (CASE WHEN state <> 'completed' AND kind='deal.create' THEN actor_user_id ELSE NULL END) STORED,
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    FOREIGN KEY (result_task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    FOREIGN KEY (result_note_id) REFERENCES job_notes(id) ON DELETE RESTRICT,
    UNIQUE INDEX idx_lead_operation_busy_task (busy_task_id), UNIQUE INDEX idx_deal_operation_busy_actor (busy_actor_id),
    INDEX idx_lead_operation_actor (actor_user_id, created_at)`),
  table("crm_lead_audit_events", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, actor_user_id BIGINT NOT NULL, task_id BIGINT NOT NULL,
    operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
    action VARCHAR(40) NOT NULL CHECK (action IN ('lead.stage','note.create','note.edit','deal.create')),
    changed_fields ${changedFields}, occurred_at VARCHAR(32) NOT NULL,
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    FOREIGN KEY (operation_id) REFERENCES crm_lead_operations(operation_id) ON DELETE RESTRICT,
    INDEX idx_lead_audit_task (task_id, id)`),
  table("crm_department_work_logs", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, task_id BIGINT NOT NULL,
    department VARCHAR(40) NOT NULL CHECK (department IN ('Electrical','Civil','PM','Switchgear','Maintenance')),
    assignment_id BIGINT NOT NULL, actor_user_id BIGINT NOT NULL,
    authority TEXT, scope TEXT, status VARCHAR(100) NOT NULL, comments TEXT, notes LONGTEXT NOT NULL,
    created_at ${timestamp},
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    FOREIGN KEY (assignment_id) REFERENCES departments_assign(id) ON DELETE RESTRICT,
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    INDEX idx_department_logs_task (task_id, department, id DESC)`),
  table("crm_department_audit_events", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, actor_user_id BIGINT NOT NULL, task_id BIGINT NOT NULL,
    department VARCHAR(40) NOT NULL CHECK (department IN ('Electrical','Civil','PM','Switchgear','Maintenance','Accounts')),
    action VARCHAR(40) NOT NULL CHECK (action IN ('departments.assign','departments.unassign','accounts.assign','departments.status','departments.log')),
    target_id VARCHAR(100) NOT NULL, changed_fields ${changedFields}, occurred_at ${timestamp},
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    INDEX idx_department_audit_task (task_id, id)`),
  table("task_attachment", `
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, task_id BIGINT NOT NULL,
    user_id VARCHAR(100), uploaded_by BIGINT NOT NULL, file_name VARCHAR(255) NOT NULL, media_type VARCHAR(100) NOT NULL,
    file_size INT NOT NULL CHECK (file_size > 0 AND file_size <= 16384000),
    content_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    content MEDIUMBLOB NOT NULL, created_at ${timestamp},
    CHECK (OCTET_LENGTH(content)=file_size),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE RESTRICT,
    INDEX idx_task_attachment_parent (task_id, created_at DESC, id)`),
  table("crm_attachment_audit_events", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, actor_user_id BIGINT NOT NULL, task_id BIGINT NOT NULL,
    attachment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    action VARCHAR(40) NOT NULL CHECK (action='attachments.create'), occurred_at ${timestamp},
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    FOREIGN KEY (attachment_id) REFERENCES task_attachment(id) ON DELETE RESTRICT`),
  table("products", `
    product_id VARCHAR(100) PRIMARY KEY, product_name VARCHAR(200) NOT NULL, description LONGTEXT,
    unit_price VARCHAR(80), version ${version}, created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL,
    INDEX idx_products_name (product_name, product_id)`),
  table("crm_quotations", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, task_id BIGINT NOT NULL UNIQUE,
    external_id VARCHAR(100) NOT NULL UNIQUE, quote_number VARCHAR(200) NOT NULL,
    header_json LONGTEXT NOT NULL CHECK (JSON_VALID(header_json) AND JSON_TYPE(header_json)='OBJECT'),
    totals_json LONGTEXT NOT NULL CHECK (JSON_VALID(totals_json) AND JSON_TYPE(totals_json)='OBJECT'),
    calculation_policy VARCHAR(40) NOT NULL CHECK (calculation_policy='percentage-create-v1'), version ${version},
    remote_modified_at VARCHAR(64) NOT NULL, created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL,
    UNIQUE (id, task_id), FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    INDEX idx_quotations_number (quote_number, id)`),
  table("proposal_items", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, quotation_id BIGINT NOT NULL, task_id BIGINT NOT NULL,
    position INT NOT NULL CHECK (position >= 0 AND position < 200), product_id VARCHAR(100) NOT NULL,
    product_name VARCHAR(200) NOT NULL, product_description LONGTEXT NOT NULL, uom VARCHAR(100) NOT NULL,
    quantity VARCHAR(80) NOT NULL, service_charge VARCHAR(80) NOT NULL, item_discount VARCHAR(80) NOT NULL, total VARCHAR(80) NOT NULL,
    UNIQUE (quotation_id, position),
    FOREIGN KEY (quotation_id) REFERENCES crm_quotations(id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE RESTRICT,
    FOREIGN KEY (quotation_id, task_id) REFERENCES crm_quotations(id, task_id) ON DELETE RESTRICT,
    INDEX idx_proposal_items_task (task_id, quotation_id, position)`),
  table("crm_commercial_operations", `
    operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, actor_user_id BIGINT NOT NULL, task_id BIGINT,
    kind VARCHAR(40) NOT NULL CHECK (kind IN ('product.create','quote.create','quote.edit')),
    request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (CHAR_LENGTH(request_hash)=64),
    state VARCHAR(20) NOT NULL CHECK (state IN ('inflight','completed','reconciliation')),
    remote_effect_possible TINYINT NOT NULL DEFAULT 0 CHECK (remote_effect_possible IN (0,1)),
    remote_references ${objectReferences},
    result_json LONGTEXT CHECK (result_json IS NULL OR (JSON_VALID(result_json) AND JSON_TYPE(result_json)='OBJECT')),
    created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL,
    busy_task_id BIGINT GENERATED ALWAYS AS (CASE WHEN state <> 'completed' THEN task_id ELSE NULL END) STORED,
    busy_actor_id BIGINT GENERATED ALWAYS AS (CASE WHEN state <> 'completed' AND kind='product.create' THEN actor_user_id ELSE NULL END) STORED,
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    UNIQUE INDEX idx_commercial_busy_task (busy_task_id), UNIQUE INDEX idx_product_busy_actor (busy_actor_id)`),
  table("crm_commercial_audit_events", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, actor_user_id BIGINT NOT NULL, task_id BIGINT,
    operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
    action VARCHAR(40) NOT NULL CHECK (action IN ('product.create','quote.create','quote.edit')),
    target_id VARCHAR(100) NOT NULL, changed_fields ${changedFields}, occurred_at VARCHAR(32) NOT NULL,
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    FOREIGN KEY (operation_id) REFERENCES crm_commercial_operations(operation_id) ON DELETE RESTRICT`),
  table("crm_department_log_attachments", `
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, log_id BIGINT NOT NULL UNIQUE,
    uploaded_by BIGINT NOT NULL, file_name VARCHAR(255) NOT NULL, media_type VARCHAR(100) NOT NULL,
    file_size INT NOT NULL CHECK (file_size > 0 AND file_size <= 16384000),
    content_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    content MEDIUMBLOB NOT NULL, created_at ${timestamp},
    CHECK (OCTET_LENGTH(content)=file_size),
    FOREIGN KEY (log_id) REFERENCES crm_department_work_logs(id) ON DELETE RESTRICT,
    FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE RESTRICT`),
  table("crm_department_log_attachment_audit_events", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, actor_user_id BIGINT NOT NULL, log_id BIGINT NOT NULL,
    attachment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    action VARCHAR(40) NOT NULL CHECK (action='log_attachments.create'), occurred_at ${timestamp},
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (log_id) REFERENCES crm_department_work_logs(id) ON DELETE RESTRICT,
    FOREIGN KEY (attachment_id) REFERENCES crm_department_log_attachments(id) ON DELETE RESTRICT,
    INDEX idx_log_attachment_audit_parent (log_id, id)`),
  table("crm_app_lock", "id TINYINT NOT NULL PRIMARY KEY CHECK (id=1)"),
  "INSERT INTO crm_app_lock(id) VALUES (1)",
  ...immutable("crm_audit_events", "crm_audit_events"),
  ...immutable("crm_job_audit_events", "crm_job_audit_events"),
  ...immutable("crm_lead_audit_events", "crm_lead_audit"),
  ...immutable("crm_department_work_logs", "crm_department_logs", "Work logs are immutable"),
  ...immutable("crm_department_audit_events", "crm_department_audit"),
  ...immutable("crm_attachment_audit_events", "crm_attachment_audit"),
  ...immutable("crm_commercial_audit_events", "crm_commercial_audit"),
  `CREATE TRIGGER crm_log_attachment_parent BEFORE INSERT ON crm_department_log_attachments FOR EACH ROW
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM crm_department_work_logs l WHERE l.id=NEW.log_id AND l.actor_user_id=NEW.uploaded_by) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Attachment author must match work log';
      END IF;
    END`,
  ...immutable("crm_department_log_attachments", "crm_log_attachment", "Log attachments are immutable"),
  ...immutable("crm_department_log_attachment_audit_events", "crm_log_attachment_audit"),
];

export const mysqlFoundationExpectedTriggers = mysqlApplicationSchemaStatements.flatMap((statement) => {
  const match = /^CREATE TRIGGER ([a-z_]+) /u.exec(statement);
  return match ? [match[1]!] : [];
});

export const mysqlFoundationExpectedIndexes = mysqlApplicationSchemaStatements.flatMap((statement) => {
  const tableName = /^CREATE TABLE ([a-z_]+) /u.exec(statement)?.[1];
  if (!tableName) return [];
  return [...statement.matchAll(/(UNIQUE )?INDEX ([a-z_]+) \(([^)]+)\)/gu)].map((match) => ({
    table: tableName, name: match[2]!, unique: !!match[1],
    columns: match[3]!.split(",").map((column) => column.trim().replace(/ DESC$/u, "")),
  }));
});

export const mysqlExpectedTables = [...mysqlFoundationExpectedTables,
  "crm_local_operations", "crm_local_tasks", "crm_local_notes", "crm_local_audit", "crm_percentage_quotations",
  "crm_zoho_quotations", "crm_zoho_quotation_items", "crm_zoho_user_bindings", "crm_zoho_user_binding_audit",
  "crm_zoho_sync_source", "crm_zoho_sync_runs", "crm_zoho_sync_records", "crm_zoho_sync_events", "crm_zoho_inbound_quotations"] as const;
export const mysqlExpectedTriggers = [...mysqlFoundationExpectedTriggers,
  ...[...mysqlLocalWorkflowSchemaStatements, ...mysqlDepartmentAttachmentSchemaStatements, ...mysqlZohoWorkflowSchemaStatements, ...mysqlInboundSchemaStatements].flatMap(statement => {
    const name = /^CREATE TRIGGER ([a-z_]+) /u.exec(statement)?.[1];
    return name ? [name] : [];
  })];
export const mysqlExpectedIndexes = [...mysqlFoundationExpectedIndexes, ...[...mysqlLocalWorkflowSchemaStatements, ...mysqlZohoWorkflowSchemaStatements, ...mysqlInboundSchemaStatements].flatMap(statement => {
  const tableName = /^CREATE TABLE ([a-z_]+) /u.exec(statement)?.[1];
  if (!tableName) return [];
  return [...statement.matchAll(/(UNIQUE )?INDEX ([a-z_]+) \(([^)]+)\)/gu)].map(match => ({
    table: tableName, name: match[2]!, unique: !!match[1],
    columns: match[3]!.split(",").map(column => column.trim().replace(/ DESC$/u, "")),
  }));
})];
