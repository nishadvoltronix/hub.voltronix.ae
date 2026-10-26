import { fileURLToPath } from "node:url";
import { preservedPath } from "../../tools/preservation-paths.mjs";

// Test-only original source evidence. Never imported by application runtime.
const workspace = fileURLToPath(new URL("../../", import.meta.url));
export function preservedSource(name: string): string {
  return preservedPath(workspace, name);
}
