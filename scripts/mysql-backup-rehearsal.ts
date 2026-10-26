import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { readMysqlProfile } from "../src/server/config/mysql-profile";
import { connectMysql, type MysqlWireConnection } from "../src/server/db/mysql/driver";
import { MysqlBackupRehearsalError, rehearseMysqlApplicationBackup, validateMysqlBackupPair } from "../src/server/db/mysql/backup-rehearsal";

const blocked = "BLOCKED: MySQL backup rehearsal needs explicit local source-freeze/isolated-restore acknowledgement and separate approved private profiles. No server startup, database creation or existing-data reset is available.";
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
function profileRoot(relativeRoot: string, kind: "integration" | "restore") {
  if (!new RegExp(`^\\.local-data/test/mysql-${kind}-${uuid}$`, "u").test(relativeRoot)) throw new Error(blocked);
  const root = resolve(process.cwd());
  const same = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  let current = root;
  for (const segment of ["", ...relativeRoot.split("/")]) {
    if (segment) current = join(current, segment);
    if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink() || !same(realpathSync(current), current)) throw new Error(blocked);
  }
  return current;
}
async function main() {
  const args = process.argv.slice(2);
  let source: MysqlWireConnection | undefined, target: MysqlWireConnection | undefined;
  try {
    if (args.length !== 6 || args[0] !== "--allow-local-mysql-backup-restore" || args[1] !== "--acknowledge-frozen-source-and-retained-target"
      || args[2] !== "--source-fixture-root" || args[4] !== "--restore-fixture-root") throw new Error(blocked);
    const sourceRoot = profileRoot(args[3]!, "integration"), targetRoot = profileRoot(args[5]!, "restore");
    const sourceConfig = readMysqlProfile(["--profile", ".env.mysql.local"], sourceRoot);
    const targetConfig = readMysqlProfile(["--profile", ".env.mysql.local"], targetRoot);
    // Validate the pair before either network connection; never try a fallback target.
    validateMysqlBackupPair(sourceConfig, targetConfig, true);
    source = await connectMysql(sourceConfig); target = await connectMysql(targetConfig);
    const result = await rehearseMysqlApplicationBackup({ source, target, sourceConfig, targetConfig,
      artifactRoot: targetRoot, acknowledgeFrozenSource: true });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof MysqlBackupRehearsalError ? JSON.stringify({ status: "FAILED_OR_BLOCKED_REHEARSAL", phase: error.phase }) : blocked);
    process.exitCode = 2;
  }
  finally {
    for (const connection of [source, target]) {
      if (!connection) continue;
      try { await connection.end(); } catch { try { connection.destroy(); } catch { /* sanitized */ } process.exitCode = 2; }
    }
  }
}
void main();
