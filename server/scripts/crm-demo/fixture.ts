import { randomBytes } from "node:crypto";
import { hash } from "bcryptjs";
import type { MysqlWireConnection } from "../../src/crm/db/mysql/driver.js";
import { mysqlExpectedTables } from "../../src/crm/db/mysql/schema.js";
import { calculateSavedQuotation, parseSavedQuotationInput } from "../../src/crm/commercial/quotations.js";

/** Owned, explicitly synthetic data for a newly provisioned test schema only.
 * Importing this file performs no effects. No reset, deletion or cleanup exists. */
const names = ["operator", "worker", "denied", "contracting", "switchgear"] as const;
type Name = typeof names[number];
export interface CrmDemoIdentity { readonly id: string; readonly email: string; readonly externalId: string }
export interface CrmDemoFixture {
  readonly fixtureId: string; readonly database: string; readonly marker: string; readonly password: string;
  readonly identities: Readonly<Record<Name, CrmDemoIdentity>>;
  readonly jobId: string; readonly contractingTaskId: string; readonly switchgearTaskId: string;
  readonly productId: string;
}
interface Owner { used: boolean; httpUsed: boolean; chromiumUsed: boolean; marker: string; database: string; userIds: string[]; taskIds: string[] }
const owners = new WeakMap<CrmDemoFixture, Owner>();
export class CrmDemoCaseError extends Error {
  constructor() { super("Isolated CRM verification refused or failed; retain the owned target for private review."); }
}
function destroy(connection: MysqlWireConnection) { try { connection.destroy(); } catch { /* No driver details leave the fixture boundary. */ } }
export function ensureCrmDemo(condition: unknown): asserts condition { if (!condition) throw new CrmDemoCaseError(); }
function rows(value: unknown): Record<string, unknown>[] {
  ensureCrmDemo(Array.isArray(value) && value.every(row => row !== null && typeof row === "object" && !Array.isArray(row)));
  return value as Record<string, unknown>[];
}
export async function demoRows(connection: MysqlWireConnection, sql: string, values: readonly unknown[] = []) {
  try { return rows((await connection.execute(sql, values))[0]); } catch { throw new CrmDemoCaseError(); }
}
async function insert(connection: MysqlWireConnection, sql: string, values: readonly unknown[]) {
  const [packet] = await connection.execute(sql, values);
  ensureCrmDemo(packet !== null && typeof packet === "object" && !Array.isArray(packet));
  const result = packet as Record<string, unknown>;
  ensureCrmDemo(result.affectedRows === 1 && result.warningStatus === 0);
  const id = String(result.insertId ?? "0");
  ensureCrmDemo(/^(?:0|[1-9][0-9]{0,18})$/.test(id) && BigInt(id) <= 9_223_372_036_854_775_807n);
  return id;
}
function owner(fixture: CrmDemoFixture) {
  const selected = owners.get(fixture); ensureCrmDemo(selected); return selected;
}
export function consumeCrmDemo(fixture: CrmDemoFixture, kind: "cases" | "http" | "chromium") {
  const selected = owner(fixture), key = kind === "cases" ? "used" : kind === "http" ? "httpUsed" : "chromiumUsed";
  ensureCrmDemo(!selected[key]); selected[key] = true;
}
/** Pure capability check for the outer runner's separately approved private
 * handoff. Consumed phases alone do not prove success: the runner must first
 * validate all expected results, drain its resources and refresh approval.
 * This helper never writes, logs, connects or reveals values in an error. */
export function getCrmDemoAccess(fixture: CrmDemoFixture, chromiumRequired: boolean) {
  const selected = owner(fixture);
  ensureCrmDemo(typeof chromiumRequired === "boolean" && selected.used && selected.httpUsed
    && (!chromiumRequired || selected.chromiumUsed)
    && Object.isFrozen(fixture) && Object.isFrozen(fixture.identities)
    && Object.isFrozen(fixture.identities.operator)
    && selected.database === fixture.database && selected.marker === fixture.marker
    && selected.userIds[0] === fixture.identities.operator.id);
  return Object.freeze({ email: fixture.identities.operator.email, password: fixture.password,
    marker: fixture.marker, database: fixture.database, fixtureId: fixture.fixtureId });
}
/** Check the unforgeable in-process receipt and exact synthetic parent markers.
 * This is not permission to reset a schema or delete any fixture/audit row. */
