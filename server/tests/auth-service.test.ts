import assert from "node:assert/strict";
import { test } from "node:test";
import { compare, hashSync } from "bcryptjs";
import type { AuthUser } from "@voltronix/crm-contracts";
import { authFailure } from "../src/auth/errors.js";
import { canAccessTask, DEPARTMENT_PERMISSIONS, PERMISSION_KEYS, requirePermissions, type PermissionKey } from "../src/auth/permissions.js";
import { LOGIN_WINDOW_MS, SESSION_LIFETIME_MS } from "../src/auth/service.js";
import type { AuthTransaction } from "../src/auth/store.js";
import { digest, newToken } from "../src/auth/tokens.js";
import { createFixture } from "./helpers/auth-store.js";

// All persistence below is an isolated, transient test double. None is SQL or durable-storage evidence.
function status(expected: number) {
  return (error: unknown) => {
    assert.equal(authFailure(error).status, expected);
    assert.equal(authFailure(error).message.includes("synthetic-private"), false);
    return true;
  };
}
const globalBucket = `client:${digest("web")}`;
const accountBucket = (email: string) => `account:${digest(email)}`;

test("offline real bcrypt accepts synthetic PHP-compatible 2a, 2b and 2y hash prefixes", async () => {
  const password = "Synthetic Unicode Å password";
  const hashed = hashSync(password, 4);
  for (const prefix of ["2a", "2b", "2y"]) {
    const f = createFixture({ password, user: { passwordHash: hashed.replace(/^\$2b\$/, `$${prefix}$`) } });
    const result = await f.service.login(f.user.email, password);
    assert.equal(result.user.localUserId, f.user.localUserId);
    assert.equal(await f.service.verifySessionCsrf(result.sessionToken, result.csrfToken), true);
  }
});

test("offline credentials normalize email case without trimming email or password", async () => {
  const f = createFixture({ password: "  Synthetic Å password  " });
  const result = await f.service.login(f.user.email.toUpperCase(), f.password);
  assert.equal(result.user.email, f.user.email);
  await assert.rejects(f.service.login(f.user.email, f.password.trim()), status(401));
  const calls = f.store.calls.length;
  await assert.rejects(f.service.login(` ${f.user.email}`, f.password), status(401));
  assert.equal(f.store.calls.length, calls);
});

test("offline missing, disabled and unsupported-hash users take the real dummy bcrypt path", async () => {
  for (const kind of ["missing", "disabled", "unsupported"] as const) {
    let comparedHash: string | undefined;
    const f = createFixture({
      user: kind === "disabled" ? { status: "inactive" } : kind === "unsupported" ? { passwordHash: "unsupported-synthetic-format" } : {},
      verifyPassword: async (password, hash) => { comparedHash = hash; return compare(password, hash); },
    });
    const email = kind === "missing" ? "absent@example.invalid" : f.user.email;
    await assert.rejects(f.service.login(email, f.password), status(401));
    assert.match(comparedHash ?? "", /^\$2[aby]\$12\$/);
    assert.notEqual(comparedHash, f.user.passwordHash);
    assert.equal(f.snapshot().sessions.size, 0);
  }
});

test("offline malformed credentials fail before store or password verification", async () => {
  let comparisons = 0;
  const f = createFixture({ verifyPassword: async () => { comparisons++; return true; } });
  for (const [email, password] of [[null, f.password], ["bad", f.password], [f.user.email, ""],
    [f.user.email, "bad\0password"], [f.user.email, "x".repeat(1025)], [f.user.email, 123]]) {
    await assert.rejects(f.service.login(email, password), status(401));
  }
  assert.equal(comparisons, 0);
  assert.deepEqual(f.store.calls, []);
});

test("offline five successful account attempts consume quota; blocked account still charges global bucket", async () => {
  const f = createFixture();
  for (let i = 0; i < 5; i++) await f.service.login(f.user.email, f.password);
  await assert.rejects(f.service.login(f.user.email, f.password), status(429));
  const state = f.snapshot();
  assert.equal(state.attempts.get(accountBucket(f.user.email))?.attempts, 5);
  assert.equal(state.attempts.get(globalBucket)?.attempts, 6);
  assert.equal(state.sessions.size, 5);
});

