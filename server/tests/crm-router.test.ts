import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import type { Request, Response } from "express";
import { CRM_ROUTES, createCrmRouterWithServices, type CrmServices } from "../src/crm/router.js";
import { DepartmentsError } from "../src/crm/departments/service.js";
import { CommercialPersistenceError } from "../src/crm/commercial/service.js";
import { logAttachmentLimit } from "@voltronix/crm-contracts";

// In-process Express Router execution only: no listener, files, SQL or profiles.
const origin = "http://127.0.0.1:3001", token = "a".repeat(43), csrf = "b".repeat(43);
const user = { localUserId: "1", externalUserId: "101", username: "Synthetic", email: "synthetic@example.invalid", permissions: [] as string[] };
type Result = { status: number; headers: Record<string, string>; body: unknown };
function fixture(permissions: string[] = []): CrmServices {
  return { auth: { authenticate: async () => ({ ...user, permissions }), verifySessionCsrf: async () => true } } as unknown as CrmServices;
}
async function invoke(method: string, path: string, services?: CrmServices, headers: Record<string, string> = {}, payload?: string | Buffer): Promise<Result> {
  const router = createCrmRouterWithServices(origin, services), data = payload === undefined ? [] : [Buffer.from(payload)];
  const request = Object.assign(Readable.from(data), { method, url: path, originalUrl: path, headers,
    complete: payload === undefined, get: (name: string) => headers[name.toLowerCase()] }) as unknown as Request;
  return new Promise((resolve, reject) => {
    const output: Result = { status: 200, headers: {}, body: undefined };
    const events = new EventEmitter();
    const response = Object.assign(events, { headersSent: false, writableEnded: false, destroyed: false,
      setHeader(name: string, value: string) { output.headers[name.toLowerCase()] = value; },
      vary(name: string) { output.headers.vary = name; },
      status(status: number) { output.status = status; return this; },
      set(values: Record<string, string>) { for (const [name, value] of Object.entries(values)) output.headers[name.toLowerCase()] = value; return this; },
      json(body: unknown) { this.headersSent = true; output.body = body; resolve(output); events.emit("finish"); return this; },
      send(body: unknown) { this.headersSent = true; output.body = body; resolve(output); events.emit("finish"); return this; },
    }) as unknown as Response;
    // The router is a callable middleware; Express types omit its internal handle.
    router(request, response, error => error ? reject(error) : resolve({ ...output, status: 404 }));
  });
}
function credentials(extra: Record<string, string> = {}) {
  return { origin, cookie: `crm_session=${token}; crm_csrf=${csrf}`, "x-csrf-token": csrf, "content-type": "application/json", ...extra };
}
test("OFFLINE source department multipart limits accept exact file limit and refuse +1 before service dispatch", async () => {
  const services = fixture(); let saves = 0;
  services.departments = { authorizeLog: async () => {}, addLog: async (_token: string, department: string, _id: string, _body: unknown, file: { content: Buffer }) => {
    assert.equal(file.content.length, logAttachmentLimit(department)); saves++; return { version: 2 };
  } } as unknown as CrmServices["departments"];
  for (const department of ["Electrical", "Civil", "PM", "Switchgear", "Maintenance"]) {
    const maximum = logAttachmentLimit(department), boundary = "source-limit-fixture";
    const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n{}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.gif"\r\nContent-Type: image/gif\r\n\r\n`), suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const headers = credentials({ "content-type": `multipart/form-data; boundary=${boundary}` }), path = `/api/v1/departments/${department}/jobs/1/logs`;
    assert.equal((await invoke("POST", path, services, headers, Buffer.concat([prefix, Buffer.alloc(maximum), suffix]))).status, 200, department);
    assert.equal((await invoke("POST", path, services, headers, Buffer.concat([prefix, Buffer.alloc(maximum + 1), suffix]))).status, 413, department);
  }
  assert.equal(saves, 5);
});
const actual = (path: string) => path.replace(/:department/g, "Electrical").replace(/:[A-Za-z]+/g, "1");

