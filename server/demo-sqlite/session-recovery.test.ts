import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { hashSync } from "bcryptjs";
import { configureDatabase, type SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { migrateDatabase } from "../../tests/sqlite-reference/db/migrations.js";
import { createAuthService, SESSION_LIFETIME_MS } from "../src/auth/service.js";
import { createSqliteAuthStore, createSqliteExecutor } from "./auth-store.js";

const Database = createRequire(new URL("../../package.json", import.meta.url))("better-sqlite3") as new (filename: string) => SqliteDatabase;
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("isolated real SQLite normal reauthentication prunes expired owner tokens and preserves unrelated valid sessions/data", async () => {
  const db = new Database(":memory:"); configureDatabase(db); migrateDatabase(db);
  const executor = createSqliteExecutor(db), password = "Synthetic recovery test only", passwordHash = hashSync(password, 4);
  try {
    for (const id of [1, 2]) db.prepare("INSERT INTO users(id,user_id,username,email,password,status,role) VALUES(?,?,?,?,?,'active','synthetic-demo')")
      .run(id, `recovery-${id}`, `Recovery ${id}`, `recovery-${id}@example.invalid`, passwordHash);
    db.prepare('INSERT INTO permissions(id,"key",label) VALUES(1,?,?)').run("dashboard.view", "Dashboard");
    db.prepare("INSERT INTO admin_user_permissions(admin_user_id,permission_id) VALUES(1,1)").run();
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
      .map(row => row.name).filter(name => !["crm_sessions", "crm_login_attempts"].includes(name));
    const protectedData = () => fingerprint(tables.map(name => [name, db.prepare(`SELECT * FROM ${quote(name)}`).all()]));
    const before = protectedData(), schema = fingerprint(db.prepare("SELECT * FROM sqlite_master ORDER BY name").all());
    let now = 1_000_000;
    const auth = createAuthService(createSqliteAuthStore(db, executor), { now: () => now });
    const originalOwner = await auth.login("recovery-1@example.invalid", password);
    now += 60_000;
    const unrelated = await auth.login("recovery-2@example.invalid", password);
    const unrelatedRow = fingerprint(db.prepare("SELECT * FROM crm_sessions WHERE user_id=2").get());
    now = 1_000_000 + SESSION_LIFETIME_MS + 1;
    // No direct UPDATE/DELETE or token restoration: advance the injected clock, then use normal login.
    const recoveredOwner = await auth.login("recovery-1@example.invalid", password);
    assert.equal(recoveredOwner.sessionToken === originalOwner.sessionToken, false);
    assert.equal(await auth.authenticate(originalOwner.sessionToken), null);
    assert.equal((await auth.authenticate(recoveredOwner.sessionToken))?.localUserId, "1");
    assert.equal(await auth.verifySessionCsrf(recoveredOwner.sessionToken, recoveredOwner.csrfToken), true);
    assert.equal(await auth.verifySessionCsrf(recoveredOwner.sessionToken, originalOwner.csrfToken), false);
    assert.equal((await auth.authenticate(unrelated.sessionToken))?.localUserId, "2");
    assert.equal(fingerprint(db.prepare("SELECT * FROM crm_sessions WHERE user_id=2").get()), unrelatedRow);
    assert.deepEqual(db.prepare("SELECT user_id FROM crm_sessions ORDER BY user_id").all(), [{ user_id: 1 }, { user_id: 2 }]);
    await auth.logout(recoveredOwner.sessionToken);
    assert.equal(await auth.authenticate(recoveredOwner.sessionToken), null);
    assert.deepEqual(db.prepare("SELECT user_id FROM crm_sessions ORDER BY user_id").all(), [{ user_id: 2 }]);
    assert.equal(fingerprint(db.prepare("SELECT * FROM crm_sessions WHERE user_id=2").get()), unrelatedRow);
    assert.equal(protectedData(), before); assert.equal(fingerprint(db.prepare("SELECT * FROM sqlite_master ORDER BY name").all()), schema);
  } finally { await executor.close(); }
});
