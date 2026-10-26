import { preservedSource } from "./helpers/preserved-source";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { recordedWorkLogDate } from "../src/components/crm/work-log-date";

test("worker log display uses original PHP card and history formats", () => {
  const source = readFileSync(preservedSource("application/views/Jobs/Job_Details_User.php"), "utf8");
  assert.ok(source.includes("date('d M Y, h:i A',"));
  assert.ok(source.includes("date('d M Y h:i A',"));
  for (const controller of ["Electrical", "Civil", "Project_Manager", "Switchgear", "Maintenance"]) {
    assert.ok(readFileSync(preservedSource(`application/controllers/${controller}.php`), "utf8").includes("date_default_timezone_set('Asia/Dubai')"));
  }
  assert.equal(recordedWorkLogDate("2026-10-13T08:00:00Z", true), "13 Oct 2026, 12:00 PM");
  assert.equal(recordedWorkLogDate("2026-10-13T08:00:00Z"), "13 Oct 2026 12:00 PM");
});

test("qualified instants display Dubai midnight and noon independently of browser timezone", () => {
  assert.equal(recordedWorkLogDate("2026-10-13T20:05:59.999Z", true), "14 Oct 2026, 12:05 AM");
  assert.equal(recordedWorkLogDate("2026-10-13T12:00:00+04:00"), "13 Oct 2026 12:00 PM");
  assert.equal(recordedWorkLogDate("2026-10-13T03:30:00-04:30"), "13 Oct 2026 12:00 PM");
});

test("legacy zone-less dates preserve the recorded clock and calendar", () => {
  assert.equal(recordedWorkLogDate("2026-10-13 08:00:00", true), "13 Oct 2026, 08:00 AM");
  assert.equal(recordedWorkLogDate("2024-02-29T00:01:00"), "29 Feb 2024 12:01 AM");
  assert.equal(recordedWorkLogDate("2026-10-13 23:59:59.999"), "13 Oct 2026 11:59 PM");
});

test("unknown invalid missing and ambiguous saved values are never normalized into a different date", () => {
  for (const value of ["", " ", "2026-10-13", "13/10/2026 08:00", "2025-02-29T08:00:00Z", "2026-13-01 08:00:00", "2026-04-31 08:00:00", "2026-10-13 24:00:00", "2026-10-13T08:60:00Z", "2026-10-13T08:00:60Z", "2026-10-13T08:00:00+99:00"]) assert.equal(recordedWorkLogDate(value), value);
  assert.equal(recordedWorkLogDate(null), ""); assert.equal(recordedWorkLogDate(undefined), "");
});