test("OFFLINE all68 business methods are versioned and refuse absent storage", async () => {
  assert.equal(CRM_ROUTES.length, 68);
  assert.equal(new Set(CRM_ROUTES.map(route => `${route.method} ${route.path}`)).size, 68);
  for (const route of CRM_ROUTES) {
    assert.ok(route.path.startsWith("/api/v1/"));
    const reply = await invoke(route.method, actual(route.path));
    assert.equal(reply.status, 503, `${route.method} ${route.path}`);
    assert.deepEqual(reply.body, { error: "The service is temporarily unavailable." });
    assert.equal(reply.headers["cache-control"], "no-store");
  }
});
test("OFFLINE every68 business route requires a server-validated session", async () => {
  const services = fixture();
  for (const route of CRM_ROUTES) {
    assert.equal((await invoke(route.method, actual(route.path), services, { origin })).status, 401, route.path);
    assert.equal((await invoke(route.method, actual(route.path), services, { origin, cookie: "crm_session=invalid" })).status, 401, route.path);
  }
  services.auth.authenticate = async () => null;
  assert.equal((await invoke("GET", "/api/v1/dashboard", services, credentials())).status, 401);
});
test("OFFLINE every mutation rejects cross-origin and missing CSRF before parsing or dispatch", async () => {
  const services = fixture(["dashboard.view", "deals.manage", "leads.manage", "items.write", "users.write", "permissions.manage"]);
  for (const route of CRM_ROUTES.filter(route => route.method !== "GET")) {
    assert.equal((await invoke(route.method, actual(route.path), services, credentials({ origin: "https://other.invalid" }), "{}")).status, 403);
    assert.equal((await invoke(route.method, actual(route.path), services, credentials({ "x-csrf-token": "" }), "{}")).status, 403);
  }
  services.auth.verifySessionCsrf = async () => false;
  assert.equal((await invoke("PATCH", "/api/v1/jobs/1/status", services, credentials(), "{}")).status, 403);
});
test("OFFLINE duplicate auth cookies and stale authentication fail closed without internal errors", async () => {
  const services = fixture();
  assert.equal((await invoke("GET", "/api/v1/dashboard", services, credentials({ cookie: `crm_session=${token}; crm_session=${token}` }))).status, 400);
  services.auth.authenticate = async () => { throw new Error("synthetic private SQL detail"); };
  assert.deepEqual((await invoke("GET", "/api/v1/dashboard", services, credentials())).body, { error: "The service is temporarily unavailable." });
});
test("OFFLINE protected settings and management enforce all wrapper permissions", async () => {
  for (const permissions of [[], ["users.write"], ["permissions.manage"]]) {
    const reply = await invoke("POST", "/api/v1/settings/users", fixture(permissions), credentials(), "{}");
    assert.equal(reply.status, 403);
  }
  assert.equal((await invoke("PATCH", "/api/v1/jobs/1/status", fixture(), credentials(), "{}")).status, 403);
  assert.equal((await invoke("POST", "/api/v1/items", fixture(["items.view"]), credentials(), "{}")).status, 403);
});

