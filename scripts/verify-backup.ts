import { rehearseBackup } from "../src/server/db/restore-rehearsal";

async function main() {
  if (process.argv.length !== 3) throw new Error();
  const result = await rehearseBackup(process.cwd(), process.argv[2]!);
  // Only aggregate counts, migration versions and snapshot fingerprints; no rows/secrets.
  console.log(JSON.stringify(result, null, 2));
  console.log("Local exclusive-copy restore rehearsal only. Active database, backup and historical records were not replaced; no target host was verified.");
}
main().catch(() => {
  console.error("Backup rehearsal failed. Supply a completed .local-data/backups/<environment>-<UUID>/crm.sqlite snapshot. No existing database was replaced.");
  process.exitCode = 1;
});
