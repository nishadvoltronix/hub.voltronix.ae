import { createServer, request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../../src/app.js";
import { createHttpLifecycle } from "../../src/server.js";
import { assertNoHarnessDebug } from "../mysql-auth/http-browser.js";
import { CrmDemoCaseError, consumeCrmDemo, ensureCrmDemo, verifyCrmDemoFixture } from "./fixture.js";
import type { CrmDemoCaseOptions } from "./cases.js";

export const expectedCrmDemoHttpChecks = 5;

interface Reply { status: number; headers: IncomingHttpHeaders; bytes: Buffer }
interface Session { cookie: string; csrf: string }
function object(reply: Reply): Record<string, unknown> {
  const value: unknown = JSON.parse(reply.bytes.toString("utf8"));
  ensureCrmDemo(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>;
}
function cookies(reply: Reply) {
  return (reply.headers["set-cookie"] ?? []).map(value => value.split(";")[0]).join("; ");
}
function string(value: unknown): string { ensureCrmDemo(typeof value === "string"); return value; }

/** Prepared authenticated Express HTTP checks only. No Chromium is launched.
 * Next.js-through-browser requires its own reviewed owned-process harness; it
 * must never be reported as passed by these direct API requests. */
export async function runCrmDemoHttp(options: CrmDemoCaseOptions): Promise<number> {
  assertNoHarnessDebug(process.env, process.execArgv);
  await verifyCrmDemoFixture(options.fixtureConnection, options.fixture); consumeCrmDemo(options.fixture, "http");
  const runtime = options.createRuntime();
  let application: ReturnType<typeof createApp> | undefined;
  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000, keepAliveTimeout: 1_000, maxHeaderSize: 16_384 }, (incoming, response) => {
    if (!application) { response.writeHead(503); response.end(); return; }
    application(incoming, response);
  });
  const lifecycle = createHttpLifecycle(server);
  let passed = 0, failed = false;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const port = (server.address() as AddressInfo).port;
    ensureCrmDemo(Number.isInteger(port) && port >= 1024 && port <= 65535);
    const origin = `http://127.0.0.1:${port}`;
    application = createApp({ environment: "test", host: "127.0.0.1", port, appOrigin: origin }, { auth: runtime.auth, crmDatabase: runtime.database });
    const call = (path: string, method = "GET", headers: Record<string, string> = {}, body?: string): Promise<Reply> => {
      ensureCrmDemo(/^\/api\/v1\/[A-Za-z0-9/_-]+$/.test(path));
      return new Promise((resolve, reject) => {
        const outgoing = request({ host: "127.0.0.1", port, path, method, headers, agent: false }, incoming => {
          const chunks: Buffer[] = []; let size = 0;
          incoming.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 20 * 1024 * 1024) incoming.destroy(new CrmDemoCaseError()); else chunks.push(chunk); });
          incoming.once("error", () => reject(new CrmDemoCaseError()));
          incoming.once("end", () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, bytes: Buffer.concat(chunks) }));
        });
        outgoing.once("error", () => reject(new CrmDemoCaseError())); outgoing.setTimeout(10_000, () => outgoing.destroy(new CrmDemoCaseError())); outgoing.end(body);
      });
    };
    const headers = (session: Session) => ({ origin, cookie: session.cookie, "x-csrf-token": session.csrf, "content-type": "application/json" });
    const login = async (name: keyof typeof options.fixture.identities): Promise<Session> => {
      const challenge = await call("/api/v1/auth/csrf"); ensureCrmDemo(challenge.status === 200);
      const csrf = string(object(challenge).csrfToken);
      const reply = await call("/api/v1/auth/login", "POST", { origin, cookie: cookies(challenge), "x-csrf-token": csrf, "content-type": "application/json" },
        JSON.stringify({ email: options.fixture.identities[name].email, password: options.fixture.password }));
      ensureCrmDemo(reply.status === 200);
      return { cookie: cookies(reply), csrf: string(object(reply).csrfToken) };
    };
    const check = async (name: string, work: () => Promise<void>) => { await work(); options.record(name, "http"); passed++; };
    const operator = await login("operator"), denied = await login("denied");
    await check("HTTP authentication CSRF origin and permission boundaries", async () => {
      ensureCrmDemo((await call("/api/v1/jobs")).status === 401);
      ensureCrmDemo((await call("/api/v1/jobs", "GET", headers(denied))).status === 403);
      ensureCrmDemo((await call("/api/v1/jobs", "GET", headers(operator))).status === 200);
      ensureCrmDemo((await call(`/api/v1/jobs/${options.fixture.jobId}/remarks`, "PATCH", { ...headers(operator), origin: "https://unapproved.invalid" }, "{}")).status === 403);
      ensureCrmDemo((await call(`/api/v1/jobs/${options.fixture.jobId}/remarks`, "PATCH", { ...headers(operator), "x-csrf-token": "" }, "{}")).status === 403);
    });
    await check("HTTP job persistence and conflicting version responses", async () => {
      const initial = await call(`/api/v1/jobs/${options.fixture.jobId}`, "GET", headers(operator)); ensureCrmDemo(initial.status === 200);
      const version = object(initial).version;
      const payload = JSON.stringify({ expectedVersion: version, remarks: `${options.fixture.marker}:http` });
      const updated = await call(`/api/v1/jobs/${options.fixture.jobId}/remarks`, "PATCH", headers(operator), payload);
      ensureCrmDemo(updated.status === 200 && object(updated).version === Number(version) + 1);
      ensureCrmDemo((await call(`/api/v1/jobs/${options.fixture.jobId}/remarks`, "PATCH", headers(operator), payload)).status === 409);
      ensureCrmDemo((await call(`/api/v1/jobs/${options.fixture.jobId}/remarks`, "PATCH", headers(operator), "{")).status === 400);
    });
    await check("HTTP multipart upload private download and denied download", async () => {
      const job = await call(`/api/v1/jobs/${options.fixture.jobId}`, "GET", headers(operator)); ensureCrmDemo(job.status === 200);
      const boundary = `synthetic-${options.fixture.fixtureId}`, bytes = `${options.fixture.marker}:http-attachment`;
      const payload = `--${boundary}\r\nContent-Disposition: form-data; name="expectedVersion"\r\n\r\n${String(object(job).version)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic-http.txt"\r\nContent-Type: text/plain\r\n\r\n${bytes}\r\n--${boundary}--\r\n`;
      const upload = await call(`/api/v1/leads/${options.fixture.jobId}/attachments`, "POST", { ...headers(operator), "content-type": `multipart/form-data; boundary=${boundary}` }, payload);
      ensureCrmDemo(upload.status === 200);
      const attachmentId = string(object(upload).id), file = await call(`/api/v1/attachments/${attachmentId}`, "GET", headers(operator));
      ensureCrmDemo(file.status === 200 && file.bytes.toString() === bytes && file.headers["cache-control"] === "private, no-store"
        && file.headers["content-security-policy"] === "sandbox; default-src 'none'");
      ensureCrmDemo((await call(`/api/v1/attachments/${attachmentId}`, "GET", headers(denied))).status === 404);
    });
    await check("HTTP both quotation templates generate authorized private PDFs", async () => {
      for (const taskId of [options.fixture.contractingTaskId, options.fixture.switchgearTaskId]) {
        const file = await call(`/api/v1/quotations/${taskId}/pdf`, "GET", headers(operator));
        ensureCrmDemo(file.status === 200 && file.headers["content-type"] === "application/pdf" && file.bytes.subarray(0, 8).toString() === "%PDF-1.7"
          && file.headers["cache-control"] === "private, no-store");
        ensureCrmDemo((await call(`/api/v1/quotations/${taskId}/pdf`, "GET", headers(denied))).status === 404);
      }
    });
    await check("HTTP relogin rotates the prior session and logout revokes the replacement", async () => {
      const rotated = await call("/api/v1/auth/login", "POST", headers(operator), JSON.stringify({ email: options.fixture.identities.operator.email, password: options.fixture.password }));
      ensureCrmDemo(rotated.status === 200);
      const fresh = { cookie: cookies(rotated), csrf: string(object(rotated).csrfToken) };
      ensureCrmDemo(fresh.cookie !== operator.cookie && (await call("/api/v1/auth/me", "GET", headers(operator))).status === 401);
      ensureCrmDemo((await call("/api/v1/auth/me", "GET", headers(fresh))).status === 200);
      ensureCrmDemo((await call("/api/v1/auth/logout", "POST", headers(fresh))).status === 200);
      ensureCrmDemo((await call("/api/v1/auth/me", "GET", headers(fresh))).status === 401);
      ensureCrmDemo((await call("/api/v1/auth/logout", "POST", headers(denied))).status === 200);
    });
    await verifyCrmDemoFixture(options.fixtureConnection, options.fixture);
  } catch { failed = true; }
  try { await lifecycle.stop(); } catch { failed = true; }
  try { await runtime.close(); } catch { failed = true; }
  if (failed) throw new CrmDemoCaseError();
  return passed;
}
