/**
 * Identifier inventory from the archived, non-numbered PHP source methods.
 * This is NOT recovered production DDL, a migration, or runtime authorization.
 * A source reference proves a code expectation, not that a deployed table,
 * column, constraint, route, or populated record actually matches it.
 * No private source, environment, database, or network is read by this module.
 */
export type LegacySourceCategory =
  | "auth" | "tasks" | "departments" | "department-logs" | "payments"
  | "attachments" | "products" | "quotations";

export interface LegacySourceReference {
  /** Relative to the archived PHP source root, not a runtime filesystem path. */
  readonly file: string;
  readonly line: number;
  readonly symbol: string;
}

export interface LegacySourceContractEntry {
  readonly table: string;
  /** Selected source-observed identifiers, not an exhaustive column manifest. */
  readonly columns: readonly string[];
  readonly category: LegacySourceCategory;
  readonly sourceRefs: readonly LegacySourceReference[];
  readonly semantics: string;
}

export const sourceContractEvidence = Object.freeze({
  kind: "source-reference" as const,
  sourceSnapshot: "source-20261014",
  authoritativeDdl: false as const,
  completeSchema: false as const,
  runtimeCompatibilityVerified: false as const,
  unknowns: Object.freeze([
    "Whether the deployed PHP revision and enabled routes match the archived source.",
    "Actual server family/version, table engines, column types, lengths, precision, nullability, defaults and collations.",
    "Actual keys, uniqueness, indexes, foreign keys, checks, triggers, views, routines and events.",
    "Stored password algorithm distribution and compatibility; PHP password_verify is broader than the new bcrypt-only verifier.",
    "Identity-domain consistency, duplicate identifiers, orphan references, status values, dates and historical quotation semantics.",
    "Original attachment bytes, approved storage roots, ownership and safe private delivery.",
    "Cross-application transaction/locking behavior and detection of PHP writes by new-app optimistic versions.",
    "Session/grant revocation semantics across both applications and ownership of Zoho writes/webhooks.",
  ]),
});

const ref = (file: string, line: number, symbol: string): LegacySourceReference => ({ file, line, symbol });

function freezeEntry(value: LegacySourceContractEntry): LegacySourceContractEntry {
  return Object.freeze({
    ...value,
    columns: Object.freeze([...value.columns]),
    sourceRefs: Object.freeze(value.sourceRefs.map(source => Object.freeze({ ...source }))),
  });
}

/**
 * Names are intentionally kept in their PHP spelling/case. Matching this subset
 * is necessary for the cited operations, but is never sufficient to enable
 * shared-database writes or relax the new application's schema guards.
 * No SQL types/defaults/keys are copied from the inferred SQLite scaffold.
 */
