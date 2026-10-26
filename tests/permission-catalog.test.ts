import assert from "node:assert/strict";
import test from "node:test";
import type { GrantsRecord, GroupRecord, PermissionRecord } from "../src/server/settings/service";
import { checkedGrants, filterPermissionGroups, grantReplacement, loadPermissionEditor, MAX_PERMISSION_CATALOG_RECORDS } from "../src/components/settings/permission-catalog";

function fixture(permissionCount = 105, groupCount = 2) {
  const groups: GroupRecord[] = Array.from({ length: groupCount }, (_, index) => ({ id: String(index + 1), key: `group-${index + 1}`,
    label: `Group ${index + 1}`, sortOrder: index, version: 1 }));
  const permissions: PermissionRecord[] = Array.from({ length: permissionCount }, (_, index) => {
    const group = groups[index % groups.length];
    return { id: String(index + 1), key: `synthetic.permission.${index + 1}`, label: `Permission ${index + 1}`,
      groupId: group?.id ?? null, groupLabel: group?.label ?? null, version: 1 };
  });
  const grants: GrantsRecord = { user: { id: "5", name: "Synthetic grant editor", email: "synthetic@example.invalid" },
    permissionIds: permissionCount > 100 ? ["1", "105"] : permissions.length ? [permissions[0]!.id] : [], version: 7 };
  const requests: string[] = [];
  const read = async (path: string): Promise<unknown> => {
    requests.push(path);
    const url = new URL(path, "http://synthetic.invalid");
    if (url.pathname === "/api/settings/users/5/permissions") return structuredClone(grants);
    const data = url.pathname === "/api/settings/permission-groups" ? groups
      : url.pathname === "/api/settings/permissions" ? permissions : undefined;
    assert.ok(data, "Only authorized existing read routes are requested.");
    const page = Number(url.searchParams.get("page")), pageSize = Number(url.searchParams.get("pageSize"));
    assert.equal(pageSize, 100); assert.equal(url.searchParams.has("query"), false);
    return { items: structuredClone(data.slice((page - 1) * pageSize, page * pageSize)), page, pageSize, total: data.length };
  };
  return { groups, permissions, grants, requests, read };
}

test("OFFLINE grant editor loads every permission and group page and retains off-page grants", async () => {
  const f = fixture(105, 101), editor = await loadPermissionEditor("5", f.read);
  assert.equal(editor.catalog.permissions.length, 105); assert.equal(editor.catalog.groups.length, 101);
  assert.ok(f.requests.includes("/api/settings/permissions?page=2&pageSize=100"));
  assert.ok(f.requests.includes("/api/settings/permission-groups?page=2&pageSize=100"));
  assert.deepEqual(editor.grants.permissionIds, ["1", "105"]);
  assert.deepEqual(grantReplacement(editor, editor.grants.permissionIds), { version: 7, permissionIds: ["1", "105"] });
  assert.equal(editor.catalog.groups[100]!.permissions[0]!.id, "101");
});

test("OFFLINE local permission filtering preserves selections and original group order", async () => {
  const f = fixture(), editor = await loadPermissionEditor("5", f.read), selected = [...editor.grants.permissionIds];
  const filtered = filterPermissionGroups(editor.catalog, "synthetic.permission.105");
  assert.deepEqual(filtered.flatMap(group => group.permissions.map(permission => permission.id)), ["105"]);
  assert.deepEqual(grantReplacement(editor, selected), { version: 7, permissionIds: ["1", "105"] });
  assert.equal(filterPermissionGroups(editor.catalog, "Group 2")[0]!.label, "Group 2");
  assert.deepEqual(filterPermissionGroups(editor.catalog, "no match"), []);
  assert.deepEqual(selected, ["1", "105"]);
  selected.push("9999"); filterPermissionGroups(editor.catalog, "no match");
  assert.deepEqual(selected, ["1", "105", "9999"]); // Unknown selections are never silently filtered out.
  assert.throws(() => grantReplacement(editor, selected), /complete permission catalogue/);
  assert.deepEqual(filterPermissionGroups(editor.catalog, "").map(group => group.id), ["1", "2"]);
});

