import assert from "node:assert/strict";
import { linkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { readMysqlProfile } from "../scripts/mysql-profile";
import { filesystemFixture } from "./database-fixture";

const profile = ["DATABASE_PROVIDER=mysql", "MYSQL_ENVIRONMENT=test", "MYSQL_HOST=127.0.0.1", "MYSQL_PORT=3308",
  "MYSQL_DATABASE=crm_local_test", "MYSQL_USER=local_probe", "MYSQL_PASSWORD='synthetic-$-profile-secret'"];

test("MySQL profile requires the explicit private file and never falls back to .env.local", () => {
  const fixture = filesystemFixture();
  try {
    writeFileSync(join(fixture.root, ".env.local"), profile.join("\n"));
    for (const args of [[], ["--profile", ".env.local"], ["--profile", "../.env.mysql.local"],
      ["--profile", ".env.mysql.local", "extra"], ["--profile", ".env.mysql.local"]]) {
      assert.throws(() => readMysqlProfile(args, fixture.root));
    }
    writeFileSync(join(fixture.root, ".env.mysql.local"), profile.join("\n"));
    const config = readMysqlProfile(["--profile", ".env.mysql.local"], fixture.root);
    assert.equal(config.environment, "test");
    assert.equal(config.password, "synthetic-$-profile-secret");
  } finally { fixture.cleanup(); }
});

test("MySQL profile rejects unsafe content and hardlinks without leaking values", () => {
  const fixture = filesystemFixture();
  try {
    const filename = join(fixture.root, ".env.mysql.local");
    for (const content of [profile.join("\n") + "\nUNEXPECTED_SECRET=synthetic-marker", "synthetic-marker\0",
      "#".repeat(8193), profile.join("\n").replace("127.0.0.1", "synthetic-remote-marker"),
      profile.join("\n") + "\nMYSQL_HOST=127.0.0.1", profile.join("\n") + "\nmalformed synthetic-marker"]) {
      writeFileSync(filename, content);
      assert.throws(() => readMysqlProfile(["--profile", ".env.mysql.local"], fixture.root), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes("synthetic"), false);
        return true;
      });
    }
    writeFileSync(filename, profile.join("\n"));
    linkSync(filename, join(fixture.root, "preserved-profile"));
    assert.throws(() => readMysqlProfile(["--profile", ".env.mysql.local"], fixture.root));
  } finally { fixture.cleanup(); }
});

test("MySQL allowlisted profile selection never substitutes another existing profile", () => {
  const fixture = filesystemFixture();
  try {
    const inspector = profile.join("\n");
    writeFileSync(join(fixture.root, ".env.mysql.local"), inspector);
    for (const filename of [".env.mysql.runtime.local", ".env.mysql.migration.local"]) {
      assert.throws(() => readMysqlProfile(["--profile", filename], fixture.root));
      writeFileSync(join(fixture.root, filename), inspector.replace("local_probe", "selected_probe"));
      assert.equal(readMysqlProfile(["--profile", filename], fixture.root).user, "selected_probe");
    }
    assert.equal(readMysqlProfile(["--profile", ".env.mysql.local"], fixture.root).user, "local_probe");
    for (const filename of [".env.local", ".env.mysql.other.local", "../.env.mysql.runtime.local", "./.env.mysql.runtime.local",
      ".env.mysql.runtime.local/..", ".ENV.MYSQL.RUNTIME.LOCAL", ".env.mysql.runtime.local\0"]) {
      assert.throws(() => readMysqlProfile(["--profile", filename], fixture.root));
    }
  } finally { fixture.cleanup(); }
});
