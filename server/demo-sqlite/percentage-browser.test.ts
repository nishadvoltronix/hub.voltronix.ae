import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedPercentageMutation, allowedPercentageReadbackRequest } from "./percentage-browser.js";

test("percentage acceptance mutation guard only permits initial create and the newly owned task", () => {
  assert.equal(allowedPercentageMutation(undefined, "/api/deals", "POST"), true);
  assert.equal(allowedPercentageMutation(undefined, "/api/quotations", "POST"), false);
  assert.equal(allowedPercentageMutation("18", "/api/deals", "POST"), false);
  assert.equal(allowedPercentageMutation("18", "/api/leads/18/stage", "PATCH"), true);
  assert.equal(allowedPercentageMutation("18", "/api/quotations", "POST"), true);
  assert.equal(allowedPercentageMutation("18", "/api/quotations/18", "PATCH"), true);
  for (const path of ["/api/quotations/4", "/api/leads/7/stage", "/api/settings/users/5/permissions", "/api/settings/users/15/status", "/api/quotations/18?bypass=true", "/api/quotations/18/../4"])
    assert.equal(allowedPercentageMutation("18", path, "PATCH"), false);
  for (const id of ["", "0", "../4", "18?x=1", "-1"])
    assert.equal(allowedPercentageMutation(id, "/api/quotations", "POST"), false);
  assert.equal(allowedPercentageMutation("18", "/api/quotations/18", "DELETE"), false);
  const origin = "http://127.0.0.1:3001";
  assert.equal(allowedPercentageReadbackRequest(origin + "/api/quotations/18", "GET"), true);
  assert.equal(allowedPercentageReadbackRequest(origin + "/api/auth/login", "POST"), true);
  assert.equal(allowedPercentageReadbackRequest(origin + "/api/auth/logout", "POST"), true);
  for (const [url, method] of [[origin + "/api/quotations/18", "PATCH"], [origin + "/api/deals", "POST"],
    [origin + "/api/auth/login?target=foreign", "POST"], ["https://example.com/api/auth/login", "POST"],
    ["http://user:password@127.0.0.1:3001/api/auth/login", "POST"], [origin + "/api/auth/%6cogin", "POST"]])
    assert.equal(allowedPercentageReadbackRequest(url!, method!), false);
});
