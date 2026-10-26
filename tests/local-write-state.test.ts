import assert from "node:assert/strict";
import test from "node:test";
import { createLocalWriteState } from "../src/components/crm/local-write-state";

test("local submit keeps the same operation on an identical failed-request retry", async () => {
  const state = createLocalWriteState();
  const ids: string[] = [];
  const input = { expectedVersion: 3, title: "Synthetic note" };
  await assert.rejects(state.run(input, async value => { ids.push(value.operationId); throw new Error("connection interrupted"); }));
  const saved = await state.run(input, async value => { ids.push(value.operationId); return { version: 4 }; });
  assert.deepEqual(saved, { version: 4 });
  assert.equal(ids[0], ids[1]);
  await state.run(input, async value => { ids.push(value.operationId); return { version: 4 }; });
  assert.notEqual(ids[1], ids[2]);
});

test("edited payload and deliberate reload with a new version get new operation identifiers", async () => {
  const state = createLocalWriteState();
  const ids: string[] = [];
  for (const input of [{ expectedVersion: 3, title: "First" }, { expectedVersion: 3, title: "Edited" }, { expectedVersion: 4, title: "Edited" }]) {
    await assert.rejects(state.run(input, async value => { ids.push(value.operationId); throw new Error("conflict"); }));
  }
  assert.equal(new Set(ids).size, 3);
});

test("duplicate submits do not dispatch while the first request is unresolved", async () => {
  const state = createLocalWriteState();
  let finish!: (value: { version: number }) => void;
  let sends = 0;
  const send = async () => { sends++; return new Promise<{ version: number }>(resolve => { finish = resolve; }); };
  const first = state.run({ expectedVersion: 1 }, send);
  assert.equal(await state.run({ expectedVersion: 1 }, send), undefined);
  assert.equal(sends, 1);
  finish({ version: 2 });
  assert.deepEqual(await first, { version: 2 });
});
