import { readMysqlProfile } from "./mysql-profile";
import { inspectLocalMysql } from "../src/server/db/mysql-local";

async function main() {
  const config = readMysqlProfile(process.argv.slice(2));
  const result = await inspectLocalMysql(config);
  console.log(JSON.stringify(result, null, 2));
}
void main().catch(() => {
  console.error("Local MySQL inspection failed. Check the private profile, loopback server, selected database and local account grants. No values were logged.");
  process.exitCode = 1;
});
