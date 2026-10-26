export type ReadinessProbe = () => Promise<boolean>;

/** A redacted, bounded, single-flight dependency check. A timed-out operation
 * remains owned until it settles: polling never starts unbounded DB leases or
 * cancels application work. The database owner supplies its read-only check. */
export function createReadinessProbe(check: () => Promise<void>, deadlineMs = 5_000): ReadinessProbe {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 5_000) throw new Error("Invalid readiness deadline.");
  let pending: Promise<boolean> | undefined;
  return async () => {
    pending ??= Promise.resolve().then(check).then(() => true, () => false).finally(() => { pending = undefined; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([pending, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), deadlineMs); })]);
    } finally { if (timer) clearTimeout(timer); }
  };
}
