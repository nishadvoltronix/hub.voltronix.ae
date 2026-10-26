import assert from "node:assert/strict";
import test from "node:test";
import { assertMysqlMigrationsCurrent, inspectMysqlApplicationSchema, migrateMysqlApplicationSchema, MysqlMigrationError, mysqlMigrations,
  type MysqlMigrationSession } from "../src/crm/db/mysql/migrations.js";
import { mysqlExpectedIndexes, mysqlExpectedTables, mysqlExpectedTriggers } from "../src/crm/db/mysql/schema.js";

// OFFLINE metadata/ledger double only; no SQL parser/server or database files.
function fixture(initialVersion = 0) {
  const tables = new Set<string>(), triggers = new Set<string>();
  const calls: { sql: string; values: unknown[]; ddl: boolean }[] = [];
  const history: { version: number; name: string; checksum: string; state: string }[] = [];
  const state = { database: "crm_local_dev", acquired: 1, released: 1, upgraded: false, lockRow: false,
    failDdl: "", malformedColumns: false, malformedCheck: false, alteredGrouping: false, unenforcedCheck: false, unknownCheck: false, missingIndex: "",
    lengthExpression: "(length(`content`) = `file_size`)", productNamesWide:new Set<string>(),malformedProductName:false };
  function applyStatement(sql: string) {
    const table = /^CREATE TABLE ([a-z_]+) /u.exec(sql)?.[1], trigger = /^CREATE TRIGGER ([a-z_]+) /u.exec(sql)?.[1];
    if (table) { assert.equal(tables.has(table), false); tables.add(table); }
    else if (trigger) { assert.equal(triggers.has(trigger), false); triggers.add(trigger); }
    else if (sql === "INSERT INTO crm_app_lock(id) VALUES (1)") state.lockRow = true;
    else if (sql.startsWith("ALTER TABLE crm_department_log_attachments")) { assert.equal(state.upgraded, false); state.upgraded = true; }
    else if (/^ALTER TABLE (products|proposal_items|crm_zoho_quotation_items) MODIFY product_name VARCHAR\(255\) NOT NULL$/.test(sql)) state.productNamesWide.add(sql.split(" ")[2]!);
    else throw new Error("Unexpected synthetic DDL");
  }
  if (initialVersion) {
    tables.add("crm_mysql_schema_migrations");
    for (const migration of mysqlMigrations.slice(0, initialVersion)) {
      migration.statements.forEach(applyStatement);
      history.push({ version: migration.version, name: migration.name, checksum: migration.checksum, state: "completed" });
    }
  }
  const session: MysqlMigrationSession = {
    async execute(sql, values = []) {
      calls.push({ sql, values, ddl: false });
      if (sql.startsWith("SELECT DATABASE()")) return [[{ selectedDatabase: state.database, serverVersion: "8.4.11", versionComment: "MySQL Community Server - GPL", autocommit: 1 }], []];
      if (sql.startsWith("SELECT GET_LOCK")) return [[{ acquired: state.acquired }], []];
      if (sql.startsWith("SELECT RELEASE_LOCK")) return [[{ released: state.released }], []];
      if (sql.includes("FROM information_schema.TABLES")) return [[...tables].map(name => ({ name, type: "BASE TABLE", engine: "InnoDB" })), []];
      if (sql.includes("FROM information_schema.TRIGGERS")) return [[...triggers].map(name => ({ name })), []];
      if (sql.includes("FROM information_schema.ROUTINES") || sql.includes("FROM information_schema.EVENTS")) return [[], []];
      if (sql.includes("FROM information_schema.STATISTICS")) return [mysqlExpectedIndexes.filter(index => tables.has(index.table) && index.name !== state.missingIndex)
        .flatMap(index => index.columns.map((columnName, position) => ({ tableName: index.table, name: index.name,
          columnName, nonUnique: Number(!index.unique), position: position + 1 }))), []];
      if(sql.includes("COLUMN_NAME='product_name'"))return [["products","proposal_items","crm_zoho_quotation_items"].filter(table=>tables.has(table)).map(tableName=>({
        tableName,name:"product_name",type:state.malformedProductName?"varchar(201)":state.productNamesWide.has(tableName)?"varchar(255)":"varchar(200)",nullable:"NO",collation:"utf8mb4_0900_bin"})),[]];
      if (sql.includes("FROM information_schema.COLUMNS")) return [[
        { name: "file_size", type: "int", nullable: "NO" },
        { name: "content", type: state.malformedColumns ? "blob" : state.upgraded ? "longblob" : "mediumblob", nullable: "NO" },
      ], []];
      if (sql.includes("FROM information_schema.TABLE_CONSTRAINTS")) return [[
        { name: state.unknownCheck ? "unreviewed_constraint" : state.upgraded ? "crm_log_attachment_size_v3" : "crm_department_log_attachments_chk_1",
          expression: state.malformedCheck ? "file_size >= 0" : state.alteredGrouping ? `(file_size > (0 and file_size)) <= ${state.upgraded ? 52428800 : 16384000}`
            : `((\`file_size\` > 0) and (\`file_size\` <= ${state.upgraded ? 52428800 : 16384000}))`, enforced: state.unenforcedCheck ? "NO" : "YES" },
        { name: "crm_department_log_attachments_chk_2", expression: state.lengthExpression, enforced: "YES" },
      ], []];
      if (sql.startsWith("SELECT version,name,checksum,state")) return [history.map(row => ({ ...row })), []];
      if (sql.startsWith("SELECT id FROM crm_app_lock")) return [state.lockRow ? [{ id: 1 }] : [], []];
      if (sql.startsWith("INSERT INTO crm_mysql_schema_migrations")) {
        history.push({ version: values[0] as number, name: values[1] as string, checksum: values[2] as string, state: "applying" });
        return [{ affectedRows: 1 }, []];
      }
      if (sql.startsWith("UPDATE crm_mysql_schema_migrations")) {
        const record = history.find(row => row.version === values[0] && row.checksum === values[1] && row.state === "applying");
        if (record) record.state = "completed";
        return [{ affectedRows: Number(!!record) }, []];
      }
      throw new Error("Unexpected synthetic statement");
    },
    async query(sql) {
      calls.push({ sql, values: [], ddl: true });
      if (state.failDdl && sql.includes(state.failDdl)) throw new Error("private injected driver detail");
      applyStatement(sql);
      return [{ affectedRows: 0 }, []];
    },
  };
  return { session, state, history, tables, triggers, calls, options: { database: state.database, allowSchemaChanges: true as const } };
}

