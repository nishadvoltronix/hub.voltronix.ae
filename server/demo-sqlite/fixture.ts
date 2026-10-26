import { randomBytes, randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../../tests/sqlite-reference/db/connection.ts";
import { assertMigrationsCurrent } from "../../tests/sqlite-reference/db/migrations.ts";
import { createDevelopmentUser } from "../../tests/sqlite-reference/auth/provision.ts";
import { DEPARTMENT_PERMISSIONS, type PermissionKey } from "../../tests/sqlite-reference/auth/permissions.ts";
import { DEPARTMENTS, LOG_OPTIONS, type Department } from "../../tests/sqlite-reference/departments/contracts.ts";
import { calculateQuotation, parseQuotationInput } from "../../tests/sqlite-reference/commercial/quotations.ts";

export interface DemoIdentity {
  readonly id: string;
  readonly email: string;
  readonly password: string;
  readonly externalId: string;
  readonly name: string;
}
export interface DemoFixture {
  readonly fixtureId: string;
  readonly marker: string;
  readonly identities: {
    readonly operator: DemoIdentity;
    readonly browser: DemoIdentity;
    readonly denied: DemoIdentity;
    readonly contracting: DemoIdentity;
    readonly switchgear: DemoIdentity;
    readonly workers: Readonly<Record<Department, DemoIdentity>>;
  };
  readonly jobId: string;
  readonly leadId: string;
  readonly contractingTaskId: string;
  readonly switchgearTaskId: string;
  readonly productId: string;
  readonly summary: {
    readonly synthetic: true;
    readonly users: number;
    readonly tasks: number;
    readonly products: number;
    readonly quotations: number;
    readonly departmentAssignments: number;
    readonly workLogs: number;
    readonly notes: number;
    readonly statusHistory: number;
  };
}

export class DemoSeedError extends Error {
  constructor() { super("SQLite demo seeding refused or failed; no existing records were replaced."); }
}

const applicationTables = [
  "users", "permission_groups", "permissions", "admin_user_permissions", "tasks", "departments_assign",
  "crm_sessions", "crm_login_attempts", "crm_audit_events", "job_notes", "tasks_status_log", "accounts",
  "crm_job_audit_events", "crm_lead_operations", "crm_lead_audit_events", "crm_department_work_logs",
  "crm_department_audit_events", "task_attachment", "crm_attachment_audit_events", "products",
  "crm_quotations", "proposal_items", "crm_commercial_operations", "crm_commercial_audit_events",
  "crm_department_log_attachments", "crm_department_log_attachment_audit_events",
] as const;
const managerPermissions: readonly PermissionKey[] = [
  "dashboard.view", "leads.view", "leads.manage", "deals.manage", "deals.view", "items.view", "items.write",
  "users.write", "permissions.manage", "sales_dashboard.view",
];
const departmentDashboard: Record<Department, PermissionKey> = {
  Electrical: "electric_dashboard.view", Civil: "civil_dashboard.view", PM: "pm_dashboard.view",
  Switchgear: "switchgear_dashboard.view", Maintenance: "maintenance_dashboard.view",
};

/** Explicit seeding of an empty, already migrated SQLite demo only. The caller
 * owns the isolated database and private credential handoff. This module opens
 * no database, writes no files, logs nothing and composes no remote transport. */
export async function seedDemo(db: SqliteDatabase, options: { now?: string } = {}): Promise<DemoFixture> {
  let transactionStarted = false;
  try {
    const now = options.now ?? new Date().toISOString();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(now)
      || !Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now
      || db.readonly || db.inTransaction || db.pragma("foreign_keys", { simple: true }) !== 1) throw new DemoSeedError();
    assertMigrationsCurrent(db);
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
      .all() as { name: string }[];
    if (JSON.stringify(tables.map(row => row.name)) !== JSON.stringify([...applicationTables, "crm_schema_migrations"].sort())) {
      throw new DemoSeedError();
    }
    db.exec("BEGIN IMMEDIATE"); transactionStarted = true;
    for (const table of applicationTables) {
      if (db.prepare(`SELECT 1 FROM "${table}" LIMIT 1`).get()) throw new DemoSeedError();
    }
    const fixtureId = randomUUID(), hex = fixtureId.replaceAll("-", ""), marker = `SYNTHETIC SQLITE DEMO ${fixtureId}`;
    const external = (index: number) => `900${BigInt(`0x${hex}`).toString().slice(0, 25)}${String(index).padStart(2, "0")}`;
    let nextUser = 1;
    async function identity(key: string, permissions: readonly PermissionKey[], department: Department | null = null,
      company = "VOLTRONIX CONTRACTING LLC"): Promise<DemoIdentity> {
      const email = `${key}.${hex}@example.invalid`, password = randomBytes(32).toString("base64url");
      const externalId = external(nextUser++), name = `SYNTHETIC DEMO ${key}`;
      const id = await createDevelopmentUser(db, { environment: "development", email, password, name,
        externalUserId: externalId, permissions: [...permissions] });
      db.prepare("UPDATE users SET role='sqlite-demo-nonadmin',department_role=?,company=?,sale_name=?,created_at=?,updated_at=? WHERE id=?")
        .run(department, company, name, now, now, id);
      return Object.freeze({ id, email, password, externalId, name });
    }
    const operator = await identity("operator", managerPermissions);
    const browser = await identity("browser", managerPermissions);
    const denied = await identity("denied", []);
    const contracting = await identity("contracting", ["leads.manage.agents", "items.view"]);
    const switchgear = await identity("switchgear", ["leads.manage.agents", "items.view"], null, "VOLTRONIX SWITCHGEAR LLC");
    const workers = {} as Record<Department, DemoIdentity>;
    for (const department of DEPARTMENTS) workers[department] = await identity(`worker-${department.toLowerCase()}`,
      [DEPARTMENT_PERMISSIONS[department], departmentDashboard[department]], department);

    const productId = external(30);
    db.prepare("INSERT INTO products(product_id,product_name,description,unit_price,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(productId, "SYNTHETIC DEMO distribution panel", marker, "100.10", now, now);
    const ids: string[] = [];
    function task(index: number, owner: DemoIdentity, stage: string, label: string, quoted = false): string {
      const reference = `DEMO-${hex.slice(0, 8)}-${index}`;
      const quote = quoted ? parseQuotationInput({ subject: `SYNTHETIC DEMO ${label}`, kindAttention: "Synthetic customer",
        project: "Temporary local demonstration", notes: marker, discount: "0", adjustment: "0",
        items: [{ productId, productName: "SYNTHETIC DEMO distribution panel", description: "Synthetic demonstration only",
          uom: "NOS", quantity: "2.5", unitPrice: "100.10", itemDiscount: "0" }] }) : null;
      const totals = quote ? calculateQuotation(quote, "percentage") : null;
      const won = stage === "Closed Won", quoteId = quoted ? external(index + 30) : null;
      const inserted = db.prepare(`INSERT INTO tasks(zoho_crm_id,assigned_to,deal_name,status,Job_Status,account_name,
        customer_name,customer_email,customer_contact,address,notes,deal_number,job_deal_number,job_deal_date,
        quote_deal_number,quote_deal_date,quote_id,quote_number,service_charge,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).safeIntegers(true)
        .run(external(index), owner.externalId, `SYNTHETIC DEMO ${label}`, stage, won ? "Active" : null,
          "SYNTHETIC DEMO customer", "Synthetic customer", "synthetic-customer@example.invalid", "0000000000",
          "Synthetic local demo address", marker, reference, won ? reference : null, won ? now : null,
          quoted ? reference : null, quoted ? now : null, quoteId, quoted ? reference : null,
          totals?.subtotal ?? "1000.00", now, now);
      const id = String(inserted.lastInsertRowid); ids.push(id);
      db.prepare("INSERT INTO job_notes(deal_id,note_title,note_content,created_at,updated_at) VALUES(?,?,?,?,?)")
        .run(external(index), "Synthetic demo note", `${marker}. Integration-dependent note changes remain unavailable.`, now, now);
      db.prepare("INSERT INTO tasks_status_log(Task_ID,User_ID,Status,Task_Log_Create_Date) VALUES(?,?,?,?)")
        .run(id, owner.id, stage, now);
      if (quote && totals) {
        const { items, ...header } = quote;
        const quotationId = String(db.prepare(`INSERT INTO crm_quotations(task_id,external_id,quote_number,header_json,totals_json,
          calculation_policy,remote_modified_at,created_at,updated_at) VALUES(?,?,?,?,?,'percentage-create-v1',?,?,?)`)
          .safeIntegers(true).run(id, quoteId, reference, JSON.stringify(header), JSON.stringify(totals), now, now, now).lastInsertRowid);
        for (const [position, item] of items.entries()) db.prepare(`INSERT INTO proposal_items(quotation_id,task_id,position,product_id,
          product_name,product_description,uom,quantity,service_charge,item_discount,total) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
          .run(quotationId, id, position, productId, item.productName, item.description, item.uom,
            item.quantity, item.unitPrice, item.itemDiscount, totals.lineTotals[position]!);
      }
      return id;
    }
    const jobId = task(40, operator, "Closed Won", "active installation job");
    const leadId = task(41, browser, "Qualification", "lead awaiting site visit");
    const contractingTaskId = task(42, contracting, "Proposal/Price Quote", "contracting quotation", true);
    const switchgearTaskId = task(43, switchgear, "Proposal/Price Quote", "switchgear quotation", true);
    task(44, operator, "Closed Lost", "closed lost example");

    for (const department of DEPARTMENTS) {
      const worker = workers[department], choices = LOG_OPTIONS[department];
      const assignmentId = String(db.prepare(`INSERT INTO departments_assign(task_id,user_id,department,status,assigned_by,
        assigned_date,assigned_time,notes,created_at,updated_at,assigned_by_external) VALUES(?,?,?,'Assigned',?,?,?,?,?,?,?)`)
        .safeIntegers(true).run(jobId, worker.id, department, operator.id, now.slice(0, 10), now, marker, now, now, operator.externalId).lastInsertRowid);
      db.prepare(`INSERT INTO crm_department_work_logs(task_id,department,assignment_id,actor_user_id,authority,scope,status,comments,notes,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(jobId, department, assignmentId, worker.id,
          "authority" in choices ? choices.authority[1] : null, "scope" in choices ? choices.scope[1] : null,
          choices.status[1], "Synthetic starting example", marker, now);
    }
    db.prepare(`INSERT INTO accounts(task_id,user_id,assigned_by_id,assigned_time,payment_status,received_amount,created_at,actor_user_id)
      VALUES(?,?,?,?,'Pending','0.00',?,?)`).run(jobId, operator.id, operator.externalId, now, now, operator.id);
    if ((db.pragma("foreign_key_check") as unknown[]).length !== 0) throw new DemoSeedError();
    const fixture: DemoFixture = Object.freeze({ fixtureId, marker,
      identities: Object.freeze({ operator, browser, denied, contracting, switchgear, workers: Object.freeze(workers) }),
      jobId, leadId, contractingTaskId, switchgearTaskId, productId,
      summary: Object.freeze({ synthetic: true as const, users: nextUser - 1, tasks: ids.length, products: 1, quotations: 2,
        departmentAssignments: DEPARTMENTS.length, workLogs: DEPARTMENTS.length, notes: ids.length, statusHistory: ids.length }),
    });
    db.exec("COMMIT"); transactionStarted = false;
    return fixture;
  } catch {
    if (transactionStarted && db.inTransaction) { try { db.exec("ROLLBACK"); } catch { /* Caller retains failed private database. */ } }
    throw new DemoSeedError();
  }
}
