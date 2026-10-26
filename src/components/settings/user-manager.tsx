"use client";
import Link from "next/link";
import { useState } from "react";
import type { CrmWriteCapabilities } from "@voltronix/crm-contracts";
import type { UserRecord } from "@/server/settings/service";
import { useRead } from "@/components/crm/read-client";
import { message, Pagination, readApi, SearchBox, usePaged, writeApi } from "./client";
import { openSettingsEditor } from "./edit-navigation";
import { ZohoUserDirectory } from "./zoho-user-directory";
const departments = ["Electrical", "Civil", "PM", "Switchgear", "Maintenance", "Accounts", "Operations"];
export function UserManager({ initialEditing }: { initialEditing?: UserRecord } = {}) {
  const capabilities = useRead<CrmWriteCapabilities>("/api/capabilities");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const list = usePaged<UserRecord>("/api/settings/users", query, page);
  const [editing, setEditing] = useState<UserRecord | null>(initialEditing ?? null);
  const [formKey, setFormKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  async function action(work: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await work(); list.reload(); }
    catch (caught) { setError(message(caught)); }
    finally { setBusy(false); }
  }
  return <div className="crm-users-manager">
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status" className="success">{notice}</p>}
    <div className="settings-grid">
      <section className="crm-settings-editor" aria-label="User editor">
        <div className="section-header"><h2 className="h5">{editing ? "Edit Admin User" : "Create Admin User"}</h2><p>Create system users and link them to employee profiles</p></div>
        <form key={formKey} onSubmit={(event) => {
          event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
          const password = String(data.get("password") ?? "");
          const values = { name: String(data.get("name")), email: String(data.get("email")), status: String(data.get("status")),
            ...(!editing || password ? { password } : {}), ...(editing ? { version: editing.version } : {}) };
          void action(async () => {
            await writeApi<UserRecord>(editing ? "/api/settings/users/" + editing.id : "/api/settings/users", editing ? "PATCH" : "POST", values);
            if (editing) { openSettingsEditor("users"); return; }
            setEditing(null); setFormKey((value) => value + 1); setNotice(editing ? "User updated." : "User created.");
          });
        }}>
          <div className="form-panel"><div className="field-group">
          <div className="field"><label htmlFor="user-name">Name <span aria-hidden="true">*</span></label><input id="user-name" name="name" required maxLength={120} defaultValue={editing?.name ?? ""} autoComplete="off" /><small>Display name for admin panel</small></div>
          <div className="field"><label htmlFor="user-email">Email <span aria-hidden="true">*</span></label><input id="user-email" name="email" aria-label="Email address" type="email" required maxLength={254} defaultValue={editing?.email ?? ""} autoComplete="off" /><small>Used for login and notifications</small></div>
          <div className="field"><label htmlFor="user-password">Password {editing ? "(leave blank to keep)" : <span aria-hidden="true">*</span>}</label><input id="user-password" name="password" aria-label={editing ? "New password" : "Password"} type="password" autoComplete="new-password" required={!editing} minLength={12} maxLength={72} />
          <small>{editing ? "Leave the password blank to keep it. " : ""}Use at least 12 characters and at most 72 UTF-8 bytes.</small></div>
          <div className="field"><label htmlFor="user-status">Status</label><select id="user-status" name="status" defaultValue={editing?.status ?? "active"}><option value="active">Active</option><option value="inactive">Inactive</option></select><small>Inactive users cannot login</small></div>
          </div></div><div className="save-bar">
          <span className="hint">{editing ? "Updating user will apply immediately" : "New user can login after creation"}</span>
          <div className="actions">
          {editing && <><button type="button" className="btn btn-light" aria-label="Cancel editing" disabled={busy} onClick={() => openSettingsEditor("users")}>Cancel</button>
            <button type="button" className="btn btn-outline-secondary" disabled={busy} onClick={() => void action(async () => {
              const fresh = await readApi<UserRecord>("/api/settings/users/" + editing.id); setEditing(fresh); setFormKey((value) => value + 1); setNotice("Latest user details loaded.");
            })}>Reload user</button></>}
          <button className="btn btn-primary px-5" disabled={busy} type="submit" aria-label={editing ? "Save user" : "Create user"}>{editing ? "Update User" : "Create User"}</button>
          </div>
          </div>
        </form>
        {editing && capabilities.data?.zohoInbound && <div className="form-panel mt-4" role="group" aria-label="Zoho assignment identity">
          <h3 className="h6">Zoho assignment identity</h3>
          {editing.externalUserId ? <p className="text-break">Zoho user ID: <strong>{editing.externalUserId}</strong>. Check the Zoho users list below for the linked account status.</p>
            : <p>This login has no linked Zoho user. Assigned Zoho leads appear after the account is verified and linked.</p>}
        </div>}
        {editing && <form className="form-panel mt-4" key={editing.id + ":" + editing.version} aria-label="Department assignment" onSubmit={(event) => {
          event.preventDefault(); const departmentRole = String(new FormData(event.currentTarget).get("department"));
          void action(async () => {
            const updated = await writeApi<UserRecord>("/api/settings/users/" + editing.id + "/department", "PUT", { version: editing.version, departmentRole });
            setEditing(updated); setFormKey((value) => value + 1); setNotice("Department assigned.");
          });
        }}>
          <h3>Department role</h3>
          <label htmlFor="user-department">Department</label><select id="user-department" required name="department" defaultValue={editing.departmentRole ?? ""}><option value="">Select department</option>{departments.map((department) => <option key={department}>{department}</option>)}</select>
          <button type="submit" disabled={busy}>Assign department</button>
        </form>}
      </section>
      <section aria-label="User list">
        <div className="section-header"><h2 className="h5">Admin Users</h2><p>All system users with their employee linkage and access</p></div><div className="form-panel p-0"><div className="crm-settings-list">
        {list.loading && <p role="status">Loading users…</p>}
        {list.error && <p role="alert" className="error">{list.error}</p>}
        {list.data && <><div className="table-responsive table-scroll" role="region" aria-label="Admin Users" tabIndex={0}><table className="table table-hover mb-0"><thead className="table-light"><tr><th>Name</th><th>Email</th><th>Status</th><th className="text-end">Actions</th></tr></thead>
          <tbody>{list.data.items.map((row) => <tr key={row.id}>
            <td><strong>{row.name}</strong></td><td><small className="text-muted">{row.email}</small></td><td><span className={"badge " + (row.status === "active" ? "bg-success" : "bg-secondary")}>{row.status === "active" ? "Active" : "Inactive"}</span></td>
            <td className="text-end"><div className="crm-user-actions"><button type="button" className="btn btn-sm btn-outline-primary" disabled={busy} onClick={() => openSettingsEditor("users", row.id)}>Edit</button>
              <Link className="btn btn-sm btn-outline-dark" href={"/settings/permissions/assign?userId=" + row.id}>Permissions</Link>
              <button type="button" className="btn btn-sm btn-outline-warning" disabled={busy} onClick={() => {
                if (!window.confirm("Change user status?")) return;
                void action(async () => {
                const updated = await writeApi<UserRecord>("/api/settings/users/" + row.id + "/status", "POST", { version: row.version, status: row.status === "active" ? "inactive" : "active" });
                if (editing?.id === row.id) { setEditing(updated); setFormKey((value) => value + 1); }
                setNotice(updated.status === "active" ? "User activated." : "User deactivated. Existing sessions have been revoked.");
              }); }}>{row.status === "active" ? "Deactivate" : "Activate"}</button></div></td>
          </tr>)}</tbody></table></div>{list.data.items.length === 0 && <p>No users match your search.</p>}</>}
        </div></div>
        <div className="crm-user-list-controls"><SearchBox label="Search users" onSearch={(value) => { setQuery(value); setPage(1); }} />
          {(!list.data || list.data.total > list.data.pageSize || page > 1) && <Pagination data={list.data} page={page} onPage={setPage} />}
        </div>
      </section>
    </div>
    {capabilities.data?.zohoInbound && <ZohoUserDirectory />}
    {capabilities.error && <p role="alert" className="error">Zoho user directory is unavailable. {capabilities.error}</p>}
  </div>;
}