test("offline serialized concurrent reservations admit at most five account logins", async () => {
  const f = createFixture({ verifyPassword: async () => true });
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => f.service.login(f.user.email, f.password)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 5);
  for (const result of results) if (result.status === "rejected") assert.equal(authFailure(result.reason).status, 429);
  assert.equal(f.snapshot().sessions.size, 5);
  assert.equal(f.snapshot().attempts.get(globalBucket)?.attempts, 10);
});

test("offline global throttle stops after 100 attempts without creating another account bucket", async () => {
  let comparisons = 0;
  const f = createFixture({ verifyPassword: async () => { comparisons++; return false; } });
  for (let i = 0; i < 100; i++) await assert.rejects(f.service.login(`synthetic-${i}@example.invalid`, f.password), status(401));
  await assert.rejects(f.service.login("one-more@example.invalid", f.password), status(429));
  const state = f.snapshot();
  assert.equal(comparisons, 100);
  assert.equal(state.attempts.get(globalBucket)?.attempts, 100);
  assert.equal(state.attempts.size, 101);
  assert.equal(state.attempts.has(accountBucket("one-more@example.invalid")), false);
  assert.equal(state.sessions.size, 0);
});

test("offline throttle keeps its initial window and resets at the exact 15-minute boundary", async () => {
  const f = createFixture();
  const initial = f.now();
  await f.service.login(f.user.email, f.password);
  f.advance(LOGIN_WINDOW_MS - 1);
  await f.service.login(f.user.email, f.password);
  assert.deepEqual(f.snapshot().attempts.get(globalBucket), { attempts: 2, windowStart: initial });
  f.advance(1);
  await f.service.login(f.user.email, f.password);
  assert.deepEqual(f.snapshot().attempts.get(globalBucket), { attempts: 1, windowStart: initial + LOGIN_WINDOW_MS });
  assert.equal(f.snapshot().attempts.get(accountBucket(f.user.email))?.attempts, 1);
});

test("offline attempt reservation failure rolls back pruning and partial writes", async () => {
  const f = createFixture();
  await f.mutate(state => { state.attempts.set("synthetic-expired-bucket", { windowStart: f.now() - LOGIN_WINDOW_MS, attempts: 1 }); });
  const before = f.snapshot();
  f.failNext("incrementAttempt");
  await assert.rejects(f.service.login(f.user.email, f.password), status(503));
  assert.deepEqual(f.snapshot(), before);
});

test("offline authentication rejects disable and password changes during awaited real bcrypt", async () => {
  for (const change of ["disable", "password"] as const) {
    const f = createFixture({ verifyPassword: async (password, hash) => {
      const valid = await compare(password, hash);
      await f.patchUser(change === "disable" ? { status: "inactive" } : { passwordHash: hashSync("Different synthetic password", 4) });
      return valid;
    } });
    await assert.rejects(f.service.login(f.user.email, f.password), status(401));
    assert.equal(f.snapshot().sessions.size, 0);
  }
});

test("offline replacement account with the same email and hash cannot inherit an in-progress login", async () => {
  const f = createFixture({ verifyPassword: async (password, hash) => {
    const valid = await compare(password, hash);
    await f.mutate(state => {
      state.users.delete(f.user.localUserId);
      state.users.set("2", { ...f.user, localUserId: "2" });
    });
    return valid;
  } });
  await assert.rejects(f.service.login(f.user.email, f.password), status(401));
  assert.equal(f.snapshot().sessions.size, 0);
});

test("offline grants changed during password verification are read fresh before session response", async () => {
  const f = createFixture({ grants: ["users.write", "permissions.manage"], verifyPassword: async (password, hash) => {
    const valid = await compare(password, hash);
    await f.setGrants([]);
    return valid;
  } });
  const login = await f.service.login(f.user.email, f.password);
  assert.deepEqual(login.user.permissions, []);
  await assert.rejects(f.service.authorize(login.sessionToken, ["users.write"]), status(403));
});