export const sourceContract: readonly LegacySourceContractEntry[] = Object.freeze(([
  {
    table: "users", category: "auth",
    columns: ["id", "user_id", "username", "email", "password", "status", "department", "department_role",
      "department_assigned_by", "department_assigned_date", "quote_access", "role", "company", "sale_name"],
    sourceRefs: [ref("application/controllers/Login.php", 24, "authenticate"),
      ref("application/controllers/Permissions.php", 103, "user_save"),
      ref("application/controllers/Permissions.php", 307, "assign_departments_role"),
      ref("application/controllers/ZohoWebhook.php", 953, "vx_app_user_updated")],
    semantics: "Local id and external user_id are distinct. Local settings and a Zoho webhook both write users; source password generators do not certify stored hash formats.",
  },
  {
    table: "permission_groups", category: "auth", columns: ["id", "key", "label", "sort_order"],
    sourceRefs: [ref("application/models/Admin.php", 629, "get_permission_groups"),
      ref("application/controllers/Permissions.php", 211, "permission_group_save")],
    semantics: "Local permission grouping/catalogue; no observed new-app version contract is implied.",
  },
  {
    table: "permissions", category: "auth", columns: ["id", "key", "label", "group_id"],
    sourceRefs: [ref("application/models/Admin.php", 698, "get_permissions_with_group"),
      ref("application/controllers/Permissions.php", 271, "permission_save")],
    semantics: "Local permission definitions join permission_groups; actual production keys and grant policy require verification.",
  },
  {
    table: "admin_user_permissions", category: "auth", columns: ["admin_user_id", "permission_id"],
    sourceRefs: [ref("application/models/Admin.php", 654, "save_admin_permissions")],
    semantics: "Local user-to-permission membership is deleted and reinserted; no uniqueness, transaction boundary or grants_version is inferred.",
  },
  {
    table: "permission_audit_logs", category: "auth",
    columns: ["changed_by", "target_user_id", "permission_key", "action", "ip_address", "created_at"],
    sourceRefs: [ref("application/libraries/Rbac.php", 105, "log_permission_change")],
    semantics: "Legacy permission audit payload differs from the new immutable crm_audit_events contract.",
  },
  {
    table: "tasks", category: "tasks",
    columns: ["id", "zoho_crm_id", "deal_name", "deal_number", "enq_number", "qual_deal_number", "assigned_to",
      "deal_crm_created_by", "owner_id", "account_name", "customer_name", "customer_email", "customer_contact",
      "address", "remark", "complaint_info", "status", "Assign_Department", "Job_Status", "hold_by", "Admin_Remarks",
      "quote_id", "quote_number", "quote_deal_number", "subject", "project_name", "kind_attention", "terms_of_payment",
      "general_exclusion", "specification", "brand", "warranty", "delivery", "notes", "valid_until", "discount",
      "adjustment", "product_id", "product_name", "product_description", "uom", "quantity", "service_charge", "updated_at"],
    sourceRefs: [ref("application/models/Task_model.php", 437, "upsert_task_from_zoho_deal"),
      ref("application/controllers/ZohoWebhook.php", 162, "deal_created"),
      ref("application/controllers/Jobs.php", 301, "hold_full_job"),
      ref("application/models/Admin.php", 3639, "save_admin_remarks"),
      ref("application/controllers/Admincrm.php", 3318, "add_proposal_to_zoho")],
    semantics: "Shared lead/job with flattened current quotation fields. Sales assigned_to refers to users.user_id, not users.id. Pipeline and local job status are distinct; this is not crm_quotations storage.",
  },
  {
    table: "departments_assign", category: "departments",
    columns: ["ID", "task_id", "department", "user_id", "assigned_by", "assigned_date", "status"],
    sourceRefs: [ref("application/controllers/Jobs.php", 236, "assign_job_departments"),
      ref("application/models/Admin.php", 499, "update_departments_assign"),
      ref("application/models/Admin.php", 3625, "unassign_department")],
    semantics: "Local assignment history uses local task/user identities. PHP also spells assignment keys/status with different case; exact metadata and latest-row ordering require inspection.",
  },
  {
    table: "electric", category: "department-logs",
    columns: ["task_id", "User_ID", "departments_assign_id", "DEWA_Authority", "Electric_Status",
      "Authority_Comments", "Electrician_Notes", "created_at", "File"],
    sourceRefs: [ref("application/controllers/Electrical.php", 181, "update_electric_job"),
      ref("application/models/Admin.php", 1625, "insert_electrical")],
    semantics: "Electrical work-log fields and uploaded filename; not a row in the new consolidated crm_department_work_logs table.",
  },
  {
    table: "civil", category: "department-logs",
    columns: ["task_id", "User_ID", "departments_assign_id", "Civil_Authority", "Civil_Status",
      "Civil_Authority_Comments", "Civil_Notes", "Civil_Created_At", "Civil_File"],
    sourceRefs: [ref("application/controllers/Civil.php", 182, "update_civil_job"),
      ref("application/models/Admin.php", 1632, "insert_civil")],
    semantics: "Civil work-log fields and filesystem upload reference; local author/assignment linkage must be preserved.",
  },
  {
    table: "pm", category: "department-logs",
    columns: ["task_id", "User_ID", "departments_assign_id", "PM_Scope_of_Work", "PM_Status", "PM_Notes", "PM_Created_At", "PM_File"],
    sourceRefs: [ref("application/controllers/Project_Manager.php", 179, "update_pm_job"),
      ref("application/models/Admin.php", 1653, "insert_pm")],
    semantics: "Project-management log and filesystem upload, independently persisted from the other departments.",
  },
  {
    table: "switchgear", category: "department-logs",
    columns: ["task_id", "User_ID", "departments_assign_id", "Switchgear_Scope_of_Work", "Switchgear_Status",
      "Switchgear_Notes", "Switchgear_Created_At", "Switchgear_File"],
    sourceRefs: [ref("application/controllers/Switchgear.php", 182, "update_swt_job"),
      ref("application/models/Admin.php", 1639, "insert_switchgear")],
    semantics: "Switchgear log subset. Other delivery-proof helper references do not establish a complete deployed storage contract.",
  },
  {
    table: "maintenance", category: "department-logs",
    columns: ["task_id", "User_ID", "departments_assign_id", "Maintenance_Scope_of_Work", "Maintenance_Status",
      "Maintenance_Notes", "Maintenance_Created_At", "Maintenance_File"],
    sourceRefs: [ref("application/controllers/Maintenance.php", 182, "update_mtn_job"),
      ref("application/models/Admin.php", 1646, "insert_maintenance")],
    semantics: "Maintenance log and filesystem upload reference; no common schema with the other departmental tables is assumed.",
  },
  {
    table: "accounts", category: "payments",
    columns: ["task_id", "user_id", "assigned_by_id", "assigned_time", "payment_status", "received_amount"],
    sourceRefs: [ref("application/controllers/Jobs.php", 276, "assign_accounts_department"),
      ref("application/models/Admin.php", 1730, "pending_accounts_summary")],
    semantics: "Local job/payment-follow-up assignment and received amounts, NOT Zoho customer Accounts. Monetary SQL types/scale and assignee identity domain remain unverified.",
  },
  {
    table: "task_attachment", category: "attachments", columns: ["task_id", "user_id", "file_name", "created_at"],
    sourceRefs: [ref("application/controllers/Admincrm.php", 838, "update_attachments_files"),
      ref("application/models/Admin.php", 493, "add_task_attachments")],
    semantics: "Direct PHP upload metadata references filesystem content; no new-app BLOB, checksum, media_type or uploaded_by columns are inferred.",
  },
  {
    table: "job_attachments", category: "attachments",
    columns: ["attachment_id", "deal_id", "file_name", "file_size", "file_type", "file_path", "created_at"],
    sourceRefs: [ref("application/models/ZohoAttachments_model.php", 10, "store_file"),
      ref("application/models/Admin.php", 442, "get_lead_attachments")],
    semantics: "Zoho deal-attachment metadata/downloaded path; deal_id refers to tasks.zoho_crm_id, not the local task id. Metadata alone does not provide file bytes.",
  },
  {
    table: "job_notes", category: "tasks",
    columns: ["id", "deal_id", "note_title", "note_content", "zoho_note_id", "created_at", "updated_at"],
    sourceRefs: [ref("application/controllers/Admincrm.php", 670, "add_leads_notes_details"),
      ref("application/controllers/Admincrm.php", 349, "update_leads_notes_details")],
    semantics: "Zoho-linked notes use the external deal identity. The separate legacy lead_notes helper is not treated as an alias or required replacement.",
  },
  {
    table: "tasks_status_log", category: "tasks", columns: ["Task_ID", "User_ID", "Status", "Task_Log_Create_Date"],
    sourceRefs: [ref("application/controllers/Admincrm.php", 1345, "update_status")],
    semantics: "Local stage-change history accompanies a Zoho-backed operation; this payload does not prove an atomic local/remote transaction.",
  },
  {
    table: "zoho_products", category: "products", columns: ["zoho_product_id", "product_name", "description"],
    sourceRefs: [ref("application/controllers/ZohoWebhook.php", 1434, "sync_all_zoho_products")],
    semantics: "Legacy Zoho product cache; not the new application's products table. Source sync does not prove completeness or enable runtime integration.",
  },
  {
    table: "quotes", category: "quotations", columns: ["task_id", "quote_id"],
    sourceRefs: [ref("application/models/Task_quote_model.php", 19, "get_quotes_by_task")],
    semantics: "Source model reads task-to-external-quote links. Deployed usage/cardinality and additional columns remain unverified; not canonical crm_quotations header/totals storage.",
  },
  {
    table: "proposal_items", category: "quotations",
    columns: ["task_id", "quote_number", "product_id", "product_name", "product_description", "uom", "quantity",
      "service_charge", "item_discount", "total", "updated_at"],
    sourceRefs: [ref("application/controllers/Admincrm.php", 4268, "update_proposal_in_zoho"),
      ref("application/models/Task_model.php", 252, "delete_proposal_items"),
      ref("application/models/Task_model.php", 258, "save_proposal_item")],
    semantics: "Legacy quotation lines are replaced by quote_number and also carry task_id. Global quote-number uniqueness, discount meaning and new quotation_id/position fields are not inferred.",
  },
] satisfies LegacySourceContractEntry[]).map(freezeEntry));
