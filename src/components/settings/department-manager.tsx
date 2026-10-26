"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { UserRecord } from "@/server/settings/service";
import { message, Pagination, readApi, SearchBox, usePaged, writeApi } from "./client";

const departments = ["Electrical", "Civil", "PM", "Switchgear", "Maintenance", "Accounts", "Operations"];
function DepartmentDialog({ initialUser, onClose, onSaved }: { initialUser: UserRecord; onClose: () => void; onSaved: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId(), selectId = useId();
  const [user, setUser] = useState(initialUser);
  const [department, setDepartment] = useState(initialUser.departmentRole ?? "");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function reload() {
    setBusy(true); setError("");
    try { const fresh = await readApi<UserRecord>("/api/settings/users/" + user.id); setUser(fresh); setDepartment(fresh.departmentRole ?? ""); }
    catch (caught) { setError(message(caught)); } finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="crm-department-dialog" aria-labelledby={titleId} onClose={onClose} onCancel={(event) => { if (busy) event.preventDefault(); }}>
    <div className="modal-content shadow-lg border-0"><div className="modal-header bg-primary text-white"><h2 className="h5 text-white mb-0" id={titleId}><i className="ph ph-user-plus me-2" aria-hidden="true" />Assign Department</h2>
      <button type="button" className="btn btn-sm btn-outline-light" aria-label="Close department assignment" disabled={busy} onClick={() => dialog.current?.close()}><i className="ph ph-x" aria-hidden="true" /></button></div>
    <form onSubmit={async (event) => {
      event.preventDefault(); setBusy(true); setError("");
      try { await writeApi<UserRecord>("/api/settings/users/" + user.id + "/department", "PUT", { version: user.version, departmentRole: department }); onSaved(); }
      catch (caught) { setError(message(caught)); } finally { setBusy(false); }
    }}><div className="modal-body"><p><strong>{user.name}</strong><br />{user.email}</p>
      {error && <p role="alert" className="error">{error}</p>}
      <label className="form-label" htmlFor={selectId}>Select Department</label><select className="form-select" id={selectId} required autoFocus disabled={busy} value={department} onChange={(event) => setDepartment(event.target.value)}><option value="">Select department</option>{departments.map((value) => <option key={value}>{value}</option>)}</select>
      <p className="field-hint mt-2">The department determines assignment eligibility. It does not grant permissions or assign a job.</p></div>
      <div className="modal-footer"><button className="btn btn-outline-secondary" type="button" disabled={busy} onClick={() => dialog.current?.close()}>Close</button><button className="btn btn-outline-secondary" type="button" disabled={busy} onClick={() => void reload()}>Reload department</button><button className="btn btn-primary" type="submit" disabled={busy}>Save department</button></div>
    </form></div>
  </dialog>;
}

export function DepartmentManager() {
  const [query, setQuery] = useState(""), [page, setPage] = useState(1);
  const list = usePaged<UserRecord>("/api/settings/users", query, page);
  const [editing, setEditing] = useState<UserRecord | null>(null), [notice, setNotice] = useState("");
  return <div className="crm-department-manager">
    {notice && <p role="status" className="success">{notice}</p>}
    <section className="form-panel p-0" aria-label="Department assignments"><div className="crm-settings-list">
      <SearchBox label="Search department users" onSearch={(value) => { setQuery(value); setPage(1); }} />
      {list.loading && <p role="status">Loading department assignments...</p>}{list.error && <p role="alert" className="error">{list.error}</p>}
      {list.data && <><div className="table-responsive table-scroll"><table className="table table-hover mb-0"><thead className="table-light"><tr><th>Name</th><th>Email</th><th>Department</th><th className="text-end">Actions</th></tr></thead><tbody>
        {list.data.items.map((user) => {
          // Match the PHP table's trimmed display without rewriting legacy roles.
          const department = user.departmentRole?.trim() ?? "";
          return <tr key={user.id}><td><strong>{user.name}</strong></td><td className="text-muted">{user.email}</td><td><span className={"badge " + (department ? "bg-primary" : "bg-secondary")}>{department || "Not Assigned"}</span></td><td className="text-end"><button className="btn btn-sm btn-outline-primary" type="button" aria-label={"Assign department for " + user.name} onClick={() => { setEditing(user); setNotice(""); }}><i className="ph ph-pencil" aria-hidden="true" /> <span className="visually-hidden">Assign department</span></button></td></tr>;
        })}
      </tbody></table></div>{list.data.total === 0 && <p className="text-center text-muted py-4">No users match your search.</p>}</>}
      <Pagination data={list.data} page={page} onPage={setPage} />
    </div></section>
    {editing && <DepartmentDialog key={editing.id} initialUser={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); setNotice("Department assigned."); }} />}
  </div>;
}