test("OFFLINE synced directory is read-only and requires both account administration grants", async () => {
  const path = "/api/v1/settings/zoho-users";
  for (const permissions of [[], ["users.write"], ["permissions.manage"], ["leads.manage.agents", "sales_dashboard.view"]]) {
    assert.equal((await invoke("GET", path, fixture(permissions), credentials())).status, 403);
  }
  const services = fixture(["users.write", "permissions.manage"]); let seen: unknown;
  const unused = async (): Promise<never> => { throw new Error("Unexpected directory dispatch"); };
  services.sync = { listDirectory: async (session, input) => { assert.equal(session, token); seen = input; return { items: [], total: 0, page: 2, pageSize: 5 }; }, status: unused, listQuotations: unused };
  assert.equal((await invoke("GET", `${path}?query=Example&page=2&pageSize=5`, services, credentials())).status, 200);
  assert.deepEqual(seen, { query: "Example", page: 2, pageSize: 5 });
  assert.equal((await invoke("GET", `${path}?unknown=1`, services, credentials())).status, 400);
  assert.equal((await invoke("GET", `${path}?page=1&page=2`, services, credentials())).status, 400);
  assert.equal((await invoke("POST", path, services, credentials(), "{}")).status, 405);
});
test("OFFLINE routes preserve query validation, paging values and task read-origin asymmetry", async () => {
  const services = fixture(); let seen: unknown;
  services.leads = { listPipeline: async (session, query) => { assert.equal(session, token); seen = query; return { scope: "own" }; } } as CrmServices["leads"];
  assert.equal((await invoke("GET", "/api/v1/pipeline?page=2&pageSize=5&scope=own", services, credentials())).status, 200);
  assert.deepEqual(seen, { page: 2, pageSize: 5, scope: "own" });
  assert.equal((await invoke("GET", "/api/v1/pipeline?page=1&page=2", services, credentials())).status, 400);
  assert.equal((await invoke("GET", "/api/v1/pipeline?unknown=x", services, credentials())).status, 400);
  assert.equal((await invoke("GET", "/api/v1/pipeline", services, credentials({ origin: "https://other.invalid" }))).status, 403);
  services.auth.getAuthorizedTask = async () => ({ id: "1", dealName: "Synthetic", status: "Pending" });
  assert.equal((await invoke("GET", "/api/v1/tasks/1?ignored=1", services, credentials({ origin: "https://other.invalid" }))).status, 200);
});
test("OFFLINE bounded JSON rejects invalid encoding/content/length and dispatches validated bytes", async () => {
  const services = fixture(["dashboard.view"]); let seen: unknown;
  services.jobs = { updateStatus: async (_token, task, body) => { seen = { task, body }; return { version: 2 }; } } as CrmServices["jobs"];
  const path = "/api/v1/jobs/9007199254740993/status", payload = JSON.stringify({ expectedVersion: 1, jobStatus: "Hold" });
  assert.equal((await invoke("PATCH", path, services, credentials(), payload)).status, 200);
  assert.deepEqual(seen, { task: "9007199254740993", body: { expectedVersion: 1, jobStatus: "Hold" } });
  assert.equal((await invoke("PATCH", path, services, credentials({ "content-type": "text/plain" }), payload)).status, 415);
  assert.equal((await invoke("PATCH", path, services, credentials({ "content-encoding": "gzip" }), payload)).status, 415);
  assert.equal((await invoke("PATCH", path, services, credentials(), "{")).status, 400);
  assert.equal((await invoke("PATCH", path, services, credentials(), Buffer.from([0xff]))).status, 400);
  assert.equal((await invoke("PATCH", path, services, credentials({ "content-length": "9000" }), payload)).status, 413);
  assert.equal((await invoke("PATCH", path, services, credentials(), " ".repeat(8193))).status, 413);
});
test("OFFLINE uploads authorize parent before multipart read and downloads remain private", async () => {
  const services = fixture(); let read = false;
  services.departments = { authorizeLog: async () => { throw new DepartmentsError(404); } } as unknown as CrmServices["departments"];
  const result = await invoke("POST", "/api/v1/departments/Electrical/jobs/1/logs", services,
    credentials({ "content-type": "multipart/form-data; boundary=x" }), "unread invalid multipart");
  assert.equal(result.status, 404);
  services.attachments = { download: async () => { read = true; return { id: "1", name: "Synthetic test.txt", mediaType: "text/plain", size: 4, content: Buffer.from("test") }; } } as unknown as CrmServices["attachments"];
  const file = await invoke("GET", "/api/v1/attachments/1", services, credentials());
  assert.equal(file.status, 200); assert.equal(read, true);
  assert.equal(file.headers["cache-control"], "private, no-store");
  assert.equal(file.headers["content-security-policy"], "sandbox; default-src 'none'");
  assert.match(file.headers["content-disposition"]!, /Synthetic%20test.txt/);
});
test("OFFLINE commercial rules remain service-owned and safe errors preserve source status", async () => {
  const services = fixture(["leads.manage", "permissions.manage"]);
  services.commercial = { updateQuotation: async () => { throw new CommercialPersistenceError(409); } } as unknown as CrmServices["commercial"];
  assert.equal((await invoke("PATCH", "/api/v1/quotations/1", services, credentials(), "{}")).status, 409);
  services.settings = { createGroup: async () => ({ id: "1", version: 1 }) } as unknown as CrmServices["settings"];
  assert.equal((await invoke("POST", "/api/v1/settings/permission-groups", services, credentials(), "{}")).status, 201);
  assert.equal((await invoke("DELETE", "/api/v1/settings/permission-groups", services, credentials())).status, 405);
});

