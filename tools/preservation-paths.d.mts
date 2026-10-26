export const legacyArchive: string;
export function historicalRelativePath(name: string): string;
export function ordinaryPath(workspace: string, name: string, kind?: "file" | "directory"): string;
export function preservedPath(workspace: string, name: string, kind?: "file" | "directory"): string;
