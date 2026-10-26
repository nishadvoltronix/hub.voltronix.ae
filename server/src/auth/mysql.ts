import { createMysqlAuthDatabase } from "../db/mysql/database.js";
import { createMysqlAuthStore } from "./mysql-store.js";
import { createAuthService } from "./service.js";

/** Explicit private composition, not CLI activation or permission to connect.
 * Construction validates only. Calls on auth acquire real MySQL connections.
 * Caller owns close after HTTP drain; no profiles, migrations, seeds or retries.
 */
export function createMysqlAuthentication(configuration: unknown) {
  const database = createMysqlAuthDatabase(configuration);
  return { auth: createAuthService(createMysqlAuthStore(database)), close: database.close };
}