test("OFFLINE local write capabilities default unavailable and require explicit composition", async () => {
  const services = fixture();
  const result = await invoke("GET", "/api/v1/capabilities", services, credentials());
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { persistence: "unavailable", productCreate: false, leadNotes: false, integrationAvailable: false });
  assert.equal((await invoke("GET", "/api/v1/capabilities?ignored=1", services, credentials())).status, 400);
  assert.equal((await invoke("GET", "/api/v1/capabilities", services, credentials({ origin: "https://other.invalid" }))).status, 403);
  services.localWrites = { capabilities: async session => {
    assert.equal(session, token); return { persistence: "local-demo", productCreate: true, leadNotes: false, integrationAvailable: false };
  } };
  assert.deepEqual((await invoke("GET", "/api/v1/capabilities", services, credentials())).body,
    { persistence: "local-demo", productCreate: true, leadNotes: false, integrationAvailable: false });
});

test("OFFLINE every68 method dispatches its source-mapped service with the authenticated token", async () => {
  const expected: Record<string, string> = {
    "GET /tasks/:id": "auth.getAuthorizedTask", "GET /capabilities": "localWrites.capabilities", "GET /dashboard": "dashboard.getDashboard",
    "GET /zoho-sync/status": "sync.status", "GET /zoho-sync/quotations": "sync.listQuotations",
    "GET /settings/zoho-users": "sync.listDirectory",
    "GET /pipeline": "leads.listPipeline", "GET /pipeline/agents": "leads.listAgents", "GET /leads/:id": "leads.getLead",
    "GET /leads/:id/notes": "leads.listNotes", "GET /leads/:id/history": "leads.listStatusHistory", "GET /leads/:id/capabilities": "mutations.capabilities",
    "POST /leads/:id/notes": "mutations.addNote", "PATCH /leads/:id/notes/:noteId": "mutations.editNote", "PATCH /leads/:id/stage": "mutations.changeStage", "POST /deals": "mutations.createDeal", "GET /deals": "localReads.listCreatedDeals",
    "GET /items": "commercial.listProducts", "POST /items": "commercial.createProduct", "GET /items/:id": "commercial.getProduct",
    "GET /quotations": "commercial.listQuotations", "GET /quotations/candidates": "commercial.listQuotationCandidates", "POST /quotations": "commercial.createQuotation",
    "GET /quotations/:taskId": "commercial.getQuotation", "PATCH /quotations/:taskId": "commercial.updateQuotation", "GET /quotations/:taskId/capabilities": "commercial.quotationCapabilities", "GET /quotations/:taskId/pdf": "pdf.download",
    "GET /jobs": "localReads.listJobs", "GET /jobs/export": "localReads.exportJobs", "GET /jobs/:id": "jobs.getJob", "PATCH /jobs/:id/status": "jobs.updateStatus", "PATCH /jobs/:id/remarks": "jobs.updateRemarks",
    "GET /jobs/:id/assignments": "departments.getAssignments", "POST /jobs/:id/assignments": "departments.assign", "POST /jobs/:id/accounts": "departments.assignAccounts", "POST /jobs/:id/unassign": "departments.unassign", "GET /jobs/:id/logs": "departments.listJobLogs",
    "GET /departments/:department/assignees": "departments.listAssignees", "GET /departments/:department/jobs": "departments.listQueue", "GET /departments/:department/jobs/:id": "departments.getJob", "GET /departments/:department/jobs/:id/logs": "departments.listLogs",
    "POST /departments/:department/jobs/:id/logs": "departments.addLog", "PATCH /departments/:department/jobs/:id/status": "departments.updateStatus", "GET /departments/:department/export": "exports.exportDepartmentJobs",
    "GET /leads/:id/attachments": "attachments.list", "POST /leads/:id/attachments": "attachments.upload", "GET /attachments/:id": "attachments.download", "GET /attachments/:id/preview": "attachments.download", "GET /log-attachments/:id": "departments.downloadLogAttachment", "GET /log-attachments/:id/preview": "departments.downloadLogAttachment", "GET /reports/employee-performance": "reports.employeePerformance",
    "GET /settings/grant-users": "settings.listGrantUsers", "GET /settings/permission-groups": "settings.listGroups", "POST /settings/permission-groups": "settings.createGroup", "GET /settings/permission-groups/:id": "settings.getGroup", "PATCH /settings/permission-groups/:id": "settings.updateGroup",
    "GET /settings/permissions": "settings.listPermissions", "POST /settings/permissions": "settings.createPermission", "GET /settings/permissions/:id": "settings.getPermission", "PATCH /settings/permissions/:id": "settings.updatePermission",
    "GET /settings/users": "settings.listUsers", "POST /settings/users": "settings.createUser", "GET /settings/users/:id": "settings.getUser", "PATCH /settings/users/:id": "settings.updateUser", "POST /settings/users/:id/status": "settings.setUserStatus", "PUT /settings/users/:id/department": "settings.assignDepartment", "GET /settings/users/:id/permissions": "settings.getGrants", "PUT /settings/users/:id/permissions": "settings.replaceGrants",
  };
  assert.equal(Object.keys(expected).length, 68);
  const calls: { method: string; args: unknown[] }[] = [];
  const method = (group: string, name: string) => async (...args: unknown[]) => {
    calls.push({ method: `${group}.${name}`, args });
    if (name === "downloadLogAttachment") return { content: Buffer.from("fixture"), name: "fixture.csv", mediaType: "text/csv" };
    if (name === "download" || name === "downloadLogAttachment" || name.startsWith("export")) {
      return { bytes: Buffer.from("fixture"), content: Buffer.from("fixture"), name: "fixture.txt", filename: "fixture.pdf", mediaType: "text/plain", contentType: "application/octet-stream" };
    }
    return { items: [], taskId: "1", id: "1" };
  };
  const services = fixture(["dashboard.view", "deals.manage", "deals.view", "leads.manage", "items.write", "users.write", "permissions.manage"]);
  for (const group of ["dashboard", "leads", "mutations", "commercial", "jobs", "departments", "attachments", "reports", "exports", "settings", "pdf", "localWrites", "localReads", "sync"] as const) {
    Object.assign(services, { [group]: new Proxy({}, { get: (_target, name) => method(group, String(name)) }) });
  }
  services.auth.getAuthorizedTask = method("auth", "getAuthorizedTask") as unknown as CrmServices["auth"]["getAuthorizedTask"];
  for (const route of CRM_ROUTES) {
    calls.length = 0;
    let payload: string | undefined = route.method === "GET" ? undefined : JSON.stringify({ taskId: "1" });
    let headers = credentials();
    if (route.method === "POST" && route.path.endsWith("/attachments")) {
      headers = credentials({ "content-type": "multipart/form-data; boundary=fixture" });
      payload = '--fixture\r\nContent-Disposition: form-data; name="expectedVersion"\r\n\r\n1\r\n--fixture\r\nContent-Disposition: form-data; name="file"; filename="fixture.txt"\r\nContent-Type: text/plain\r\n\r\nsynthetic\r\n--fixture--\r\n';
    }
    const response = await invoke(route.method, actual(route.path), services, headers, payload);
    assert.ok([200, 201].includes(response.status), `${route.method} ${route.path}: ${response.status}`);
    const last = calls.at(-1);
    assert.equal(last?.method, expected[`${route.method} ${route.path.slice("/api/v1".length)}`]);
    assert.equal(last?.args[0], token);
    if (route.path.includes(":id") && !route.path.includes(":department")) assert.equal(last?.args[1], "1");
    if (route.path.includes(":department")) assert.equal(last?.args[1], "Electrical");
  }
});

