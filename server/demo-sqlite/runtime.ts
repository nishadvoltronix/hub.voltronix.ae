import type { SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { assertMigrationsCurrent } from "../../tests/sqlite-reference/db/migrations.js";
import { createAuthService } from "../src/auth/service.js";
import { createSqliteAuthStore, createSqliteExecutor } from "./auth-store.js";
import { createSqliteCrmServices } from "./services.js";

/** The caller explicitly opens only its isolated, already initialized demo DB.
 * Construction neither migrates, seeds, selects a path nor starts a listener.
 * The returned close must follow HTTP drain; it refuses fresh work, waits for
 * owned operations, then closes this connection exactly once. */
export function createSqliteDemoRuntime(db: SqliteDatabase) {
  assertMigrationsCurrent(db);
  if (db.readonly || db.inTransaction || db.pragma("foreign_keys", { simple: true }) !== 1) {
    throw new Error("SQLite demo requires an initialized writable connection with foreign keys enabled.");
  }
  const executor = createSqliteExecutor(db);
  const auth = createAuthService(createSqliteAuthStore(db, executor));
  const services = createSqliteCrmServices(db, executor);
  return { auth, services, close: () => executor.close() };
}
