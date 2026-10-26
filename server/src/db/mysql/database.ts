import { AsyncLocalStorage } from "node:async_hooks";
import { AuthError } from "../../auth/errors.js";
import { MysqlAuthDatabaseError, validateMysqlAuthConfig, type MysqlAuthConfig } from "./config.js";
import { connectMysqlAuth, type MysqlAuthConnector, type MysqlAuthWireConnection } from "./driver.js";
import { assertMysqlAuthReady } from "./verification.js";

export interface MysqlAuthSqlTransaction {
  execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
}
export interface MysqlAuthDatabase {
  transaction<T>(work: (transaction: MysqlAuthSqlTransaction) => Promise<T>): Promise<T>;
}
interface Lease {
  usable: boolean; callbackActive: boolean; busy: boolean; poisoned: boolean;
  connection?: MysqlAuthWireConnection;
  aborted: Promise<never>; abort: () => void;
}
const MAX_CONNECTIONS = 16;
const MAX_DRAIN_MS = 5_000;
const sessionSetup = [
  "SET SESSION time_zone = '+00:00'",
  "SET SESSION sql_mode = 'STRICT_ALL_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'",
  "SET SESSION innodb_lock_wait_timeout = 5",
  "SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ",
  "SET SESSION autocommit = 1", "SET SESSION foreign_key_checks = 1", "SET SESSION unique_checks = 1",
] as const;
function destroy(connection: MysqlAuthWireConnection | undefined): void {
  try { connection?.destroy(); } catch { /* never relay cleanup details */ }
}
function safeSql(sql: string): boolean {
  return /^(?:SELECT|INSERT|UPDATE|DELETE)\s/i.test(sql)
    && !/;|\/\*|--|\b(?:OUTFILE|DUMPFILE|LOAD_FILE)\b/i.test(sql);
}

/** One fresh verified connection per callback, shared app lock, no pool or retry.
 * The auth store prohibits nested callbacks; it does not expose general CRM savepoints.
 * Services borrow this facade; only its composition owner closes it.
 */
export function createMysqlAuthDatabase(input: unknown, options: {
  connect?: MysqlAuthConnector;
  verify?: (connection: MysqlAuthWireConnection, config: Readonly<MysqlAuthConfig>) => Promise<void>;
} = {}): MysqlAuthDatabase & { close(deadlineMs?: number): Promise<void> } {
  const config = validateMysqlAuthConfig(input);
  const connect = options.connect ?? connectMysqlAuth, verify = options.verify ?? assertMysqlAuthReady;
  const context = new AsyncLocalStorage<Lease>();
  const leases = new Set<Lease>();
  let closed = false, stopping: Promise<void> | undefined, drained: (() => void) | undefined;

  async function transaction<T>(work: (tx: MysqlAuthSqlTransaction) => Promise<T>): Promise<T> {
    const parent = context.getStore();
    if (parent) { parent.poisoned = true; throw new MysqlAuthDatabaseError(); }
    if (closed || leases.size >= MAX_CONNECTIONS) throw new MysqlAuthDatabaseError();
    let abort!: () => void;
    const aborted = new Promise<never>((_, reject) => { abort = () => reject(new MysqlAuthDatabaseError()); });
    // Cancellation can precede a wire operation. Always observe that rejection.
    void aborted.catch(() => {});
    const lease: Lease = { usable: true, callbackActive: false, busy: false, poisoned: false, aborted,
      abort: () => { lease.usable = false; lease.poisoned = true; destroy(lease.connection); abort(); } };
    leases.add(lease);
    const wait = <R>(promise: Promise<R>): Promise<R> => Promise.race([promise, aborted]);
    let begun = false, committed = false, uncertain = false;
    const ensure = () => { if (!lease.usable || lease.poisoned) throw new MysqlAuthDatabaseError(); };
    const execute = (sql: string, values: readonly unknown[] = []): Promise<[unknown, unknown]> => {
      const operation = async (): Promise<[unknown, unknown]> => {
        if (!lease.usable || !lease.callbackActive || lease.busy || context.getStore() !== lease || !safeSql(sql)) {
          lease.poisoned = true; throw new MysqlAuthDatabaseError();
        }
        ensure();
        lease.busy = true;
        try { return await wait(lease.connection!.execute(sql, values)); }
        catch { lease.poisoned = true; throw new MysqlAuthDatabaseError(); }
        finally { lease.busy = false; }
      };
      const result = operation();
      // Detached rejected work is still refused, without an unhandled rejection.
      void result.catch(() => {});
      return result;
    };
    try {
      const opening = Promise.resolve().then(() => connect(config)).then(connection => {
        if (!lease.usable) { destroy(connection); throw new MysqlAuthDatabaseError(); }
        lease.connection = connection;
        return connection;
      });
      const connection = await wait(opening);
      for (const sql of sessionSetup) { ensure(); await wait(connection.query(sql)); }
      ensure(); await wait(verify(connection, config));
      ensure(); await wait(connection.beginTransaction()); begun = true;
      ensure();
      const [lock] = await wait(connection.execute("SELECT id FROM crm_app_lock WHERE id=1 FOR UPDATE"));
      if (!Array.isArray(lock) || lock.length !== 1 || !lock[0] || typeof lock[0] !== "object"
        || ![1, "1"].includes((lock[0] as { id?: unknown }).id as string | number)) throw new MysqlAuthDatabaseError();
      ensure(); lease.callbackActive = true;
      const result = await wait(context.run(lease, () => work(Object.freeze({ execute }))));
      lease.callbackActive = false;
      if (lease.busy) { lease.abort(); throw new MysqlAuthDatabaseError(); }
      ensure();
      try { await wait(connection.commit()); committed = true; }
      catch { uncertain = true; lease.abort(); throw new MysqlAuthDatabaseError(); }
      return result;
    } catch (error) {
      lease.callbackActive = false;
      if (begun && !committed && !uncertain && lease.usable && !lease.busy) {
        try { await wait(lease.connection!.rollback()); }
        catch { destroy(lease.connection); }
      } else if (!committed) destroy(lease.connection);
      if (error instanceof AuthError) throw error;
      throw new MysqlAuthDatabaseError();
    } finally {
      lease.callbackActive = false;
      if (lease.connection) {
        try { await wait(lease.connection.end()); } catch { destroy(lease.connection); }
      }
      lease.usable = false;
      leases.delete(lease);
      if (!leases.size) drained?.();
    }
  }

  function close(deadlineMs = MAX_DRAIN_MS): Promise<void> {
    if (stopping) return stopping;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_DRAIN_MS) {
      return Promise.reject(new MysqlAuthDatabaseError());
    }
    closed = true;
    stopping = new Promise<void>(resolve => {
      if (!leases.size) { resolve(); return; }
      const timer = setTimeout(() => {
        for (const lease of leases) lease.abort();
        // Late connecting sockets are destroyed by the opening continuation.
        resolve();
      }, deadlineMs);
      drained = () => { clearTimeout(timer); resolve(); };
    });
    return stopping;
  }
  return { transaction, close };
}
