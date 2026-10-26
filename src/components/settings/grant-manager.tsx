"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { GrantsRecord, GrantUser } from "@/server/settings/service";
import { message, readApi, SearchBox, writeApi } from "./client";
import { loadAdminUserOptions } from "./admin-user-options";
import { checkedGrants, filterPermissionGroups, grantReplacement, loadPermissionEditor, type PermissionEditor } from "./permission-catalog";
export function GrantManager({ initialUserId }: { initialUserId: string }) {
  const userId = initialUserId;
  const [pendingUserId, setPendingUserId] = useState(initialUserId);
  const [usersReload, setUsersReload] = useState(0);
  const [usersResult, setUsersResult] = useState<{ revision: number; users?: GrantUser[]; error?: string }>();
  const [query, setQuery] = useState("");
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; editor?: PermissionEditor; error?: string }>();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const loadKey = `${userId}:${reload}`;
  useEffect(() => {
    const controller = new AbortController();
    void loadAdminUserOptions(readApi, controller.signal).then(
      users => { if (!controller.signal.aborted) setUsersResult({ revision: usersReload, users }); },
      (caught: unknown) => { if (!controller.signal.aborted) setUsersResult({ revision: usersReload, error: message(caught) }); },
    );
    return () => controller.abort();
  }, [usersReload]);
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    void loadPermissionEditor(userId, readApi, controller.signal).then(
      (editor) => { if (!controller.signal.aborted) { setLoaded({ key: loadKey, editor }); setSelected(editor.grants.permissionIds); setError(""); } },
      (caught: unknown) => { if (!controller.signal.aborted) { setLoaded({ key: loadKey, error: message(caught) }); controller.abort(); } },
    );
    return () => controller.abort();
  }, [userId, loadKey]);
  const result = loaded?.key === loadKey ? loaded : undefined;
  const editor = result?.editor, current = editor?.grants;
  const groups = editor ? filterPermissionGroups(editor.catalog, query) : [];
  const loadError = result?.error;
  const userChoices = usersResult?.revision === usersReload ? usersResult : undefined;
  function reloadAssignments() {
    setReload(value => value + 1); setError(""); setNotice("");
  }
  return <div className="crm-grant-manager">
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status" className="success">{notice}</p>}
    <div className="mb-4"><h2 className="h4 mb-0">Admin user</h2><small className="text-muted">Select an admin to manage permissions</small></div>
    <div className="settings-grid"><div>
    <form className="crm-admin-user-selector" method="get" action="/settings/permissions/assign" onSubmit={event => {
      // PHP uses a GET form: the explicitly loaded identity belongs in the URL,
      // so reload and browser history cannot silently restore a different target.
      if (busy || !userChoices?.users || (pendingUserId && !userChoices.users.some(user => user.id === pendingUserId))) event.preventDefault();
    }}>
      <div className="form-group"><label className="font-weight-600" htmlFor="permission-admin-user">Admin user</label>
        <select id="permission-admin-user" name="userId" className="form-control" disabled={busy || !userChoices?.users}
          value={pendingUserId} onChange={event => setPendingUserId(event.target.value)}>
          <option value="">Select admin</option>
          {pendingUserId && !userChoices?.users?.some(user => user.id === pendingUserId) && <option value={pendingUserId}>
            {current?.user.id === pendingUserId ? `${current.user.name} (${current.user.email})` : "Selected admin"}
          </option>}
          {userChoices?.users?.map(user => <option key={user.id} value={user.id}>{user.name} ({user.email})</option>)}
        </select>
      </div>
      {!userChoices && <p role="status">Loading admin users…</p>}
      {userChoices?.error && <><p role="alert" className="error">{userChoices.error}</p>
        <button type="button" className="btn btn-light" onClick={() => setUsersReload(value => value + 1)}>Reload users</button></>}
      <button type="submit" className="btn btn-primary mt-2" disabled={busy || !userChoices?.users}>Load</button>
    </form>
    {current && <p className="alert alert-info mt-3">Editing permissions for {current.user.name}</p>}
    </div>{userId ? <section aria-label="Permission assignment">
      <h2 className="h5 mb-1">Permissions</h2>
      <small className="text-muted">Enable or disable permissions below</small>
      {!result && <p role="status">Loading the complete permission catalogue and assignments…</p>}
      {loadError && <><p role="alert" className="error">{loadError} Saving is unavailable until the complete catalogue and assignments load.</p>
        <button type="button" className="secondary" onClick={reloadAssignments}>Reload assignments</button></>}
      {current && editor && <>
      <SearchBox key={userId} label="Find permissions" onSearch={setQuery} />
      <p className="text-muted small">{selected.length} selected</p>
      <form onSubmit={async (event) => {
        event.preventDefault(); if (busy) return;
        setBusy(true); setError(""); setNotice("");
        try {
          const body = grantReplacement(editor, selected);
          const saved = checkedGrants(await writeApi<GrantsRecord>("/api/settings/users/" + encodeURIComponent(userId) + "/permissions", "PUT", body), userId, editor.catalog);
          setLoaded({ key: loadKey, editor: { ...editor, grants: saved } }); setSelected(saved.permissionIds); setNotice("Permissions saved.");
        } catch (caught) { setError(message(caught)); } finally { setBusy(false); }
      }}>
        <fieldset className="crm-permission-options" disabled={busy}><legend className="visually-hidden">Available permissions</legend>
          {groups.map(group => <section className="mb-3" key={group.id} aria-label={group.label}><h3 className="h6 mb-1 fw-semibold">{group.label}</h3>
            {group.permissions.map((permission) => <label className="check-option" key={permission.id}>
              <input type="checkbox" name="permissions[]" value={permission.id} checked={selected.includes(permission.id)} onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, permission.id] : ids.filter((id) => id !== permission.id))} />
              <span>{permission.label}</span>
            </label>)}
          </section>)}
          {groups.length === 0 && <p>{query ? "No permissions match your search." : "No permissions are defined."}</p>}
        </fieldset>
        <div className="actions mt-4"><button type="submit" className="btn btn-primary" disabled={busy}>Save</button>
          <Link href="/settings/users" className="btn btn-secondary">Back</Link>
          <button type="button" className="btn btn-light" disabled={busy} onClick={reloadAssignments}>Reload assignments</button></div>
      </form>
      </>}
    </section> : <p className="text-muted">Please select an admin user to assign permissions.</p>}</div>
  </div>;
}

