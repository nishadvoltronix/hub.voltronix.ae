"use client";
import { useEffect, useState } from "react";
import type { GroupRecord, PermissionRecord, UserRecord } from "@/server/settings/service";
import { message, readApi } from "./client";
import { UserManager } from "./user-manager";
import { CatalogManager } from "./catalog-manager";
import { settingsEditorPath } from "./edit-navigation";

type EditorKind = "users" | "groups" | "permissions";
type EditorRecord = UserRecord | GroupRecord | PermissionRecord;
/** The URL carries the PHP edit-page target; its existing protected API supplies current data. */
export function SettingsEditTarget({ kind, editId }: { kind: EditorKind; editId: string }) {
  const target = kind + ":" + editId;
  const [loaded, setLoaded] = useState<{ target: string; record?: EditorRecord; error?: string }>();
  useEffect(() => {
    if (!editId) return;
    const controller = new AbortController();
    const valid = /^[1-9][0-9]{0,18}$/.test(editId) && BigInt(editId) <= 9_223_372_036_854_775_807n;
    const request = valid ? readApi<EditorRecord>("/api" + settingsEditorPath(kind) + "/" + editId, controller.signal)
      : Promise.reject(new Error("Invalid edit target."));
    void request.then(record => {
      if (controller.signal.aborted) return;
      if (record.id !== editId) throw new Error("The edit response does not match the selected record.");
      setLoaded({ target, record });
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setLoaded({ target, error: message(caught) }); });
    return () => controller.abort();
  }, [kind, editId, target]);
  const result = loaded?.target === target ? loaded : undefined;
  if (editId && !result) return <p role="status">Loading selected record...</p>;
  if (editId && !result?.record) return <><p role="alert" className="error">{result?.error}</p><a className="btn btn-light" href={settingsEditorPath(kind)}>Back</a></>;
  return kind === "users" ? <UserManager key={target} initialEditing={result?.record as UserRecord | undefined} />
    : <CatalogManager key={target} kind={kind} initialEditing={result?.record as GroupRecord | PermissionRecord | undefined} />;
}
