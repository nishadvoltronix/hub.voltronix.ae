import assert from "node:assert/strict";
import test from "node:test";
import { createZohoSyncWorker } from "../src/runtime/zoho-sync-worker.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function clock() {
  const pending = new Set<() => void>();
  return { pending, schedule(callback: () => void, delay: number) {
    assert.equal(delay, 60_000); pending.add(callback); return () => { pending.delete(callback); };
  }, fire() { const callbacks = [...pending]; pending.clear(); for (const callback of callbacks) callback(); } };
}

test("inbound worker opens no pass until explicit start and never overlaps or starts twice", async () => {
  const timers = clock(); let calls = 0, resolvePass!: () => void;
  const worker = createZohoSyncWorker({ intervalMs: 60_000, abortSource() {},
    run: async () => { calls++; await new Promise<void>(resolve => { resolvePass = resolve; }); } }, timers);
  await tick(); assert.equal(calls, 0);
  worker.start(); worker.start(); await tick(); assert.equal(calls, 1); assert.equal(timers.pending.size, 0);
  timers.fire(); await tick(); assert.equal(calls, 1);
  resolvePass(); await tick(); assert.equal(timers.pending.size, 1);
  timers.fire(); await tick(); assert.equal(calls, 2); assert.equal(timers.pending.size, 0);
  resolvePass(); await worker.close(); assert.equal(timers.pending.size, 0);
});

test("inbound worker aborts its provider and awaits an in-flight pass before close resolves", async () => {
  const timers = clock(); let signal: AbortSignal | undefined, finish!: () => void, closedSource = 0, complete = false;
  const worker = createZohoSyncWorker({ intervalMs: 60_000, abortSource() { closedSource++; },
    run: async value => { signal = value; await new Promise<void>(resolve => { finish = resolve; }); } }, timers);
  worker.start(); await tick();
  const closing = worker.close(); assert.strictEqual(worker.close(), closing);
  void closing.then(() => { complete = true; });
  await tick(); assert.equal(signal?.aborted, true); assert.equal(closedSource, 1); assert.equal(complete, false);
  finish(); await closing; assert.equal(complete, true); assert.equal(timers.pending.size, 0);
  worker.start(); timers.fire(); await tick(); assert.equal(closedSource, 1);
});

test("failed inbound pass schedules a later bounded poll without leaking the provider error", async () => {
  const timers = clock(); let calls = 0;
  const worker = createZohoSyncWorker({ intervalMs: 60_000, abortSource() {}, run: async () => {
    calls++; throw new Error("synthetic-private-provider-content");
  } }, timers);
  worker.start(); await tick(); assert.equal(calls, 1); assert.equal(timers.pending.size, 1);
  timers.fire(); await tick(); assert.equal(calls, 2); assert.equal(timers.pending.size, 1);
  await worker.close(); assert.equal(timers.pending.size, 0);
});

test("closing an unstarted worker never runs a pass and redacts source shutdown errors", async () => {
  const worker = createZohoSyncWorker({ intervalMs: 60_000,
    run: async () => assert.fail("check-only lifecycle must never apply a pass"),
    abortSource() { throw new Error("synthetic-private-provider-content"); } });
  await assert.rejects(worker.close(), error => error instanceof Error && error.message === "Inbound worker shutdown failed.");
  worker.start();
});
