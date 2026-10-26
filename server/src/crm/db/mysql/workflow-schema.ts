/** Additive MySQL-only local provenance. No historical rows, identities or
 * quotations are adopted; only the explicit migration operator applies this. */
const options = "ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin";
const version = "BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1 AND version <= 9007199254740991)";
const operationId = "CHAR(36) CHARACTER SET ascii COLLATE ascii_bin";
function table(name: string, body: string) { return `CREATE TABLE ${name} (${body}\n) ${options}`; }
function immutable(name: string) {
  return ["UPDATE", "DELETE"].map(action => `CREATE TRIGGER ${name}_no_${action.toLowerCase()} BEFORE ${action} ON ${name}
    FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Local provenance is immutable'`);
}

export const mysqlLocalWorkflowSchemaStatements: readonly string[] = [
  table("crm_local_operations", `
    operation_id ${operationId} PRIMARY KEY, actor_user_id BIGINT NOT NULL, task_id BIGINT NOT NULL,
    kind VARCHAR(40) NOT NULL CHECK (kind IN ('deal.create','lead.stage','note.create','note.edit','quote.create','quote.edit')),
    request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (CHAR_LENGTH(request_hash)=64),
    state VARCHAR(20) NOT NULL CHECK (state='completed'),
    remote_effect_possible TINYINT NOT NULL DEFAULT 0 CHECK (remote_effect_possible=0),
    remote_references LONGTEXT NOT NULL DEFAULT ('{}') CHECK (remote_references='{}'),
    result_json LONGTEXT NOT NULL CHECK (JSON_VALID(result_json) AND JSON_TYPE(result_json)='OBJECT'),
    created_at VARCHAR(32) NOT NULL,
    UNIQUE INDEX idx_local_operation_identity (operation_id,task_id,actor_user_id),
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    INDEX idx_local_operations_task (task_id,created_at)`),
  table("crm_local_tasks", `
    task_id BIGINT NOT NULL PRIMARY KEY, owner_user_id BIGINT NOT NULL,
    creation_operation_id ${operationId} NOT NULL UNIQUE,
    customer_department VARCHAR(100) NOT NULL CHECK (customer_department IN ('VOLTRONIX CONTRACTING LLC','VOLTRONIX SWITCHGEAR LLC')),
    input_json LONGTEXT NOT NULL CHECK (JSON_VALID(input_json) AND JSON_TYPE(input_json)='OBJECT'),
    created_at VARCHAR(32) NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (creation_operation_id,task_id,owner_user_id)
      REFERENCES crm_local_operations(operation_id,task_id,actor_user_id) ON DELETE RESTRICT`),
  table("crm_local_notes", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, task_id BIGINT NOT NULL,
    title VARCHAR(200) NOT NULL, content LONGTEXT NOT NULL, created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL,
    FOREIGN KEY (task_id) REFERENCES crm_local_tasks(task_id) ON DELETE RESTRICT,
    INDEX idx_local_notes_task (task_id,id)`),
  table("crm_local_audit", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, operation_id ${operationId} NOT NULL UNIQUE,
    actor_user_id BIGINT NOT NULL, task_id BIGINT NOT NULL,
    action VARCHAR(40) NOT NULL CHECK (action IN ('deal.create','lead.stage','note.create','note.edit','quote.create','quote.edit')),
    changed_fields LONGTEXT NOT NULL CHECK (JSON_VALID(changed_fields) AND JSON_TYPE(changed_fields)='ARRAY'),
    occurred_at VARCHAR(32) NOT NULL,
    FOREIGN KEY (operation_id,task_id,actor_user_id)
      REFERENCES crm_local_operations(operation_id,task_id,actor_user_id) ON DELETE RESTRICT,
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    INDEX idx_local_audit_task (task_id,id)`),
  table("crm_percentage_quotations", `
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, task_id BIGINT NOT NULL UNIQUE,
    quote_number VARCHAR(200) NOT NULL UNIQUE,
    quotation_json LONGTEXT NOT NULL CHECK (JSON_VALID(quotation_json) AND JSON_TYPE(quotation_json)='OBJECT'),
    totals_json LONGTEXT NOT NULL CHECK (JSON_VALID(totals_json) AND JSON_TYPE(totals_json)='OBJECT'),
    calculation_policy VARCHAR(40) NOT NULL CHECK (calculation_policy='percentage-only-v2'), version ${version},
    issuer_company VARCHAR(100), issuer_salesperson VARCHAR(200),
    created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL,
    CHECK ((issuer_company IS NULL AND issuer_salesperson IS NULL) OR
      (issuer_company IS NOT NULL AND issuer_salesperson IS NOT NULL AND
       issuer_company IN ('VOLTRONIX CONTRACTING LLC','VOLTRONIX SWITCHGEAR LLC') AND CHAR_LENGTH(issuer_salesperson)>0)),
    FOREIGN KEY (task_id) REFERENCES crm_local_tasks(task_id) ON DELETE RESTRICT`),
  `CREATE TRIGGER crm_local_tasks_creation BEFORE INSERT ON crm_local_tasks FOR EACH ROW
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM crm_local_operations WHERE operation_id=NEW.creation_operation_id
        AND task_id=NEW.task_id AND actor_user_id=NEW.owner_user_id AND kind='deal.create') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Local creation receipt does not match';
      END IF;
    END`,
  `CREATE TRIGGER crm_local_audit_operation BEFORE INSERT ON crm_local_audit FOR EACH ROW
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM crm_local_operations WHERE operation_id=NEW.operation_id
        AND task_id=NEW.task_id AND actor_user_id=NEW.actor_user_id AND kind=NEW.action) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Local audit receipt does not match';
      END IF;
    END`,
  ...["crm_local_tasks", "crm_local_operations", "crm_local_audit"].flatMap(immutable),
  `CREATE TRIGGER crm_percentage_quotations_identity BEFORE UPDATE ON crm_percentage_quotations FOR EACH ROW
    BEGIN
      IF NOT (NEW.id <=> OLD.id) OR NOT (NEW.task_id <=> OLD.task_id) OR NOT (NEW.quote_number <=> OLD.quote_number)
        OR NOT (NEW.calculation_policy <=> OLD.calculation_policy) OR NOT (NEW.created_at <=> OLD.created_at)
        OR NOT (NEW.issuer_company <=> OLD.issuer_company) OR NOT (NEW.issuer_salesperson <=> OLD.issuer_salesperson) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Quotation identity policy and issuer are immutable';
      END IF;
    END`,
  `CREATE TRIGGER crm_percentage_quotations_no_delete BEFORE DELETE ON crm_percentage_quotations
    FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Saved quotations cannot be deleted'`,
  `CREATE TRIGGER crm_percentage_quotations_no_legacy BEFORE INSERT ON crm_percentage_quotations FOR EACH ROW
    BEGIN
      IF EXISTS(SELECT 1 FROM crm_quotations WHERE task_id=NEW.task_id OR quote_number=NEW.quote_number) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Historical quotation requires explicit reconciliation';
      END IF;
    END`,
  `CREATE TRIGGER crm_quotations_no_percentage BEFORE INSERT ON crm_quotations FOR EACH ROW
    BEGIN
      IF EXISTS(SELECT 1 FROM crm_percentage_quotations WHERE task_id=NEW.task_id OR quote_number=NEW.quote_number) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Local percentage quotation already exists';
      END IF;
    END`,
];

/** MySQL v1 generates this check name deterministically. The migration runner
 * verifies its exact definition and the MEDIUMBLOB shape before any v3 DDL. */
export const mysqlDepartmentAttachmentSchemaStatements: readonly string[] = [
  `ALTER TABLE crm_department_log_attachments MODIFY content LONGBLOB NOT NULL,
    DROP CHECK crm_department_log_attachments_chk_1,
    ADD CONSTRAINT crm_log_attachment_size_v3 CHECK (file_size > 0 AND file_size <= 52428800)`,
  `CREATE TRIGGER crm_log_attachment_department_limit BEFORE INSERT ON crm_department_log_attachments FOR EACH ROW
    BEGIN
      IF NEW.file_size > CASE (SELECT department FROM crm_department_work_logs WHERE id=NEW.log_id)
        WHEN 'Electrical' THEN 52428800 WHEN 'Civil' THEN 52428800
        WHEN 'Switchgear' THEN 52428800 WHEN 'Maintenance' THEN 52428800 ELSE 16384000 END THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Attachment exceeds department limit';
      END IF;
    END`,
];