test("OFFLINE optional source lists preserve default services and require explicit authorization", async () => {
  const services = fixture(["dashboard.view", "deals.view"]); let seen: unknown;
  const unused = async (): Promise<never> => { throw new Error("Unexpected service dispatch in source-list test."); };
  services.jobs = {
    listJobs: async (_token, input) => { seen = input; return { items: [], total: 0, page: 1, pageSize: 25 }; },
    getJob: unused, updateStatus: unused, updateRemarks: unused,
  };
  services.exports = {
    exportJobs: async (_token, input) => { seen = input; return { bytes: new Uint8Array(), contentType: "application/octet-stream", filename: "fixture.xlsx", rowCount: 0 }; },
    exportDepartmentJobs: unused,
  };
  assert.equal((await invoke("GET", "/api/v1/deals", fixture(["deals.manage"]), credentials())).status, 403);
  assert.equal((await invoke("GET", "/api/v1/deals", services, credentials())).status, 503);
  assert.equal((await invoke("GET", "/api/v1/deals?scope=own", services, credentials())).status, 400);
  assert.equal((await invoke("GET", "/api/v1/deals", services, credentials({ origin: "https://other.invalid" }))).status, 403);
  assert.equal((await invoke("GET", "/api/v1/jobs?cohort=all&page=2", services, credentials())).status, 200);
  assert.deepEqual(seen, { page: 2 });
  assert.equal((await invoke("GET", "/api/v1/jobs/export?cohort=all&query=salesperson", services, credentials())).status, 200);
  assert.deepEqual(seen, { query: "salesperson" });
  for (const cohort of ["pending", "process", "completed", "hold", "closed"]) {
    assert.equal((await invoke("GET", `/api/v1/jobs?cohort=${cohort}`, services, credentials())).status, 503);
    assert.equal((await invoke("GET", `/api/v1/jobs/export?cohort=${cohort}`, services, credentials())).status, 503);
  }
  assert.equal((await invoke("GET", "/api/v1/jobs?cohort=unknown", services, credentials())).status, 400);
  assert.equal((await invoke("GET", "/api/v1/jobs?cohort=all&cohort=hold", services, credentials())).status, 400);
  assert.equal((await invoke("GET", "/api/v1/jobs?cohort=pending", fixture(["deals.view"]), credentials())).status, 403);
  assert.equal((await invoke("GET", "/api/v1/jobs/export?cohort=pending", fixture(["deals.view"]), credentials())).status, 403);
  assert.equal((await invoke("GET", "/api/v1/jobs/export?page=1", services, credentials())).status, 400);
});

