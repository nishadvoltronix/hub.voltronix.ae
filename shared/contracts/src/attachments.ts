/** Limits and extensions from the active PHP task/department upload controllers. */
export const TASK_ATTACHMENT_LIMIT = 16_000 * 1024;
export const LARGE_LOG_ATTACHMENT_LIMIT = 51_200 * 1024;
export const TASK_ATTACHMENT_EXTENSIONS = ["gif", "jpg", "jpeg", "png", "webp", "bmp", "pdf", "doc", "docx", "xls", "xlsx", "csv", "ppt", "pptx", "txt", "zip", "rar", "7z"] as const;
export function logAttachmentLimit(department: string): number {
  return ["Electrical", "Civil", "Switchgear", "Maintenance"].includes(department) ? LARGE_LOG_ATTACHMENT_LIMIT : TASK_ATTACHMENT_LIMIT;
}
export function logAttachmentExtensions(department: string): readonly string[] {
  return ["gif", "jpg", "jpeg", "png", "pdf", ...(["Switchgear", "Maintenance"].includes(department) ? ["xls", "xlsx", "csv"] : [])];
}