export async function verifyCrmDemoFixture(connection: MysqlWireConnection, fixture: CrmDemoFixture) {
  const selected = owner(fixture);
  const target = await demoRows(connection, "SELECT DATABASE() AS selected_database");
  ensureCrmDemo(target.length === 1 && target[0]?.selected_database === selected.database);
  for (const id of selected.userIds) {
    const found = await demoRows(connection, "SELECT role,username,email FROM users WHERE id=?", [id]);
    ensureCrmDemo(found.length === 1 && found[0]?.role === "fixture-nonadmin"
      && typeof found[0]?.username === "string" && found[0].username.startsWith(selected.marker + ":")
      && typeof found[0].email === "string" && found[0].email.endsWith("@example.invalid"));
  }
  for (const id of selected.taskIds) {
    const found = await demoRows(connection, "SELECT notes FROM tasks WHERE id=?", [id]);
    ensureCrmDemo(found.length === 1 && found[0]?.notes === selected.marker);
  }
}

/** Outer runner must prove exact endpoint, fresh schema, accounts and DDL first.
 * This helper independently refuses any nonempty application table. All DML
 * belongs to one transaction; DDL is never part of this rollback boundary. */
export async function createCrmDemoFixture(connection: MysqlWireConnection, fixtureId: string): Promise<CrmDemoFixture> {
  ensureCrmDemo(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(fixtureId));
  const hex = fixtureId.replaceAll("-", ""), database = `crm_local_crm_${hex}`, marker = `synthetic-crm:${fixtureId}`;
  const target = await demoRows(connection, "SELECT DATABASE() AS selected_database");
  ensureCrmDemo(target.length === 1 && target[0]?.selected_database === database);
  const password = randomBytes(32).toString("base64url"), passwordHash = await hash(password, 12);
  const identities = {} as Record<Name, CrmDemoIdentity>, now = new Date().toISOString();
  const external = (index: number) => `900${BigInt(`0x${hex}`).toString().slice(0, 28)}${index}`;
  let commitStarted = false, begun = false;
  try {
    await connection.beginTransaction(); begun = true;
    const lock = await demoRows(connection, "SELECT id FROM crm_app_lock WHERE id=1 FOR UPDATE");
    ensureCrmDemo(lock.length === 1 && String(lock[0]?.id) === "1");
    for (const table of mysqlExpectedTables) {
      const count = await demoRows(connection, `SELECT COUNT(*) AS total FROM \`${table}\``);
      ensureCrmDemo(count.length === 1 && String(count[0]?.total) === (table === "crm_app_lock" ? "1" : "0"));
    }
    for (const [index, name] of names.entries()) {
      const email = `${name}.${hex}@example.invalid`, externalId = external(index);
      const company = name === "switchgear" ? "VOLTRONIX SWITCHGEAR LLC" : "VOLTRONIX CONTRACTING LLC";
      const id = await insert(connection, "INSERT INTO users(user_id,username,email,password,status,department_role,role,company,sale_name,created_at,updated_at) VALUES(?,?,?,?,'active',?,'fixture-nonadmin',?,?,?,?)",
        [externalId, `${marker}:${name}`, email, passwordHash, name === "worker" ? "Electrical" : null, company, `TEST ONLY ${name}`, now, now]);
      ensureCrmDemo(id !== "0"); identities[name] = Object.freeze({ id, email, externalId });
    }
    const grants: Record<Name, readonly string[]> = { operator: ["dashboard.view", "users.write", "permissions.manage", "items.view", "items.write", "leads.view", "leads.manage", "deals.manage"],
      worker: ["electrical.manage", "electric_dashboard.view"], denied: [], contracting: ["leads.manage.agents", "items.view"], switchgear: ["leads.manage.agents", "items.view"] };
    for (const key of new Set(Object.values(grants).flat())) {
      const permissionId = await insert(connection, "INSERT INTO permissions(`key`,label) VALUES(?,?)", [key, marker]);
      ensureCrmDemo(permissionId !== "0");
      for (const name of names) if (grants[name].includes(key)) await insert(connection,
        "INSERT INTO admin_user_permissions(admin_user_id,permission_id) VALUES(?,?)", [identities[name].id, permissionId]);
    }
    const productId = external(6);
    await insert(connection, "INSERT INTO products(product_id,product_name,description,unit_price,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      [productId, "TEST ONLY isolated panel", marker, "100.10", now, now]);
    async function task(index: number, name: "operator" | "contracting" | "switchgear", quoted: boolean) {
      const quoteId = quoted ? external(index + 3) : null, reference = `SYNTHETIC-${hex.slice(0, 8)}-${name}`;
      // Synthetic historical records keep their historical policy and shape.
      // Current create parsing would inject percentage-only-v2 metadata into a
      // percentage-create-v1 row and make subsequent preserved reads fail.
      const quotation = quoted ? parseSavedQuotationInput({ subject: "TEST ONLY fixture quotation", kindAttention: "TEST ONLY synthetic contact", discount: "0", adjustment: "0", notes: marker,
        items: [{ productId, productName: "TEST ONLY isolated panel", description: marker, quantity: "2.5", unitPrice: "100.10", itemDiscount: "0", uom: "NOS" }] }, "percentage-create-v1") : null;
      const totals = quotation ? calculateSavedQuotation(quotation, "percentage-create-v1") : null;
      const id = await insert(connection, `INSERT INTO tasks(zoho_crm_id,assigned_to,deal_name,status,Job_Status,account_name,customer_name,customer_email,
        customer_contact,address,notes,deal_number,job_deal_number,quote_deal_number,quote_deal_date,quote_id,quote_number,service_charge,created_at,updated_at)
        VALUES(?,?,?,?,'Active',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [external(index), identities[name].externalId, `TEST ONLY ${name} fixture`, quoted ? "Proposal/Price Quote" : "Closed Won",
        "TEST ONLY synthetic account", "TEST ONLY synthetic contact", `${name}.${hex}@example.invalid`, "0000000000", "Isolated fixture address", marker,
        reference, quoted ? null : reference, quoted ? reference : null, quoted ? now : null, quoteId, quoted ? reference : null, totals?.subtotal ?? "100.10", now, now]);
      ensureCrmDemo(id !== "0");
      if (quotation && totals) {
        const { items, ...header } = quotation;
        const quotationId = await insert(connection, `INSERT INTO crm_quotations(task_id,external_id,quote_number,header_json,totals_json,calculation_policy,
          remote_modified_at,created_at,updated_at) VALUES(?,?,?,?,?,'percentage-create-v1',?,?,?)`, [id, quoteId, reference, JSON.stringify(header), JSON.stringify(totals), now, now, now]);
        ensureCrmDemo(quotationId !== "0");
        const item = items[0]!;
        await insert(connection, `INSERT INTO proposal_items(quotation_id,task_id,position,product_id,product_name,product_description,uom,quantity,service_charge,item_discount,total)
          VALUES(?,?,0,?,?,?,?,?,?,?,?)`, [quotationId, id, productId, item.productName, item.description, item.uom, item.quantity, item.unitPrice, item.itemDiscount, totals.lineTotals[0]]);
      }
      return id;
    }
    const jobId = await task(7, "operator", false), contractingTaskId = await task(8, "contracting", true), switchgearTaskId = await task(9, "switchgear", true);
    commitStarted = true; await connection.commit();
    const fixture = Object.freeze({ fixtureId, database, marker, password, identities: Object.freeze(identities), jobId, contractingTaskId, switchgearTaskId, productId });
    owners.set(fixture, { used: false, httpUsed: false, chromiumUsed: false, marker, database, userIds: names.map(name => identities[name].id), taskIds: [jobId, contractingTaskId, switchgearTaskId] });
    return fixture;
  } catch {
    if (begun && !commitStarted) { try { await connection.rollback(); } catch { destroy(connection); } }
    else destroy(connection); // Ambiguous begin/commit must never be retried or cleaned up.
    throw new CrmDemoCaseError();
  }
}