test("OFFLINE MySQL fresh target applies all five manifests in order and repeat is read-only", async () => {
  const f = fixture();
  assert.equal(await migrateMysqlApplicationSchema(f.session, f.options), 5);
  assert.deepEqual(f.history.map(row => [row.version, row.state]), [[1, "completed"], [2, "completed"], [3, "completed"], [4, "completed"], [5, "completed"]]);
  assert.deepEqual([...f.tables].sort(), ["crm_mysql_schema_migrations", ...mysqlExpectedTables].sort());
  assert.deepEqual([...f.triggers].sort(), [...mysqlExpectedTriggers].sort());
  for (const migration of mysqlMigrations) {
    const ledger = f.calls.findIndex(call => call.sql.startsWith("INSERT INTO crm_mysql_schema_migrations") && call.values[0] === migration.version);
    const firstDdl = f.calls.findIndex(call => call.sql === migration.statements[0]);
    const completed = f.calls.findIndex(call => call.sql.startsWith("UPDATE crm_mysql_schema_migrations") && call.values[0] === migration.version);
    assert.ok(ledger < firstDdl && firstDdl < completed);
  }
  const start = f.calls.length;
  assert.equal(await migrateMysqlApplicationSchema(f.session, f.options), 0);
  assert.ok(f.calls.slice(start).every(call => call.sql.startsWith("SELECT ")));
});

