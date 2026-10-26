type EditorKind = "users" | "groups" | "permissions";
export function settingsEditorPath(kind: EditorKind) {
  return "/settings/" + (kind === "groups" ? "permission-groups" : kind);
}
export function openSettingsEditor(kind: EditorKind, id?: string) {
  window.location.assign(settingsEditorPath(kind) + (id ? "?editId=" + encodeURIComponent(id) : ""));
}
