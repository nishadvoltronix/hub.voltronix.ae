/** Additive inbound observations. Historical source values are retained exactly;
 * this lineage never changes v1-v4 tables, triggers, quote policies or checksums. */
const options = "ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin";
const id = (name: string) => `${name} VARCHAR(30) NOT NULL CHECK (${name} REGEXP '^[1-9][0-9]{0,29}$')`;
const object = (name: string) => `${name} LONGTEXT NOT NULL CHECK (JSON_VALID(${name}) AND JSON_TYPE(${name})='OBJECT')`;
const optionalObject = (name: string) => `${name} LONGTEXT NULL CHECK (${name} IS NULL OR (JSON_VALID(${name}) AND JSON_TYPE(${name})='OBJECT'))`;
const hash = (name: string, nullable = false) => `${name} CHAR(64) CHARACTER SET ascii COLLATE ascii_bin ${nullable ? "NULL" : "NOT NULL"}`;
const uuid = (name: string) => `${name} CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL`;
const moduleName = "module_api_name VARCHAR(20) NOT NULL CHECK (module_api_name IN ('Products','Deals','Notes','Quotes','VZ_app_users'))";
const table = (name: string, body: string) => `CREATE TABLE ${name} (${body}\n) ${options}`;
const immutable = (name: string) => ["UPDATE", "DELETE"].map(action => `CREATE TRIGGER ${name}_no_${action.toLowerCase()} BEFORE ${action} ON ${name}
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Inbound sync evidence is immutable'`);