test("OFFLINE operator inspection checks empty and exact migration prefixes without acquiring locks or writing", async () => {
  for (const version of [0, 1, 2, 3, 4, 5]) {
    const f = fixture(version);
    assert.deepEqual(await inspectMysqlApplicationSchema(f.session, f.options.database), { installed: version, pending: 5 - version });
    assert.ok(f.calls.every(call => call.sql.startsWith("SELECT ") && !call.sql.includes("GET_LOCK")));
  }
  const unknown = fixture(); unknown.tables.add("private_unowned_records");
  await assert.rejects(inspectMysqlApplicationSchema(unknown.session, unknown.options.database), MysqlMigrationError);
  const interrupted = fixture(1); interrupted.history[0]!.state = "applying";
  await assert.rejects(inspectMysqlApplicationSchema(interrupted.session, interrupted.options.database), MysqlMigrationError);
});

test("OFFLINE MySQL target upgrades the exact v1 prefix without rerunning foundation or adopting data", async () => {
  const f = fixture(1), saved = JSON.stringify(f.history[0]);
  assert.equal(await migrateMysqlApplicationSchema(f.session, f.options), 4);
  assert.equal(JSON.stringify(f.history[0]), saved);
  assert.ok(f.calls.filter(call => call.ddl).every(call => !mysqlMigrations[0].statements.includes(call.sql)));
  assert.equal(f.calls.some(call => /^(?:INSERT|UPDATE|DELETE) (?!INTO crm_mysql_schema_migrations|crm_mysql_schema_migrations)/u.test(call.sql)), false);
});

test("OFFLINE MySQL target refuses prefix drift and additional objects before any pending migration write", async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => { f.tables.add("preserved_private_table"); },
    (f: ReturnType<typeof fixture>) => { f.tables.delete("users"); },
    (f: ReturnType<typeof fixture>) => { f.triggers.delete("crm_audit_events_no_update"); },
    (f: ReturnType<typeof fixture>) => { f.history[0]!.checksum = "0".repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.history[0]!.state = "applying"; },
    (f: ReturnType<typeof fixture>) => { f.state.missingIndex = "idx_tasks_assigned_to"; },
  ];
  for (const mutate of mutations) {
    const f = fixture(1); mutate(f);
    await assert.rejects(migrateMysqlApplicationSchema(f.session, f.options), MysqlMigrationError);
    assert.ok(f.calls.every(call => call.sql.startsWith("SELECT ")));
  }
});

test("OFFLINE attachment ALTER preflight refuses renamed, weakened, unenforced or unexpected storage without repair", async () => {
  for (const property of ["malformedColumns", "malformedCheck", "alteredGrouping", "unenforcedCheck", "unknownCheck"] as const) {
    const f = fixture(2); f.state[property] = true;
    await assert.rejects(migrateMysqlApplicationSchema(f.session, f.options), error => {
      assert.ok(error instanceof MysqlMigrationError); assert.equal(error.stage, "department-attachment-preflight"); return true;
    });
    assert.ok(f.calls.every(call => call.sql.startsWith("SELECT ")));
    assert.equal(f.state.upgraded, false);
  }
});

test("OFFLINE product-name widening requires exact prior and current capacity in catalog and both quote lineages",async()=>{
  const upgrade=fixture(4),before=JSON.stringify(upgrade.history);
  assert.equal(await migrateMysqlApplicationSchema(upgrade.session,upgrade.options),1);
  assert.equal(JSON.stringify(upgrade.history.slice(0,4)),before);
  assert.deepEqual([...upgrade.state.productNamesWide].sort(),["crm_zoho_quotation_items","products","proposal_items"]);
  for(const version of [4,5]) {
    const altered=fixture(version);altered.state.malformedProductName=true;
    await assert.rejects(version===4?migrateMysqlApplicationSchema(altered.session,altered.options):assertMysqlMigrationsCurrent(altered.session,altered.options.database),MysqlMigrationError);
    assert.ok(altered.calls.every(call=>call.sql.startsWith("SELECT ")));
  }
  for(const patch of [{nullable:"YES"},{collation:"utf8mb4_0900_ai_ci"},{name:"renamed_product"}]) {
    const changed=fixture(4),execute=changed.session.execute.bind(changed.session);
    changed.session.execute=async(sql,values)=>{
      const result=await execute(sql,values);
      if(sql.includes("COLUMN_NAME='product_name'"))return [(result[0] as Record<string,unknown>[]).map((row,index)=>index===0?{...row,...patch}:row),result[1]];
      return result;
    };
    await assert.rejects(migrateMysqlApplicationSchema(changed.session,changed.options),MysqlMigrationError);
    assert.ok(changed.calls.every(call=>call.sql.startsWith("SELECT ")));
  }
});

