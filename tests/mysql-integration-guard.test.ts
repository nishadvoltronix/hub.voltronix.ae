import assert from "node:assert/strict";
import test from "node:test";
import { liveMysqlAcknowledgements, liveMysqlArguments } from "./mysql-integration/guard";

test("OFFLINE real MySQL integration execution requires explicit DDL/fixture acknowledgement before any profile or network access", () => {
  const root = ".local-data/test/mysql-integration-00000000-0000-4000-8000-000000000000";
  const args = [...liveMysqlAcknowledgements, "--fixture-root", root];
  assert.equal(liveMysqlArguments(args), root);
  for (const input of [[], args.slice(1), args.slice(0, 3), [...args, "extra"],
    [args[1]!, args[0]!, args[2]!, args[3]!],
    ...[".env.mysql.local", ".local-data/development", ".local-data/test/mysql-integration-anything", root + "/..",
      root.replaceAll("/", "\\"), "/absolute", "../outside"].map((path) => [...args.slice(0, 3), path])]) {
    assert.throws(() => liveMysqlArguments(input), /BLOCKED/u);
  }
});
