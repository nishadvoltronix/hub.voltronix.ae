/** Additive outbound v8 persistence. Historical quotation checks/rows remain
 * unchanged; no imported identity or remote financial value is invented. */
const options = "ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin";
const version = "BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1 AND version <= 9007199254740991)";
const remoteId = (name: string) => `${name} VARCHAR(30) NOT NULL CHECK (${name} REGEXP '^[1-9][0-9]{0,29}$')`;
const object = (name: string) => `${name} LONGTEXT NOT NULL CHECK (JSON_VALID(${name}) AND JSON_TYPE(${name})='OBJECT')`;
function table(name: string, body: string) { return `CREATE TABLE ${name} (${body}\n) ${options}`; }
function immutable(name: string) {
  return ["UPDATE", "DELETE"].map(action => `CREATE TRIGGER ${name}_no_${action.toLowerCase()} BEFORE ${action} ON ${name}
    FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Verified binding and audit are immutable'`);
}
function exclusive(name: string, target: string, others: readonly string[], action: "INSERT" | "UPDATE") {
  return `CREATE TRIGGER ${name} BEFORE ${action} ON ${target} FOR EACH ROW
    BEGIN
      DECLARE pinned_task BIGINT;
      SELECT id INTO pinned_task FROM tasks WHERE id=NEW.task_id FOR UPDATE;
      IF ${others.map(other => `EXISTS(SELECT 1 FROM ${other} WHERE task_id=NEW.task_id OR quote_number=NEW.quote_number)`).join(" OR ")} THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='A different quotation lineage already exists';
      END IF;
    END`;
}
export const mysqlZohoWorkflowSchemaStatements: readonly string[] = [
  table("crm_zoho_quotations", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, task_id BIGINT NOT NULL UNIQUE,
    ${remoteId("organization_id")}, mapping_profile VARCHAR(80) NOT NULL CHECK (mapping_profile='voltronix-custom-quoted-items-v8'),
    ${remoteId("external_id")}, quote_number VARCHAR(200) NOT NULL UNIQUE,
    issuer_company TEXT NULL, issuer_salesperson VARCHAR(120) NULL,
    ${object("header_json")}, ${object("totals_json")}, ${object("snapshot_json")},
    calculation_policy VARCHAR(40) NOT NULL CHECK (calculation_policy='percentage-only-v2'), version ${version},
    remote_modified_at VARCHAR(64) NOT NULL, created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL,
    CHECK ((issuer_company IS NULL AND issuer_salesperson IS NULL) OR
      (issuer_company IS NOT NULL AND issuer_salesperson IS NOT NULL AND
       issuer_company IN ('VOLTRONIX CONTRACTING LLC','VOLTRONIX SWITCHGEAR LLC') AND CHAR_LENGTH(issuer_salesperson)>0)),
    UNIQUE INDEX idx_zoho_quote_identity (id,task_id),
    UNIQUE INDEX idx_zoho_quote_external (organization_id,external_id),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    INDEX idx_zoho_quote_number (quote_number,id)`),
  table("crm_zoho_quotation_items", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, quotation_id BIGINT NOT NULL, task_id BIGINT NOT NULL,
    position INT NOT NULL CHECK (position >= 0 AND position < 200), ${remoteId("remote_row_id")},
    product_id VARCHAR(100) NOT NULL, product_name VARCHAR(200) NOT NULL, product_description LONGTEXT NOT NULL, uom VARCHAR(100) NOT NULL,
    quantity VARCHAR(80) NOT NULL, service_charge VARCHAR(80) NOT NULL, item_discount VARCHAR(80) NOT NULL, total VARCHAR(80) NOT NULL,
    UNIQUE INDEX idx_zoho_quote_item_position (quotation_id,position),
    UNIQUE INDEX idx_zoho_quote_item_remote (quotation_id,remote_row_id),
    FOREIGN KEY (quotation_id,task_id) REFERENCES crm_zoho_quotations(id,task_id) ON DELETE RESTRICT,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE RESTRICT,
    INDEX idx_zoho_quote_items_task (task_id,quotation_id,position)`),
  table("crm_zoho_user_bindings", `
    local_user_id BIGINT NOT NULL PRIMARY KEY, ${remoteId("organization_id")},
    module_api_name VARCHAR(40) NOT NULL CHECK (module_api_name='VZ_app_users'), ${remoteId("external_user_id")},
    record_name VARCHAR(200) NOT NULL, record_email VARCHAR(254) NOT NULL,
    remote_modified_at VARCHAR(64) NOT NULL, verified_at VARCHAR(32) NOT NULL, created_at VARCHAR(32) NOT NULL,
    UNIQUE INDEX idx_zoho_bound_external (organization_id,external_user_id),
    FOREIGN KEY (local_user_id) REFERENCES users(id) ON DELETE RESTRICT`),
  table("crm_zoho_user_binding_audit", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
    actor_user_id BIGINT NOT NULL, local_user_id BIGINT NOT NULL, ${remoteId("organization_id")}, ${remoteId("external_user_id")},
    action VARCHAR(40) NOT NULL CHECK (action='users.zoho.bind'), reference VARCHAR(120) NOT NULL,
    ${object("verification_json")}, occurred_at VARCHAR(32) NOT NULL,
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (local_user_id) REFERENCES crm_zoho_user_bindings(local_user_id) ON DELETE RESTRICT,
    INDEX idx_zoho_binding_audit_user (local_user_id,id)`),
  ...immutable("crm_zoho_user_bindings"), ...immutable("crm_zoho_user_binding_audit"),
  `CREATE TRIGGER crm_zoho_binding_identity BEFORE INSERT ON crm_zoho_user_bindings FOR EACH ROW
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.local_user_id AND user_id=NEW.external_user_id AND status='active'
        AND LOWER(email)=LOWER(NEW.record_email)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Verified custom user must match the local user';
      END IF;
    END`,
  `CREATE TRIGGER crm_users_bound_identity BEFORE UPDATE ON users FOR EACH ROW
    BEGIN
      IF EXISTS(SELECT 1 FROM crm_zoho_user_bindings WHERE local_user_id=OLD.id AND NOT (external_user_id <=> NEW.user_id)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Verified external user identity is immutable';
      END IF;
    END`,
  `CREATE TRIGGER crm_zoho_binding_audit_identity BEFORE INSERT ON crm_zoho_user_binding_audit FOR EACH ROW
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM crm_zoho_user_bindings WHERE local_user_id=NEW.local_user_id
        AND organization_id=NEW.organization_id AND external_user_id=NEW.external_user_id) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Binding audit must match the verified custom identity';
      END IF;
    END`,
  `CREATE TRIGGER crm_zoho_quote_identity BEFORE UPDATE ON crm_zoho_quotations FOR EACH ROW
    BEGIN
      IF NOT (NEW.id <=> OLD.id) OR NOT (NEW.task_id <=> OLD.task_id) OR NOT (NEW.external_id <=> OLD.external_id)
        OR NOT (NEW.organization_id <=> OLD.organization_id) OR NOT (NEW.mapping_profile <=> OLD.mapping_profile)
        OR NOT (NEW.quote_number <=> OLD.quote_number) OR NOT (NEW.calculation_policy <=> OLD.calculation_policy)
        OR NOT (NEW.issuer_company <=> OLD.issuer_company) OR NOT (NEW.issuer_salesperson <=> OLD.issuer_salesperson)
        OR NOT (NEW.created_at <=> OLD.created_at) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Remote quotation identity and policy are immutable';
      END IF;
    END`,
  `CREATE TRIGGER crm_zoho_quote_no_delete BEFORE DELETE ON crm_zoho_quotations
    FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Saved quotations cannot be deleted'`,
  exclusive("crm_zoho_quote_exclusive", "crm_zoho_quotations", ["crm_quotations", "crm_percentage_quotations"], "INSERT"),
  exclusive("crm_legacy_no_zoho_insert", "crm_quotations", ["crm_zoho_quotations"], "INSERT"),
  exclusive("crm_legacy_no_zoho_update", "crm_quotations", ["crm_zoho_quotations"], "UPDATE"),
  exclusive("crm_percentage_no_zoho_insert", "crm_percentage_quotations", ["crm_zoho_quotations"], "INSERT"),
];