test("OFFLINE attachment guards accept MySQL byte-length canonicalization and reject changed semantics", async () => {
  for (const expression of ["(length(`content`) = `file_size`)", "(octet_length(`content`) = `file_size`)"]) {
    const upgrade = fixture(2); upgrade.state.lengthExpression = expression;
    assert.equal(await migrateMysqlApplicationSchema(upgrade.session, upgrade.options), 3);
    const runtime = fixture(5); runtime.state.lengthExpression = expression;
    await assertMysqlMigrationsCurrent(runtime.session, runtime.options.database);
  }
  for (const expression of ["(char_length(`content`) = `file_size`)", "(character_length(`content`) = `file_size`)",
    "(length(`content`) <= `file_size`)", "(length(`content`) = (`file_size` or 1))"]) {
    const upgrade = fixture(2); upgrade.state.lengthExpression = expression;
    await assert.rejects(migrateMysqlApplicationSchema(upgrade.session, upgrade.options), MysqlMigrationError);
    assert.ok(upgrade.calls.every(call => call.sql.startsWith("SELECT ")));
    const runtime = fixture(5); runtime.state.lengthExpression = expression;
    await assert.rejects(assertMysqlMigrationsCurrent(runtime.session, runtime.options.database), MysqlMigrationError);
    assert.ok(runtime.calls.every(call => call.sql.startsWith("SELECT ")));
  }
});

test("OFFLINE failed MySQL target DDL leaves applying receipt and refuses auto-resume or fictitious rollback", async () => {
  const f = fixture(2); f.state.failDdl = "CREATE TRIGGER crm_log_attachment_department_limit";
  await assert.rejects(migrateMysqlApplicationSchema(f.session, f.options), error => {
    assert.ok(error instanceof MysqlMigrationError); assert.equal(error.stage, "migration-3-statement-2");
    assert.doesNotMatch(error.message, /private injected/); return true;
  });
  assert.equal(f.state.upgraded, true); assert.equal(f.history[2]!.state, "applying");
  const start = f.calls.length;
  await assert.rejects(migrateMysqlApplicationSchema(f.session, f.options), MysqlMigrationError);
  assert.ok(f.calls.slice(start).every(call => call.sql.startsWith("SELECT ")));
  assert.ok(f.calls.every(call => !/ROLLBACK|DROP TABLE|TRUNCATE/u.test(call.sql)));
});

test("OFFLINE MySQL target runtime guard requires complete current lineage and exact department storage without writes", async () => {
  await assert.rejects(assertMysqlMigrationsCurrent(fixture(1).session, "crm_local_dev"), MysqlMigrationError);
  for (const property of ["malformedColumns", "malformedCheck", "alteredGrouping", "unenforcedCheck", "unknownCheck"] as const) {
    const f = fixture(5); f.state[property] = true;
    await assert.rejects(assertMysqlMigrationsCurrent(f.session, f.options.database), MysqlMigrationError);
    assert.ok(f.calls.every(call => call.sql.startsWith("SELECT ")));
  }
  const f = fixture(5);
  await assertMysqlMigrationsCurrent(f.session, f.options.database);
  assert.ok(f.calls.every(call => call.sql.startsWith("SELECT ")));
});

test("OFFLINE target migration requires explicit acknowledgement and exclusive advisory ownership", async () => {
  const f = fixture(1);
  await assert.rejects(migrateMysqlApplicationSchema(f.session, { ...f.options, allowSchemaChanges: false } as unknown as typeof f.options), MysqlMigrationError);
  assert.equal(f.calls.length, 0);
  f.state.acquired = 0;
  await assert.rejects(migrateMysqlApplicationSchema(f.session, f.options), MysqlMigrationError);
  assert.ok(f.calls.every(call => call.sql.startsWith("SELECT ")));
  assert.equal(f.calls.some(call => call.sql.startsWith("SELECT RELEASE_LOCK")), false);
});
