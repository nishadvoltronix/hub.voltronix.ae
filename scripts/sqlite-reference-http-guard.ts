import { readFileSync } from "node:fs";
import { join } from "node:path";

/** These six scripts seed SQLite and are valid only against the retained pre-port build. */
export function assertSqliteReferenceBuild() {
  const verifiedSqliteBuild = "cDMxA2mA8DMfGytOdzqZk";
  if (readFileSync(join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim() !== verifiedSqliteBuild) {
    throw new Error("BLOCKED: this HTTP suite requires the recorded pre-port SQLite artifact. MySQL workflow browser verification requires its own approved test database.");
  }
}