export const mysqlInboundSchemaStatements: readonly string[] = [
  "ALTER TABLE products MODIFY product_name VARCHAR(255) NOT NULL",
  "ALTER TABLE proposal_items MODIFY product_name VARCHAR(255) NOT NULL",
  "ALTER TABLE crm_zoho_quotation_items MODIFY product_name VARCHAR(255) NOT NULL",
  table("crm_zoho_sync_source", `
    id TINYINT NOT NULL PRIMARY KEY CHECK (id=1), ${id("organization_id")},
    profile VARCHAR(60) NOT NULL CHECK (profile='voltronix-inbound-v1'),
    generation BIGINT NOT NULL DEFAULT 0 CHECK (generation>=0 AND generation<=9007199254740991),
    watermark VARCHAR(32) NULL, last_attempt_at VARCHAR(32) NULL, last_success_at VARCHAR(32) NULL,
    last_state VARCHAR(16) NOT NULL CHECK (last_state IN ('idle','running','partial','ready','failed')),
    ${optionalObject("last_counts_json")}, last_error VARCHAR(60) NULL,
    lease_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL, lease_principal_id BIGINT NULL,
    lease_started_at VARCHAR(32) NULL, lease_expires_at VARCHAR(32) NULL,
    CHECK ((lease_id IS NULL AND lease_principal_id IS NULL AND lease_started_at IS NULL AND lease_expires_at IS NULL)
      OR (lease_id IS NOT NULL AND lease_principal_id IS NOT NULL AND lease_started_at IS NOT NULL AND lease_expires_at IS NOT NULL)),
    FOREIGN KEY (lease_principal_id) REFERENCES users(id) ON DELETE RESTRICT,
    UNIQUE INDEX idx_zoho_sync_org (organization_id)`),
  table("crm_zoho_sync_runs", `
    ${uuid("run_id")} PRIMARY KEY, ${id("organization_id")}, principal_id BIGINT NOT NULL,
    profile VARCHAR(60) NOT NULL CHECK (profile='voltronix-inbound-v1'),
    state VARCHAR(16) NOT NULL CHECK (state IN ('completed','partial','failed')),
    started_at VARCHAR(32) NOT NULL, completed_at VARCHAR(32) NOT NULL,
    generation_before BIGINT NOT NULL CHECK (generation_before>=0), generation_after BIGINT NOT NULL,
    watermark VARCHAR(32) NULL, ${hash("source_hash", true)}, ${object("counts_json")}, error_code VARCHAR(60) NULL,
    CHECK (generation_after>=generation_before),
    FOREIGN KEY (organization_id) REFERENCES crm_zoho_sync_source(organization_id) ON DELETE RESTRICT,
    FOREIGN KEY (principal_id) REFERENCES users(id) ON DELETE RESTRICT,
    INDEX idx_zoho_sync_run_time (organization_id,completed_at,run_id)`),
  table("crm_zoho_sync_records", `
    ${id("organization_id")}, ${moduleName}, ${id("external_id")},
    local_id VARCHAR(100) NULL, task_id BIGINT NULL,
    origin VARCHAR(16) NOT NULL CHECK (origin IN ('imported','native','directory')),
    state VARCHAR(16) NOT NULL CHECK (state IN ('active','deleted','conflict')), reason VARCHAR(60) NULL,
    source_created_at VARCHAR(32) NULL, source_modified_at VARCHAR(32) NOT NULL,
    ${hash("source_hash")}, ${object("source_json")}, ${hash("applied_hash", true)}, ${optionalObject("applied_json")},
    ${uuid("last_run_id")}, last_synced_at VARCHAR(32) NOT NULL,
    PRIMARY KEY (organization_id,module_api_name,external_id),
    UNIQUE INDEX idx_zoho_sync_local (module_api_name,local_id), INDEX idx_zoho_sync_task (task_id,module_api_name),
    FOREIGN KEY (organization_id) REFERENCES crm_zoho_sync_source(organization_id) ON DELETE RESTRICT,
    FOREIGN KEY (last_run_id) REFERENCES crm_zoho_sync_runs(run_id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT`),
  table("crm_zoho_sync_events", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, ${uuid("run_id")}, ${id("organization_id")}, ${moduleName}, ${id("external_id")},
    outcome VARCHAR(20) NOT NULL CHECK (outcome IN ('inserted','updated','unchanged','conflict','deleted','skipped')),
    reason VARCHAR(60) NULL, ${hash("source_hash")}, ${object("source_json")}, ${optionalObject("applied_json")}, occurred_at VARCHAR(32) NOT NULL,
    FOREIGN KEY (run_id) REFERENCES crm_zoho_sync_runs(run_id) ON DELETE RESTRICT,
    INDEX idx_zoho_sync_event_record (organization_id,module_api_name,external_id,id)`),
  table("crm_zoho_inbound_quotations", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, ${id("organization_id")}, ${id("external_id")},
    task_id BIGINT NULL, native_quote_id BIGINT NULL, quote_number VARCHAR(200) NULL, subject TEXT NOT NULL,
    subtotal VARCHAR(80) NULL, grand_total VARCHAR(80) NULL, tax VARCHAR(80) NULL, discount VARCHAR(80) NULL, adjustment VARCHAR(80) NULL,
    source_created_at VARCHAR(32) NOT NULL, source_modified_at VARCHAR(32) NOT NULL,
    ${object("snapshot_json")}, observed_at VARCHAR(32) NOT NULL,
    deleted TINYINT NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
    version BIGINT NOT NULL DEFAULT 1 CHECK (version>=1 AND version<=9007199254740991),
    UNIQUE INDEX idx_inbound_quote_external (organization_id,external_id), INDEX idx_inbound_quote_task (task_id,id),
    FOREIGN KEY (organization_id) REFERENCES crm_zoho_sync_source(organization_id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    FOREIGN KEY (native_quote_id) REFERENCES crm_zoho_quotations(id) ON DELETE RESTRICT`),
  ...immutable("crm_zoho_sync_runs"), ...immutable("crm_zoho_sync_events"),
  `CREATE TRIGGER crm_zoho_sync_source_identity BEFORE UPDATE ON crm_zoho_sync_source FOR EACH ROW
    BEGIN
      IF NOT (NEW.id <=> OLD.id) OR NOT (NEW.organization_id <=> OLD.organization_id) OR NOT (NEW.profile <=> OLD.profile)
        OR NEW.generation<OLD.generation THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Inbound source identity is immutable';
      END IF;
    END`,
  `CREATE TRIGGER crm_zoho_sync_source_no_delete BEFORE DELETE ON crm_zoho_sync_source
    FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Inbound source cannot be deleted'`,
  `CREATE TRIGGER crm_zoho_sync_record_identity BEFORE UPDATE ON crm_zoho_sync_records FOR EACH ROW
    BEGIN
      IF NOT (NEW.organization_id <=> OLD.organization_id) OR NOT (NEW.module_api_name <=> OLD.module_api_name)
        OR NOT (NEW.external_id <=> OLD.external_id) OR NOT (NEW.origin <=> OLD.origin)
        OR (OLD.local_id IS NOT NULL AND NOT (NEW.local_id <=> OLD.local_id))
        OR (OLD.task_id IS NOT NULL AND NOT (NEW.task_id <=> OLD.task_id)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Inbound record identity is immutable';
      END IF;
    END`,
  `CREATE TRIGGER crm_zoho_sync_record_no_delete BEFORE DELETE ON crm_zoho_sync_records
    FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Inbound records retain deletion evidence'`,
  `CREATE TRIGGER crm_zoho_inbound_quote_identity BEFORE UPDATE ON crm_zoho_inbound_quotations FOR EACH ROW
    BEGIN
      IF NOT (NEW.id <=> OLD.id) OR NOT (NEW.organization_id <=> OLD.organization_id) OR NOT (NEW.external_id <=> OLD.external_id)
        OR (OLD.task_id IS NOT NULL AND NOT (NEW.task_id <=> OLD.task_id))
        OR NOT (NEW.native_quote_id <=> OLD.native_quote_id) OR NOT (NEW.source_created_at <=> OLD.source_created_at) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Historical inbound quotation identity is immutable';
      END IF;
    END`,
  `CREATE TRIGGER crm_zoho_inbound_quote_no_delete BEFORE DELETE ON crm_zoho_inbound_quotations
    FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Historical inbound quotations cannot be deleted'`,
];
