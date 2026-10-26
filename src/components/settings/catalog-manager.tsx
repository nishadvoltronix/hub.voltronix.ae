"use client";
import { useEffect, useState } from "react";
import { z } from "zod";
import type { GroupRecord, PermissionRecord } from "@/server/settings/service";
import { message, Pagination, readApi, SearchBox, usePaged, writeApi } from "./client";
import { openSettingsEditor } from "./edit-navigation";
type Record = GroupRecord | PermissionRecord;
const groupSchema = z.object({ id: z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n),
  key: z.string(), label: z.string(), sortOrder: z.number().int(), version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict();
const groupPageSchema = z.object({ items: z.array(groupSchema), total: z.number().int().min(0).max(10_000),
  page: z.number().int(), pageSize: z.number().int() }).strict();
const groupLoadError = "The complete permission group list could not be loaded. Reload groups before saving.";
/** The PHP native selector contains all authorized groups, never a partial API page. */
export async function loadCatalogGroups(read: (path: string, signal?: AbortSignal) => Promise<unknown>, signal?: AbortSignal): Promise<GroupRecord[]> {
  const groups: GroupRecord[] = [], ids = new Set<string>(); let total: number | undefined;
  for (let page = 1; ; page++) {
    signal?.throwIfAborted();
    const parsed = groupPageSchema.safeParse(await read(`/api/settings/permission-groups?page=${page}&pageSize=100`, signal));
    signal?.throwIfAborted();
    if (!parsed.success) throw new Error(groupLoadError);
    const result = parsed.data;
    if (total === undefined) total = result.total;
    if (result.total !== total || result.page !== page || result.pageSize !== 100
      || result.items.length !== Math.min(100, total - groups.length)) throw new Error(groupLoadError);
    for (const group of result.items) {
      if (ids.has(group.id)) throw new Error(groupLoadError);
      ids.add(group.id); groups.push(group);
    }
    if (groups.length === total) return groups;
  }
}
export function CatalogManager({ kind, initialEditing }: { kind: "groups" | "permissions"; initialEditing?: Record }) {
  const isGroup = kind === "groups";
  const noun = isGroup ? "group" : "permission";
  const path = "/api/settings/" + (isGroup ? "permission-groups" : "permissions");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const list = usePaged<Record>(path, query, page);
  const [editing, setEditing] = useState<Record | null>(initialEditing ?? null);
  const [groupId, setGroupId] = useState(initialEditing && "groupId" in initialEditing ? initialEditing.groupId ?? "" : "");
  const [formKey, setFormKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [groupRevision, setGroupRevision] = useState(0);
  const [groupResult, setGroupResult] = useState<{ revision: number; items?: GroupRecord[]; error?: string }>();
  const groups = groupResult?.revision === groupRevision ? groupResult.items : undefined;
  const groupsError = groupResult?.revision === groupRevision ? groupResult.error : undefined;
  useEffect(() => {
    if (isGroup) return;
    const controller = new AbortController();
    void loadCatalogGroups(readApi, controller.signal).then(
      items => { if (!controller.signal.aborted) setGroupResult({ revision: groupRevision, items }); },
      caught => { if (!controller.signal.aborted) setGroupResult({ revision: groupRevision, error: message(caught) }); },
    );
    return () => controller.abort();
  }, [isGroup, groupRevision]);
  const groupAvailable = !!groups?.some(group => group.id === groupId);
  function begin(row: Record | null) {
    setEditing(row); setGroupId(row && "groupId" in row ? row.groupId ?? "" : "");
    setFormKey((value) => value + 1); setError(""); setNotice("");
  }
  return <div className="legacy-catalog-manager">
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status" className="success">{notice}</p>}
    <div className="settings-grid">
      <section className="form-box" aria-label="Definition editor">
        <h2 className="h5 mb-3">{editing ? "Edit" : "Create"} {isGroup ? "Permission Group" : "Permission"}</h2>
        <form key={formKey} onSubmit={async (event) => {
          event.preventDefault(); const data = new FormData(event.currentTarget);
          if (!isGroup && !groupAvailable) { setError(groupLoadError); return; }
          const values = { label: String(data.get("label")), ...(isGroup ? { sortOrder: Number(data.get("sortOrder")) } : { groupId }),
            ...(editing ? { version: editing.version } : { key: String(data.get("key")) }) };
          setBusy(true); setError(""); setNotice("");
          try {
            await writeApi<Record>(editing ? path + "/" + editing.id : path, editing ? "PATCH" : "POST", values);
            if (editing) { openSettingsEditor(kind); return; }
            begin(null); setNotice(isGroup ? "Permission group saved." : "Permission saved."); list.reload();
          } catch (caught) { setError(message(caught)); }
          finally { setBusy(false); }
        }}>
          <div className="form-group"><label htmlFor="catalog-key">{isGroup ? "Group Key" : "Permission Key"}</label>
            <input id="catalog-key" className="form-control" name="key" aria-label="Key" aria-describedby="catalog-key-hint" required readOnly={!!editing} disabled={busy} maxLength={100} placeholder={isGroup ? "e.g. employees" : "e.g. employees.read"} defaultValue={editing?.key ?? ""} pattern={isGroup ? "[A-Za-z0-9_\\-]+" : "[a-z0-9._\\-]+"} />
            <small id="catalog-key-hint" className="text-muted">Cannot be changed later</small></div>
          <div className="form-group"><label htmlFor="catalog-label">Label</label><input id="catalog-label" className="form-control" name="label" required disabled={busy} maxLength={120} defaultValue={editing?.label ?? ""} /></div>
          {isGroup ? <div className="form-group"><label htmlFor="catalog-sort-order">Sort Order</label><input id="catalog-sort-order" className="form-control" aria-label="Display order" name="sortOrder" type="number" disabled={busy} min={-2147483648} max={2147483647} step="1" defaultValue={editing && "sortOrder" in editing ? editing.sortOrder : 0} /></div>
          : <div className="form-group"><label htmlFor="catalog-group">Permission Group</label>
            <select id="catalog-group" className="form-control" name="groupId" aria-label="Permission group" required disabled={busy || !groups} value={groupId} onChange={event => setGroupId(event.target.value)}>
              <option value="">-- Select Group --</option>
              {groupId && !groupAvailable && <option value={groupId} disabled>{editing && "groupLabel" in editing ? editing.groupLabel ?? "Current group" : "Current group"} (unavailable)</option>}
              {groups?.map(group => <option key={group.id} value={group.id}>{group.label}</option>)}
            </select>
            {!groups && !groupsError && <p role="status">Loading permission groups…</p>}
            {groupsError && <p role="alert" className="error">{groupsError}</p>}
            {groups && groupId && !groupAvailable && <p role="alert" className="error">The current group is unavailable. Select an available group before saving.</p>}
            {(groupsError || (groupId && !groupAvailable)) && <button type="button" className="btn btn-link" disabled={busy} onClick={() => setGroupRevision(value => value + 1)}>Reload groups</button>}
          </div>}
          <button className="btn btn-primary btn-block" type="submit" disabled={busy || (!isGroup && !groupAvailable)} aria-label={`${editing ? "Save" : "Create"} ${noun}`}>{editing ? "Update" : "Create"} {isGroup ? "Group" : "Permission"}</button>
          {editing && <><button type="button" className="btn btn-link btn-block" aria-label="Cancel editing" disabled={busy} onClick={() => openSettingsEditor(kind)}>Cancel Edit</button>
          <button type="button" className="btn btn-link btn-block" disabled={busy} onClick={async () => {
            setBusy(true); setError(""); try { begin(await readApi<Record>(path + "/" + editing.id)); }
            catch (caught) { setError(message(caught)); } finally { setBusy(false); }
          }}>Reload {noun}</button></>}
        </form>
      </section>
      <section aria-label="Definition list">
        <div className="card"><div className="card-header"><h2 className="h5 mb-0">{isGroup ? "Permission Groups" : "Permissions"}</h2></div><div className="card-body p-0">
        {list.loading && <p role="status">Loading definitions…</p>}
        {list.error && <p role="alert" className="error">{list.error}</p>}
        {list.data && <div className="table-responsive table-scroll" role="region" aria-label={isGroup ? "Permission Groups table" : "Permissions table"} tabIndex={0}><table className="table table-hover mb-0"><thead className="thead-light"><tr><th>Key</th><th>Label</th><th>{isGroup ? "Order" : "Group"}</th><th>Action</th></tr></thead><tbody>
          {list.data.items.map((row) => <tr key={row.id}><td><code>{row.key}</code></td><td>{row.label}</td><td>{"sortOrder" in row ? row.sortOrder : row.groupLabel ?? "Ungrouped"}</td>
            <td><button type="button" className="btn btn-outline-primary btn-sm" disabled={busy} onClick={() => openSettingsEditor(kind, row.id)}>Edit</button></td></tr>)}
          {list.data.items.length === 0 && <tr><td colSpan={4} className="text-center text-muted py-4">{isGroup ? "No permission groups found" : "No permissions found"}</td></tr>}
        </tbody></table></div>}
        </div></div>
        <div className="legacy-catalog-list-controls"><SearchBox label={isGroup ? "Search groups" : "Search permissions"} onSearch={(value) => { setQuery(value); setPage(1); }} />
        {(!list.data || list.data.total > list.data.pageSize || page > 1) && <Pagination data={list.data} page={page} onPage={setPage} />}</div>
      </section>
    </div>
  </div>;
}