test("offline session storage contains hashes only and preserves large string identities", async () => {
  const f = createFixture();
  const login = await f.service.login(f.user.email, f.password);
  assert.match(login.sessionToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(login.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(login.sessionToken, login.csrfToken);
  const session = f.snapshot().sessions.get(digest(login.sessionToken));
  assert.deepEqual(session, { tokenHash: digest(login.sessionToken), userId: f.user.localUserId,
    csrfHash: digest(login.csrfToken), passwordFingerprint: digest(f.user.passwordHash),
    createdAt: f.now(), expiresAt: f.now() + SESSION_LIFETIME_MS });
  const stored = JSON.stringify([...f.snapshot().sessions]);
  assert.equal(stored.includes(login.sessionToken), false);
  assert.equal(stored.includes(login.csrfToken), false);
  assert.equal(stored.includes(f.password), false);
  assert.equal(login.user.localUserId, "9007199254740993");
  assert.equal(login.user.externalUserId, "synthetic-external-user");
});

test("offline session expiry is absolute and observed expiry cannot revive after clock rewind", async () => {
  const f = createFixture();
  const initial = f.now();
  const login = await f.service.login(f.user.email, f.password);
  f.setNow(login.expiresAt - 1);
  assert.ok(await f.service.authenticate(login.sessionToken));
  assert.equal(f.snapshot().sessions.get(digest(login.sessionToken))?.expiresAt, login.expiresAt);
  f.setNow(login.expiresAt);
  assert.equal(await f.service.authenticate(login.sessionToken), null);
  assert.equal(f.snapshot().sessions.size, 0);
  f.setNow(initial); // Injected test clock only, never a host clock modification.
  assert.equal(await f.service.authenticate(login.sessionToken), null);
});

test("offline observed disabled, changed-password and deleted-user sessions cannot resurrect", async () => {
  for (const change of ["disable", "password", "deleted"] as const) {
    const f = createFixture();
    const login = await f.service.login(f.user.email, f.password);
    await f.mutate(state => {
      if (change === "deleted") state.users.delete(f.user.localUserId);
      else Object.assign(state.users.get(f.user.localUserId)!, change === "disable"
        ? { status: "inactive" } : { passwordHash: hashSync("Synthetic replacement", 4) });
    });
    assert.equal(await f.service.authenticate(login.sessionToken), null);
    assert.equal(f.snapshot().sessions.size, 0);
    await f.mutate(state => { state.users.set(f.user.localUserId, { ...f.user }); });
    assert.equal(await f.service.authenticate(login.sessionToken), null);
  }
});

test("offline current grants replace stale login grants and detached responses cannot change persistence", async () => {
  const f = createFixture({ grants: ["users.write", "permissions.manage"] });
  const login = await f.service.login(f.user.email, f.password);
  login.user.permissions.push("unrecognized.synthetic.grant");
  await f.setGrants(["users.write"]);
  const user = await f.service.authenticate(login.sessionToken);
  assert.deepEqual(user?.permissions, ["users.write"]);
  await assert.rejects(f.service.authorize(login.sessionToken, ["users.write", "permissions.manage"]), status(403));
  await f.setGrants([]);
  assert.deepEqual((await f.service.authenticate(login.sessionToken))?.permissions, []);
});

test("offline all 21 explicit keys require membership; dual, empty and unknown policies fail closed", () => {
  assert.equal(PERMISSION_KEYS.length, 21);
  assert.equal(new Set(PERMISSION_KEYS).size, 21);
  const base: AuthUser = { localUserId: "1", externalUserId: null, username: "Synthetic", email: "test@example.invalid", permissions: [] };
  for (const permission of PERMISSION_KEYS) {
    requirePermissions({ ...base, permissions: [permission] }, [permission]);
    assert.throws(() => requirePermissions(base, [permission]), status(403));
  }
  assert.throws(() => requirePermissions({ ...base, permissions: ["users.write"] }, ["users.write", "permissions.manage"]), status(403));
  requirePermissions({ ...base, permissions: ["users.write", "permissions.manage"] }, ["users.write", "permissions.manage"]);
  assert.throws(() => requirePermissions(base, []), status(503));
  assert.throws(() => requirePermissions({ ...base, permissions: ["unrecognized"] }, ["unrecognized" as PermissionKey]), status(503));
});

test("offline role labels and broad grants cannot bypass own-agent scope or local/external identity", () => {
  const user: AuthUser = { localUserId: "10", externalUserId: "external-10", username: "Synthetic",
    email: "test@example.invalid", permissions: ["leads.view"] };
  const task = { assignedTo: "other-external", latestAssignments: [] };
  assert.equal(canAccessTask(user, task), true);
  assert.equal(canAccessTask(user, null), false);
  assert.equal(canAccessTask({ ...user, permissions: ["leads.view", "leads.manage.agents"] }, task), false);
  assert.equal(canAccessTask({ ...user, permissions: ["leads.manage.agents"] }, { ...task, assignedTo: user.externalUserId }), true);
  assert.equal(canAccessTask({ ...user, permissions: ["leads.manage.agents"] }, { ...task, assignedTo: user.localUserId }), false);
  assert.equal(canAccessTask({ ...user, externalUserId: null, permissions: ["leads.manage.agents"] }, { ...task, assignedTo: null }), false);
  for (const permissions of [["dashboard.view"], ["leads.manage"], ["deals.manage"], ["admin"], []]) {
    assert.equal(canAccessTask(Object.assign({ ...user, permissions }, { role: "administrator", quote_access: true }), task), false);
  }
});

test("offline all five department scopes permit own latest assignment even after agent mismatch", () => {
  const base: AuthUser = { localUserId: "10", externalUserId: "external-10", username: "Synthetic",
    email: "test@example.invalid", permissions: [] };
  for (const [department, permission] of Object.entries(DEPARTMENT_PERMISSIONS)) {
    const user = { ...base, permissions: ["leads.manage.agents", "leads.view", permission] };
    const task = { assignedTo: "other-external", latestAssignments: [{ department, userId: "10" }] };
    assert.equal(canAccessTask(user, task), true);
    assert.equal(canAccessTask({ ...base, permissions: ["leads.manage.agents"] }, task), false);
    assert.equal(canAccessTask(user, { ...task, latestAssignments: [{ department, userId: "external-10" }] }), false);
    assert.equal(canAccessTask(user, { ...task, latestAssignments: [{ department, userId: null }] }), false);
    assert.equal(canAccessTask(user, { ...task, latestAssignments: [{ department: "constructor", userId: "10" }] }), false);
  }
});

test("offline session-bound CSRF denies wrong tokens and invalidates old binding on rotation", async () => {
  const f = createFixture();
  const first = await f.service.login(f.user.email, f.password);
  const second = await f.service.login(f.user.email, f.password);
  assert.equal(await f.service.verifySessionCsrf(first.sessionToken, first.csrfToken), true);
  assert.equal(await f.service.verifySessionCsrf(first.sessionToken, second.csrfToken), false);
  const rotated = newToken();
  assert.equal(await f.service.setSessionCsrf(first.sessionToken, rotated), true);
  assert.equal(await f.service.verifySessionCsrf(first.sessionToken, first.csrfToken), false);
  assert.equal(await f.service.verifySessionCsrf(first.sessionToken, rotated), true);
  assert.equal(await f.service.verifySessionCsrf(second.sessionToken, second.csrfToken), true);
});

test("offline malformed tokens never enter the store", async () => {
  const f = createFixture();
  for (const value of [undefined, null, "", "short", "x".repeat(44), "!".repeat(43), {}, 123]) {
    assert.equal(await f.service.authenticate(value), null);
    assert.equal(await f.service.verifySessionCsrf(value, newToken()), false);
    assert.equal(await f.service.verifySessionCsrf(newToken(), value), false);
    assert.equal(await f.service.setSessionCsrf(value, newToken()), false);
    await f.service.logout(value);
  }
  assert.deepEqual(f.store.calls, []);
});

test("offline missing or expired session cannot acquire a new CSRF binding", async () => {
  const f = createFixture();
  assert.equal(await f.service.setSessionCsrf(newToken(), newToken()), false);
  const login = await f.service.login(f.user.email, f.password);
  f.setNow(login.expiresAt);
  assert.equal(await f.service.setSessionCsrf(login.sessionToken, newToken()), false);
  assert.equal(f.snapshot().sessions.size, 0);
});

test("offline logout is idempotent and revoked cookie replay cannot authenticate or authorize", async () => {
  const f = createFixture();
  const login = await f.service.login(f.user.email, f.password);
  await f.service.logout(login.sessionToken);
  await f.service.logout(login.sessionToken);
  assert.equal(await f.service.authenticate(login.sessionToken), null);
  assert.equal(await f.service.verifySessionCsrf(login.sessionToken, login.csrfToken), false);
  await assert.rejects(f.service.authorize(login.sessionToken, ["leads.view"]), status(401));
});

test("offline logout store failure rolls back revocation instead of reporting success", async () => {
  const f = createFixture();
  const login = await f.service.login(f.user.email, f.password);
  const before = f.snapshot().sessions;
  f.failNext("deleteSession");
  await assert.rejects(f.service.logout(login.sessionToken), status(503));
  assert.deepEqual(f.snapshot().sessions, before);
  assert.ok(await f.service.authenticate(login.sessionToken));
});

test("offline login replacement atomically rolls back new issuance when prior revocation fails", async () => {
  const f = createFixture();
  const previous = await f.service.login(f.user.email, f.password);
  const before = f.snapshot().sessions;
  f.failNext("deleteSession");
  await assert.rejects(f.service.login(f.user.email, f.password, previous.sessionToken), status(503));
  assert.deepEqual(f.snapshot().sessions, before);
  assert.ok(await f.service.authenticate(previous.sessionToken));
  const replacement = await f.service.login(f.user.email, f.password, previous.sessionToken);
  assert.notEqual(replacement.sessionToken, previous.sessionToken);
  assert.equal(await f.service.authenticate(previous.sessionToken), null);
  assert.equal(f.snapshot().sessions.size, 1);
  assert.ok(await f.service.authenticate(replacement.sessionToken));
});

test("offline failed session insert or late grant read leaves no partial replacement", async () => {
  for (const operation of ["insertSession", "permissionsFor"] as const) {
    const f = createFixture();
    const previous = await f.service.login(f.user.email, f.password);
    const before = f.snapshot().sessions;
    f.failNext(operation);
    await assert.rejects(f.service.login(f.user.email, f.password, previous.sessionToken), status(503));
    assert.deepEqual(f.snapshot().sessions, before);
    assert.ok(await f.service.authenticate(previous.sessionToken));
  }
});

test("offline failed CSRF rotation preserves old binding", async () => {
  const f = createFixture();
  const login = await f.service.login(f.user.email, f.password);
  const before = f.snapshot().sessions;
  f.failNext("updateSessionCsrf");
  await assert.rejects(f.service.setSessionCsrf(login.sessionToken, newToken()), status(503));
  assert.deepEqual(f.snapshot().sessions, before);
  assert.equal(await f.service.verifySessionCsrf(login.sessionToken, login.csrfToken), true);
});

test("offline unknown and malformed persisted CSRF hashes cannot pass comparison", async () => {
  const f = createFixture();
  const login = await f.service.login(f.user.email, f.password);
  for (const hash of ["", "bad", "A".repeat(64), "z".repeat(64)]) {
    await f.mutate(state => { state.sessions.get(digest(login.sessionToken))!.csrfHash = hash; });
    assert.equal(await f.service.verifySessionCsrf(login.sessionToken, login.csrfToken), false);
  }
});

test("offline fixture snapshots are detached and an escaped transaction cannot later mutate them", async () => {
  const f = createFixture();
  let escaped: AuthTransaction | undefined;
  await f.store.transaction(async tx => {
    escaped = tx;
    const user = await tx.findUserById(f.user.localUserId);
    user!.status = "inactive";
  });
  assert.equal(f.snapshot().users.get(f.user.localUserId)?.status, "active");
  await assert.rejects(escaped!.incrementAttempt("escaped", f.now()), /Expired fixture transaction/);
  assert.equal(f.snapshot().attempts.has("escaped"), false);
});