test("OFFLINE empty groups and actual ungrouped permissions are retained without invented permissions", async () => {
  const f = fixture(1, 3); f.permissions[0]!.groupId = null; f.permissions[0]!.groupLabel = null;
  const editor = await loadPermissionEditor("5", f.read);
  assert.deepEqual(editor.catalog.groups.map(group => [group.id, group.permissions.length]), [["1", 0], ["2", 0], ["3", 0], ["ungrouped", 1]]);
  assert.equal(editor.catalog.groups[3]!.permissions[0]!.id, "1");
  const empty = fixture(0, 0), emptyEditor = await loadPermissionEditor("5", empty.read);
  assert.deepEqual(emptyEditor.catalog, { groups: [], permissions: [] });
  assert.deepEqual(grantReplacement(emptyEditor, []), { version: 7, permissionIds: [] });
});

test("OFFLINE incomplete duplicate shifted and changed-total catalogue pages refuse the editor", async () => {
  for (const changed of ["missing", "duplicate", "total", "page", "pageSize", "shape"] as const) {
    const f = fixture();
    const read = async (path: string): Promise<unknown> => {
      const value = await f.read(path);
      if (!path.startsWith("/api/settings/permissions?page=2")) return value;
      const page = value as { items: PermissionRecord[]; total: number; page: number; pageSize: number };
      if (changed === "missing") page.items.pop();
      if (changed === "duplicate") page.items[0] = { ...f.permissions[0]! };
      if (changed === "total") page.total++;
      if (changed === "page") page.page = 1;
      if (changed === "pageSize") page.pageSize = 25;
      return changed === "shape" ? { unexpected: true } : page;
    };
    await assert.rejects(loadPermissionEditor("5", read), /complete permission catalogue/, changed);
  }
});

test("OFFLINE failures never return a partial catalogue and the browser limit fails visibly", async () => {
  const f = fixture();
  await assert.rejects(loadPermissionEditor("5", async path => {
    if (path.startsWith("/api/settings/permissions?page=2")) throw new Error("Access denied.");
    return f.read(path);
  }), /Access denied/);
  await assert.rejects(loadPermissionEditor("5", async path => {
    if (path.startsWith("/api/settings/permission-groups")) return { items: [], total: MAX_PERMISSION_CATALOG_RECORDS + 1, page: 1, pageSize: 100 };
    return f.read(path);
  }), /safe load limit/);
  await assert.rejects(loadPermissionEditor("5", f.read, AbortSignal.abort()), { name: "AbortError" });
});

test("OFFLINE inconsistent group metadata missing grants and wrong users cannot become editable", async () => {
  for (const change of ["missing-group", "renamed-group", "unknown-grant", "duplicate-grant", "wrong-user"] as const) {
    const f = fixture();
    if (change === "missing-group") f.permissions[0]!.groupId = "999";
    if (change === "renamed-group") f.permissions[0]!.groupLabel = "A changed label";
    if (change === "unknown-grant") f.grants.permissionIds.push("999");
    if (change === "duplicate-grant") f.grants.permissionIds.push("1");
    if (change === "wrong-user") f.grants.user.id = "6";
    await assert.rejects(loadPermissionEditor("5", f.read), /complete permission catalogue/, change);
  }
});

test("OFFLINE cancellation during catalogue paging never publishes an old-user result", async () => {
  const f = fixture(), controller = new AbortController();
  await assert.rejects(loadPermissionEditor("5", async path => {
    const page = await f.read(path);
    if (path.startsWith("/api/settings/permissions?page=2")) controller.abort();
    return page;
  }, controller.signal), { name: "AbortError" });
});

test("OFFLINE grant replacements preserve versions validate saved identity and retain the server selection limit", async () => {
  const f = fixture(501), editor = await loadPermissionEditor("5", f.read);
  assert.deepEqual(grantReplacement(editor, ["105"]), { version: 7, permissionIds: ["105"] });
  assert.throws(() => grantReplacement(editor, ["1", "1"]), /complete permission catalogue/);
  assert.throws(() => grantReplacement(editor, f.permissions.map(permission => permission.id)), /no more than 500/);
  const saved = checkedGrants({ ...f.grants, version: 8, permissionIds: ["105"] }, "5", editor.catalog);
  assert.deepEqual(grantReplacement({ ...editor, grants: saved }, ["105"]), { version: 8, permissionIds: ["105"] });
  assert.throws(() => checkedGrants({ ...f.grants, user: { ...f.grants.user, id: "6" } }, "5", editor.catalog), /complete permission catalogue/);
  assert.throws(() => checkedGrants({ ...f.grants, permissionIds: ["invalid"] }, "5", editor.catalog), /complete permission catalogue/);
});
