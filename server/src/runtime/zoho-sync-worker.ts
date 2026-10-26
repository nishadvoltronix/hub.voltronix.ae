interface Scheduler {
  schedule(callback: () => void, delayMs: number): () => void;
}
const scheduler: Scheduler = { schedule(callback, delayMs) {
  const timer = setTimeout(callback, delayMs); timer.unref();
  return () => clearTimeout(timer);
} };

/** One owned pass at a time. The coordinator persists checkpoints and failures;
 * this timer neither retries provider writes nor determines imported ownership. */
export function createZohoSyncWorker(options: {
  intervalMs: number;
  run(signal: AbortSignal): Promise<unknown>;
  abortSource(): void | Promise<void>;
}, timers: Scheduler = scheduler) {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 60_000 || options.intervalMs > 86_400_000) {
    throw new Error("Invalid inbound polling interval.");
  }
  let started = false, closed = false, cancel: (() => void) | undefined;
  let running: Promise<void> | undefined, closing: Promise<void> | undefined;
  const abort = new AbortController();
  const cycle = () => {
    if (closed || running) return;
    running = Promise.resolve().then(() => {
      if (!closed) return options.run(abort.signal);
    }).then(() => {}, () => {
      // Only the coordinator records a bounded error code. Provider/driver
      // errors may contain record contents and must not reach console output.
    }).finally(() => {
      running = undefined;
      if (!closed) cancel = timers.schedule(cycle, options.intervalMs);
    });
  };
  return {
    start(): void {
      if (closed || started) return;
      started = true; cycle();
    },
    close(): Promise<void> {
      return closing ??= (async () => {
        closed = true; cancel?.(); abort.abort();
        const results = await Promise.allSettled([Promise.resolve().then(options.abortSource), running]);
        if (results.some(result => result.status === "rejected")) throw new Error("Inbound worker shutdown failed.");
      })();
    },
  };
}
