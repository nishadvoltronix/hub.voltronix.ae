import assert from "node:assert/strict";
import test from "node:test";
import { loadAdminUserOptions, MAX_ADMIN_USER_OPTIONS } from "../src/components/settings/admin-user-options";

const users = Array.from({ length: 101 }, (_, index) => ({ id: String(index + 1), name: `Admin ${index + 1}`, email: `admin${index + 1}@example.invalid` }));
const first = { items: users.slice(0, 100), total: 101, page: 1, pageSize: 100 };
const second = { items: users.slice(100), total: 101, page: 2, pageSize: 100 };

test("admin selector loads all authorized pages in server order", async () => {
  const paths: string[] = [];
  const result = await loadAdminUserOptions(async path => { paths.push(path); return paths.length === 1 ? first : second; });
  assert.deepEqual(result, users);
  assert.deepEqual(paths, ["/api/settings/grant-users?page=1&pageSize=100", "/api/settings/grant-users?page=2&pageSize=100"]);
});

test("admin selector accepts an empty authorized list", async () => {
  assert.deepEqual(await loadAdminUserOptions(async () => ({ items: [], total: 0, page: 1, pageSize: 100 })), []);
});

test("admin selector rejects truncated and inconsistent pages without returning partial choices", async () => {
  for (const value of [
    { ...first, items: first.items.slice(1) }, { ...first, page: 2 }, { ...first, pageSize: 25 },
    { ...first, total: MAX_ADMIN_USER_OPTIONS + 1 }, { ...first, items: [{ ...users[0], id: "0" }, ...first.items.slice(1)] },
  ]) await assert.rejects(loadAdminUserOptions(async () => value), /could not be fully loaded/);
  for (const value of [{ ...second, total: 100 }, { ...second, items: [users[0]] }, { ...second, items: [] }]) {
    let reads = 0;
    await assert.rejects(loadAdminUserOptions(async () => ++reads === 1 ? first : value), /could not be fully loaded/);
  }
});

test("admin selector propagates read errors and aborts instead of offering partial choices", async () => {
  const controller = new AbortController();
  let reads = 0;
  await assert.rejects(loadAdminUserOptions(async () => { reads++; controller.abort(); return first; }, controller.signal), { name: "AbortError" });
  assert.equal(reads, 1);
  await assert.rejects(loadAdminUserOptions(async () => { throw new Error("Access denied."); }), /Access denied/);
});
