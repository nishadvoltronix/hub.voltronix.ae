import { AsyncLocalStorage } from "node:async_hooks";
import { validateLocalMysqlConfig, type LocalMysqlConfig } from "../../config/mysql.js";
import { connectMysql, type MysqlConnector, type MysqlWireConnection } from "./driver.js";
import { assertMysqlMigrationsCurrent } from "./migrations.js";

export class MysqlDatabaseError extends Error {
  readonly code: "MYSQL_CONFLICT" | "MYSQL_UNAVAILABLE" | "MYSQL_FOREIGN_KEY" | "MYSQL_CHECK" | "MYSQL_SIGNAL";
  constructor(failure: boolean | "MYSQL_FOREIGN_KEY" | "MYSQL_CHECK" | "MYSQL_SIGNAL" = false) {
    super("MySQL operation unavailable; no fallback or automatic retry was attempted."); this.name = "MysqlDatabaseError";
    this.code = typeof failure === "string" ? failure : failure ? "MYSQL_CONFLICT" : "MYSQL_UNAVAILABLE";
  }
}
interface Lease { active: boolean; aborted: Promise<never>; abort: () => void; connection?: MysqlWireConnection }
interface Context { connection: MysqlWireConnection; active: boolean; lease: Lease; transaction: boolean; depth: number; nested: boolean }
function destroyConnection(connection: MysqlWireConnection) { try { connection.destroy(); } catch { /* Never relay driver cleanup details. */ } }
interface Field { name: string; columnType: number }
const integers = new Set([1, 2, 3, 8, 9, 13]);
function integer(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?[0-9]+$/.test(value)) return BigInt(value);
  throw new MysqlDatabaseError();
}
function rows(result: unknown, fields: unknown, allBigInts: boolean): Record<string, unknown>[] {
  if (!Array.isArray(result) || !Array.isArray(fields)) throw new MysqlDatabaseError();
  return result.map((row) => {
    const output = { ...row } as Record<string, unknown>;
    for (const field of fields as Field[]) {
      const value = output[field.name];
      if (value === null || value === undefined || !integers.has(field.columnType)) continue;
      const exact = integer(value);
      output[field.name] = !allBigInts && exact >= BigInt(Number.MIN_SAFE_INTEGER) && exact <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(exact) : exact;
    }
    return output;
  });
}
function parameters(values: readonly unknown[]) {
  return values.map((value) => {
    if (typeof value === "bigint") return value.toString();
    if (value === null || typeof value === "string" || Buffer.isBuffer(value) || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
    throw new MysqlDatabaseError();
  });
}

/** Async application boundary. SQLite is deliberately absent from this module. */
export class MysqlDatabase {
  private readonly context = new AsyncLocalStorage<Context>();
  private closed = false;
  private readonly leases = new Set<Lease>();
  private stopping: Promise<void> | undefined;
  private drained: (() => void) | undefined;
  private readonly config: LocalMysqlConfig;
  private readonly connector: MysqlConnector;
  private readonly verify: (connection: MysqlWireConnection, database: string) => Promise<void>;

  constructor(config: LocalMysqlConfig, options: { connect?: MysqlConnector;
    verify?: (connection: MysqlWireConnection, database: string) => Promise<void> } = {}) {
    this.config = validateLocalMysqlConfig(config);
    this.connector = options.connect ?? connectMysql;
    this.verify = options.verify ?? assertMysqlMigrationsCurrent;
  }
  get inTransaction() { return this.context.getStore()?.transaction === true; }
  /** Only the composition owner closes after HTTP drain. No new work is accepted;
   * active work drains, then owned sockets and callbacks are aborted at deadline. */
  close(deadlineMs = 5_000): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 5_000) return Promise.reject(new MysqlDatabaseError());
    this.closed = true;
    this.stopping = new Promise<void>(resolve => {
      if (!this.leases.size) { resolve(); return; }
      const timer = setTimeout(() => { for (const lease of this.leases) lease.abort(); resolve(); }, deadlineMs);
      this.drained = () => { clearTimeout(timer); resolve(); };
    });
    return this.stopping;
  }

  private async connection<T>(work: (context: Context) => Promise<T>): Promise<T> {
    const existing = this.context.getStore();
    if (existing) {
      if (!existing.active || !existing.lease.active) throw new MysqlDatabaseError();
      return work(existing);
    }
    if (this.closed || this.leases.size >= 16) throw new MysqlDatabaseError();
    let cancel!: () => void;
    const aborted = new Promise<never>((_, reject) => { cancel = () => reject(new MysqlDatabaseError()); });
    void aborted.catch(() => {});
    const lease: Lease = { active: true, aborted, abort: () => {
      lease.active = false; if (lease.connection) destroyConnection(lease.connection); cancel();
    } };
    this.leases.add(lease);
    const wait = <R>(promise: Promise<R>): Promise<R> => Promise.race([promise, aborted]);
    let context: Context | undefined;
    try {
      let raw: MysqlWireConnection;
      try { raw = await wait(Promise.resolve().then(() => this.connector(this.config)).then(opened => {
        if (!lease.active) { destroyConnection(opened); throw new MysqlDatabaseError(); }
        lease.connection = opened; return opened;
      })); } catch { throw new MysqlDatabaseError(); }
      const connection: MysqlWireConnection = {
        execute: (sql, values) => wait(raw.execute(sql, values)), query: sql => wait(raw.query(sql)),
        beginTransaction: () => wait(raw.beginTransaction()), commit: () => wait(raw.commit()),
        rollback: () => wait(raw.rollback()), end: () => wait(raw.end()), destroy: () => destroyConnection(raw),
      };
      context = { connection, active: true, lease, transaction: false, depth: 0, nested: false };
      try {
        await connection.query("SET SESSION time_zone = '+00:00'");
        await connection.query("SET SESSION sql_mode = 'STRICT_ALL_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'");
        await connection.query("SET SESSION innodb_lock_wait_timeout = 5");
        await connection.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        await connection.query("SET SESSION autocommit = 1");
        await connection.query("SET SESSION foreign_key_checks = 1");
        await connection.query("SET SESSION unique_checks = 1");
        await wait(this.verify(connection, this.config.database));
      } catch { throw new MysqlDatabaseError(); }
      const current = context;
      return await wait(this.context.run(current, () => work(current)));
    } finally {
      if (context) context.active = false;
      if (lease.connection) {
        try { await wait(lease.connection.end()); } catch { destroyConnection(lease.connection); }
      }
      lease.active = false;
      this.leases.delete(lease);
      if (!this.leases.size) this.drained?.();
    }
  }

  /** AuthStore needs original mutation warningStatus, not a synthesized success.
   * Share this CRM identity/verification and lock, but expose a callback-only raw
   * prepared DML facade with stricter non-overlap and detached-work rejection. */
  async authTransaction<T>(work: (transaction: { execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]> }) => Promise<T>): Promise<T> {
    const parent = this.context.getStore();
    if (parent) { parent.lease.abort(); throw new MysqlDatabaseError(); }
    return this.transaction(async () => {
      const context = this.context.getStore()!;
      let active = true, busy = false, poisoned = false;
      const execute = (sql: string, values: readonly unknown[] = []): Promise<[unknown, unknown]> => {
        const operation = async (): Promise<[unknown, unknown]> => {
          if (!active || busy || poisoned || !context.active || !context.lease.active || this.context.getStore() !== context
            || !/^(?:SELECT|INSERT|UPDATE|DELETE)\s/i.test(sql) || /;|\/\*|--|\b(?:OUTFILE|DUMPFILE|LOAD_FILE)\b/i.test(sql)) {
            poisoned = true; throw new MysqlDatabaseError();
          }
          busy = true;
          try { return await context.connection.execute(sql, parameters(values)); }
          catch { poisoned = true; throw new MysqlDatabaseError(); }
          finally { busy = false; }
        };
        const result = operation(); void result.catch(() => {}); return result;
      };
      try {
        const result = await work(Object.freeze({ execute }));
        if (busy || poisoned) { context.lease.abort(); throw new MysqlDatabaseError(); }
        return result;
      } finally {
        active = false;
        if (busy) context.lease.abort();
      }
    })();
  }

  prepare(sql: string) {
    // Application services cannot run migrations, import files or control transactions through this API.
    if (!/^\s*(SELECT|WITH|INSERT|UPDATE|DELETE)\b/i.test(sql) || /\b(?:INTO\s+(?:OUTFILE|DUMPFILE)|LOAD_FILE\s*\()/i.test(sql)) throw new MysqlDatabaseError();
    let allBigInts = false;
    const execute = (values: unknown[]) => this.connection(async ({ connection }) => {
      try { return await connection.execute(sql, parameters(values)); } catch (error) {
        const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
        throw new MysqlDatabaseError(code === "ER_NO_REFERENCED_ROW_2" || code === "ER_ROW_IS_REFERENCED_2" ? "MYSQL_FOREIGN_KEY" :
          code === "ER_CHECK_CONSTRAINT_VIOLATED" ? "MYSQL_CHECK" : code === "ER_SIGNAL_EXCEPTION" ? "MYSQL_SIGNAL" : code === "ER_DUP_ENTRY");
      }
    });
    const statement = {
      safeIntegers(enabled = true) { allBigInts = enabled; return statement; },
      async all(...values: unknown[]): Promise<unknown[]> { const [result, fields] = await execute(values); return rows(result, fields, allBigInts); },
      async get(...values: unknown[]): Promise<unknown> { const [result, fields] = await execute(values); return rows(result, fields, allBigInts)[0]; },
      async run(...values: unknown[]) {
        const [result] = await execute(values);
        const packet = result as { affectedRows?: unknown; insertId?: unknown };
        if (!Number.isSafeInteger(packet.affectedRows) || Number(packet.affectedRows) < 0) throw new MysqlDatabaseError();
        return { changes: Number(packet.affectedRows), lastInsertRowid: integer(packet.insertId ?? 0) };
      },
    };
    return statement;
  }

  transaction<Args extends unknown[], Result>(work: (...args: Args) => Promise<Result>) {
    const invoke = (...args: Args): Promise<Result> => this.connection(async (context) => {
      if (context.transaction) {
        // Sibling Promise.all transactions cannot safely share savepoints. Fail closed; callers await sequentially.
        if (context.nested) throw new MysqlDatabaseError();
        context.nested = true;
        const nested: Context = { ...context, depth: context.depth + 1, nested: false };
        const savepoint = `crm_nested_${nested.depth}`;
        try {
          try { await context.connection.query(`SAVEPOINT ${savepoint}`); } catch { throw new MysqlDatabaseError(); }
          let result: Result;
          try { result = await this.context.run(nested, () => work(...args)); }
          catch (error) {
            if (!context.lease.active) throw new MysqlDatabaseError();
            try { await context.connection.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
              await context.connection.query(`RELEASE SAVEPOINT ${savepoint}`);
            } catch { context.active = false; context.lease.active = false; destroyConnection(context.connection); throw new MysqlDatabaseError(); }
            throw error;
          }
          if (!context.lease.active || nested.nested) {
            context.lease.active = false;
            destroyConnection(context.connection);
            throw new MysqlDatabaseError();
          }
          try { await context.connection.query(`RELEASE SAVEPOINT ${savepoint}`); }
          catch { context.active = false; context.lease.active = false; destroyConnection(context.connection); throw new MysqlDatabaseError(); }
          return result;
        } finally { nested.active = false; context.nested = false; }
      }
      let committed = false;
      try {
        try {
          await context.connection.beginTransaction();
          context.transaction = true;
          // One conservative application-wide lock preserves the previous cross-journal write ordering.
          const [lock] = await context.connection.execute("SELECT id FROM crm_app_lock WHERE id=1 FOR UPDATE");
          if (!Array.isArray(lock) || lock.length !== 1) throw new MysqlDatabaseError();
        } catch { throw new MysqlDatabaseError(); }
        const result = await work(...args);
        if (context.nested || !context.lease.active) throw new MysqlDatabaseError();
        try { await context.connection.commit(); committed = true; }
        catch { context.active = false; context.lease.active = false; destroyConnection(context.connection); throw new MysqlDatabaseError(); }
        return result;
      } finally {
        if (!committed && context.active) {
          context.lease.active = false;
          try { await context.connection.rollback(); } catch { context.active = false; destroyConnection(context.connection); }
        }
        context.transaction = false;
      }
    });
    return Object.assign(invoke, { immediate: invoke });
  }
}