test("OFFLINE source read capabilities enable cohorts without enabling writes and retain protected dispatch", async () => {
  const services = fixture(["dashboard.view", "deals.view"]); let seen: unknown;
  services.localReads = {
    listCreatedDeals: async (_token, input) => { seen = input; return { items: [], total: 0, page: 1, pageSize: 25 }; },
    listJobs: async (_token, input) => { seen = input; return { items: [], total: 0, page: 1, pageSize: 25 }; },
    exportJobs: async (_token, input) => { seen = input; return { bytes: new Uint8Array(), contentType: "application/octet-stream", filename: "fixture.xlsx", rowCount: 0 }; },
  };
  assert.deepEqual((await invoke("GET", "/api/v1/capabilities", services, credentials())).body,
    { persistence: "unavailable", productCreate: false, leadNotes: false, integrationAvailable: false, jobCohorts: true });
  for (const cohort of ["pending", "process", "completed", "hold", "closed"]) {
    assert.equal((await invoke("GET", `/api/v1/jobs?cohort=${cohort}`, services, credentials())).status, 200);
    assert.deepEqual(seen, { cohort });
    assert.equal((await invoke("GET", `/api/v1/jobs/export?cohort=${cohort}`, services, credentials())).status, 200);
    assert.deepEqual(seen, { cohort });
  }
  assert.equal((await invoke("GET", "/api/v1/deals?query=agent", services, credentials())).status, 200);
  assert.deepEqual(seen, { query: "agent" });
  services.auth.authenticate = async () => ({ ...user, permissions: [] });
  assert.equal((await invoke("GET", "/api/v1/jobs?cohort=pending", services, credentials())).status, 403);
  assert.equal((await invoke("GET", "/api/v1/deals", services, credentials())).status, 403);
});
