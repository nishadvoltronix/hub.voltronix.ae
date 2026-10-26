import { z } from "zod";
import { assertProductionZohoAuthority, type ProductionZohoAuthority } from "./production-policy.js";

const accountsOrigin = "https://accounts.zoho.com";
const origins = { production: "https://www.zohoapis.com", sandbox: "https://sandbox.zohoapis.com" } as const;
const modules = ["Accounts", "Contacts", "Deals", "Notes", "Products", "Quotes"] as const;
const remoteId = /^[1-9][0-9]{0,29}$/;
const apiField = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
const token = /^[A-Za-z0-9._~-]{1,4096}$/;
const maximumJsonBytes = 4 * 1024 * 1024;
const timeoutMs = 20_000;
const configSchema = z.object({ clientId: z.string().regex(token), clientSecret: z.string().regex(token),
  refreshToken: z.string().regex(token), environment: z.enum(["sandbox", "production"]),
  organizationId: z.string().regex(remoteId), allowWrites: z.boolean() }).strict();

export type ZohoClientConfig = z.infer<typeof configSchema>;
export interface ZohoClientDependencies { fetch?: typeof fetch; now?: () => number; networkEnabled?: boolean; productionAuthority?: ProductionZohoAuthority }
export interface ZohoClientRequest { apiVersion: "v2.1" | "v8"; method: "GET" | "POST" | "PUT"; path: string; body?: unknown;
  ifUnmodifiedSince?: string; ifModifiedSince?: string; exactDecimalSerialization?: "quote-v8" }
export interface ZohoOrganization { id: string; environment: "sandbox" | "production" }
export type ZohoClientErrorCode = "CONFIG_INVALID" | "NETWORK_DISABLED" | "CLOSED" | "REQUEST_INVALID" | "WRITE_DISABLED"
  | "TOKEN_REJECTED" | "ORGANIZATION_MISMATCH" | "HTTP_FAILED" | "RESPONSE_INVALID" | "RESPONSE_TOO_LARGE" | "TIMEOUT" | "UNAVAILABLE";

/** No underlying exception, provider body, URL, token or identifier is retained. */
export class ZohoClientError extends Error {
  readonly code: ZohoClientErrorCode;
  readonly httpStatus?: number;
  constructor(code: ZohoClientErrorCode, httpStatus?: number) {
    super(`Zoho client ${code}.`); this.name = "ZohoClientError"; this.code = code;
    if (httpStatus !== undefined && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) this.httpStatus = httpStatus;
  }
}
const failure = (error: unknown, fallback: ZohoClientErrorCode = "UNAVAILABLE") => error instanceof ZohoClientError ? error : new ZohoClientError(fallback);
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function containsControl(value: string): boolean { return Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127); }

/** Reusable by explicit setup boundaries. The caller owns the fetch deadline
 * and may supply its abort signal to cancel an active reader. Numbers
 * can retain their exact JSON lexemes (including exponents), never a rounded
 * JavaScript number. A missing Node 24 reviver context fails closed. */
export async function readBoundedZohoJson(response: Response, maxBytes: number, losslessNumbers: boolean, signal?: AbortSignal): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  function cancel() {
    try { if (reader) void reader.cancel().catch(() => {}); else if (response.body) void response.body.cancel().catch(() => {}); } catch { /* redacted cleanup */ }
  }
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > maximumJsonBytes || typeof losslessNumbers !== "boolean") throw new ZohoClientError("CONFIG_INVALID");
    if (signal?.aborted) throw new ZohoClientError("UNAVAILABLE");
    signal?.addEventListener("abort", cancel, { once: true });
    if (response.status === 204 && response.body === null) return undefined;
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || !response.body) throw new ZohoClientError("RESPONSE_INVALID");
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^(?:0|[1-9][0-9]{0,15})$/.test(declared) || Number(declared) > maxBytes)) throw new ZohoClientError("RESPONSE_TOO_LARGE");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const next = await reader.read();
      if (signal?.aborted) throw new ZohoClientError("UNAVAILABLE");
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new ZohoClientError("RESPONSE_TOO_LARGE");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    let nodes = 0;
    const parse = JSON.parse as (text: string, reviver: (key: string, value: unknown, context?: { source?: string }) => unknown) => unknown;
    return parse(source, (key, value, context) => {
      if (++nodes > 100_000 || ["__proto__", "prototype", "constructor"].includes(key)) throw new ZohoClientError("RESPONSE_INVALID");
      if (losslessNumbers && typeof value === "number") {
        if (!context?.source || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(context.source)) throw new ZohoClientError("RESPONSE_INVALID");
        return context.source;
      }
      return value;
    });
  } catch (error) {
    cancel();
    throw failure(error, "RESPONSE_INVALID");
  } finally { signal?.removeEventListener("abort", cancel); try { reader?.releaseLock(); } catch { /* redacted cleanup */ } }
}

function checkQuery(params: URLSearchParams, allowed: readonly string[]): void {
  for (const [key, value] of params) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1 || !value || containsControl(value)) throw new ZohoClientError("REQUEST_INVALID");
    if (key === "page" && (!/^[1-9][0-9]{0,6}$/.test(value) || Number(value) > 1_000_000)) throw new ZohoClientError("REQUEST_INVALID");
    if (key === "per_page" && (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 200)) throw new ZohoClientError("REQUEST_INVALID");
    if (key === "page_token" && (value.length > 4096 || params.has("page"))) throw new ZohoClientError("REQUEST_INVALID");
    if (key === "fields" && (value.split(",").length > 50 || value.split(",").some(field => !apiField.test(field)))) throw new ZohoClientError("REQUEST_INVALID");
    if (key === "sort_by" && !apiField.test(value)) throw new ZohoClientError("REQUEST_INVALID");
    if (key === "sort_order" && !["asc", "desc"].includes(value)) throw new ZohoClientError("REQUEST_INVALID");
  }
}

function checkBody(value: unknown, module: string, method: "POST" | "PUT", pathId?: string, exactDecimals = false): string {
  let nodes = 0;
  function walk(current: unknown, key: string, depth: number): void {
    if (++nodes > 25_000 || depth > 20) throw new ZohoClientError("REQUEST_INVALID");
    const identity = key === "id" || /_id$/i.test(key) || ["Owner", "Created_By", "Modified_By", "Parent_Id", "VZ_app_user"].includes(key)
      || (key === "Deal_Name" && module === "Quotes") || (key === "Account_Name" && ["Contacts", "Deals"].includes(module))
      || (key === "Contact_Name" && ["Deals", "Quotes"].includes(module)) || (key === "Product_Name" && module === "Quotes");
    if (identity) {
      const descriptor = object(current) ? Object.getOwnPropertyDescriptor(current, "id") : undefined;
      const identifier: unknown = object(current) ? descriptor && "value" in descriptor ? descriptor.value : undefined : current;
      if (typeof identifier !== "string" || !remoteId.test(identifier)) throw new ZohoClientError("REQUEST_INVALID");
    }
    if (current === null || typeof current === "boolean") return;
    if (typeof current === "string") { if (current.length > 100_000 || current.includes("\0")) throw new ZohoClientError("REQUEST_INVALID"); return; }
    if (typeof current === "number") { if (!Number.isFinite(current) || (Number.isInteger(current) && !Number.isSafeInteger(current))) throw new ZohoClientError("REQUEST_INVALID"); return; }
    if (Array.isArray(current)) {
      if (Object.getPrototypeOf(current) !== Array.prototype || current.length > 1000) throw new ZohoClientError("REQUEST_INVALID");
      for (let i = 0; i < current.length; i++) {
        const property = Object.getOwnPropertyDescriptor(current, String(i));
        if (!property || !("value" in property)) throw new ZohoClientError("REQUEST_INVALID");
        walk(property.value, "", depth + 1);
      }
      if (Reflect.ownKeys(current).length !== current.length + 1) throw new ZohoClientError("REQUEST_INVALID");
      return;
    }
    if (!object(current) || ![Object.prototype, null].includes(Object.getPrototypeOf(current))) throw new ZohoClientError("REQUEST_INVALID");
    for (const name of Reflect.ownKeys(current)) {
      if (typeof name !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]{0,99}$/.test(name) || ["__proto__", "constructor", "prototype"].includes(name)) throw new ZohoClientError("REQUEST_INVALID");
      const property = Object.getOwnPropertyDescriptor(current, name);
      if (!property || !("value" in property)) throw new ZohoClientError("REQUEST_INVALID");
      walk(property.value, name, depth + 1);
    }
  }
  walk(value, "", 0);
  if (!object(value) || Object.keys(value).some(key => !["data", "trigger", "skip_feature_execution"].includes(key)) || !Array.isArray(value.data)
    || value.data.length !== 1 || !object(value.data[0]) || !Object.keys(value.data[0]).length) throw new ZohoClientError("REQUEST_INVALID");
  if (value.trigger !== undefined && (!Array.isArray(value.trigger) || value.trigger.some(entry => !["workflow", "approval", "blueprint", "pathfinder", "orchestration"].includes(entry)))) throw new ZohoClientError("REQUEST_INVALID");
  if (value.skip_feature_execution !== undefined && JSON.stringify(value.skip_feature_execution) !== '[{"name":"cadences"}]') throw new ZohoClientError("REQUEST_INVALID");
  const row = value.data[0];
  if (method === "POST" && row.id !== undefined) throw new ZohoClientError("REQUEST_INVALID");
  if (method === "PUT" && (pathId ? row.id !== undefined && row.id !== pathId : typeof row.id !== "string" || !remoteId.test(row.id))) throw new ZohoClientError("REQUEST_INVALID");
  let wire: unknown = value;
  if (exactDecimals) {
    // Numeric JSON lexemes, never binary-float coercion or caller-supplied raw
    // JSON. Only the explicit v8 quotation contract opts into these fixed paths.
    const rawJSON = (JSON as unknown as { rawJSON?: (value: string) => unknown }).rawJSON;
    if (!rawJSON) throw new ZohoClientError("REQUEST_INVALID");
    const numbers = (source: Record<string, unknown>, keys: readonly string[]) => {
      const target = { ...source };
      for (const key of keys) if (Object.hasOwn(target, key)) {
        const current = target[key];
        if (typeof current !== "string" || !/^-?(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,9})?$/.test(current)) throw new ZohoClientError("REQUEST_INVALID");
        target[key] = rawJSON(current);
      }
      return target;
    };
    const quoted = numbers(row, ["Discount", "Tax", "Adjustment"]);
    if (Object.hasOwn(row, "Quoted_Items")) {
      if (!Array.isArray(row.Quoted_Items)) throw new ZohoClientError("REQUEST_INVALID");
      quoted.Quoted_Items = row.Quoted_Items.map(item => {
        if (!object(item)) throw new ZohoClientError("REQUEST_INVALID");
        return numbers(item, ["Quantity", "List_Price", "ItemDiscount"]);
      });
    }
    wire = { ...value, data: [quoted] };
  }
  const serialized = JSON.stringify(wire);
  if (Buffer.byteLength(serialized, "utf8") > maximumJsonBytes) throw new ZohoClientError("REQUEST_INVALID");
  return serialized;
}

function requestDetails(input: ZohoClientRequest): { suffix: string; method: "GET" | "POST" | "PUT"; body?: string; ifUnmodifiedSince?: string; ifModifiedSince?: string } {
  try {
    const value = z.object({ apiVersion: z.enum(["v2.1", "v8"]), method: z.enum(["GET", "POST", "PUT"]),
      path: z.string().min(1).max(8192), body: z.unknown().optional(),
      ifUnmodifiedSince: z.iso.datetime({ offset: true }).optional(), ifModifiedSince: z.iso.datetime({ offset: true }).optional(),
      exactDecimalSerialization: z.literal("quote-v8").optional() }).strict().parse(input);
    if (!value.path.startsWith("/") || value.path.startsWith("//") || /[\\# ]/.test(value.path) || containsControl(value.path)
      || /%(?![a-f0-9]{2})/i.test(value.path) || value.path.split("?").length > 2) throw new ZohoClientError("REQUEST_INVALID");
    const [pathname, search] = value.path.split("?");
    if (!pathname || pathname.includes("%")) throw new ZohoClientError("REQUEST_INVALID");
    const params = new URLSearchParams(search);
    if (value.ifModifiedSince !== undefined && (value.apiVersion !== "v8" || value.method !== "GET"
      || !/^\/(?:Products|Deals|Quotes|Notes|VZ_app_users)(?:\/deleted)?$/.test(pathname))) throw new ZohoClientError("REQUEST_INVALID");
    if (value.ifUnmodifiedSince !== undefined && (value.apiVersion !== "v8" || value.method !== "PUT"
      || !/^\/(?:Quotes|Deals|Notes|Products)\/[1-9][0-9]{0,29}$/.test(pathname) || search !== undefined)) throw new ZohoClientError("REQUEST_INVALID");
    if (value.exactDecimalSerialization !== undefined && (value.apiVersion !== "v8" || value.method === "GET"
      || !/^\/Quotes(?:\/[1-9][0-9]{0,29})?$/.test(pathname) || search !== undefined)) throw new ZohoClientError("REQUEST_INVALID");
    if (pathname === "/org" || pathname === "/org/taxes") {
      if (value.apiVersion !== "v8" || value.method !== "GET" || value.body !== undefined || search !== undefined) throw new ZohoClientError("REQUEST_INVALID");
    } else if (/^\/(?:Products|Deals|Quotes|VZ_app_users)\/deleted$/.test(pathname)) {
      if (value.apiVersion !== "v8" || value.method !== "GET" || value.body !== undefined) throw new ZohoClientError("REQUEST_INVALID");
      checkQuery(params, ["type", "page", "per_page"]);
      if (params.get("type") !== "all") throw new ZohoClientError("REQUEST_INVALID");
    } else if (pathname === "/VZ_app_users") {
      if (value.apiVersion !== "v8" || value.method !== "GET" || value.body !== undefined) throw new ZohoClientError("REQUEST_INVALID");
      checkQuery(params, ["fields", "page", "per_page", "page_token", "sort_by", "sort_order"]);
      const fields = params.get("fields")?.split(",");
      if (!fields?.length || fields.some(field => !["Name", "Created_Time", "Modified_Time", "Email", "user_status"].includes(field))) throw new ZohoClientError("REQUEST_INVALID");
    } else if (/^\/VZ_app_users\/[1-9][0-9]{0,29}$/.test(pathname)) {
      if (value.apiVersion !== "v8" || value.method !== "GET" || value.body !== undefined) throw new ZohoClientError("REQUEST_INVALID");
      checkQuery(params, ["fields"]);
      const fields = params.get("fields")?.split(",");
      if (params.size !== 1 || !fields?.length || fields.some(field => !["Name", "Modified_Time", "Email", "user_status"].includes(field))) throw new ZohoClientError("REQUEST_INVALID");
    } else if (pathname === "/settings/layouts" || pathname === "/settings/pipeline") {
      if (value.apiVersion !== "v8" || value.method !== "GET" || value.body !== undefined) throw new ZohoClientError("REQUEST_INVALID");
      checkQuery(params, pathname === "/settings/layouts" ? ["module"] : ["layout_id"]);
      if (params.size !== 1 || (pathname === "/settings/layouts" ? params.get("module") !== "Deals" : !remoteId.test(params.get("layout_id") ?? ""))) throw new ZohoClientError("REQUEST_INVALID");
    } else if (pathname === "/settings/fields" || pathname === "/users") {
      if (value.apiVersion !== "v8" || value.method !== "GET" || value.body !== undefined) throw new ZohoClientError("REQUEST_INVALID");
      checkQuery(params, pathname === "/users" ? ["type"] : ["module"]);
      if (params.size !== 1 || (pathname === "/users" ? params.get("type") !== "CurrentUser" : ![...modules, "Quoted_Items", "VZ_app_users"].some(module => module === params.get("module")))) throw new ZohoClientError("REQUEST_INVALID");
    } else {
      const route = /^\/(Accounts|Contacts|Deals|Notes|Products|Quotes)(?:\/(search|[1-9][0-9]{0,29}))?(?:\/(Notes))?$/.exec(pathname);
      if (!route || (route[3] && (route[1] !== "Deals" || !route[2] || !remoteId.test(route[2])))) throw new ZohoClientError("REQUEST_INVALID");
      const module = route[1]!, recordId = route[2] && remoteId.test(route[2]) ? route[2] : undefined;
      if (value.method === "GET") {
        if (value.body !== undefined) throw new ZohoClientError("REQUEST_INVALID");
        checkQuery(params, route[2] === "search" ? ["criteria", "page", "per_page", "fields"] : recordId && !route[3]
          ? ["fields"] : ["page", "per_page", "fields", "sort_by", "sort_order",
            ...(value.apiVersion === "v8" && !route[2] && ["Products", "Deals", "Notes", "Quotes"].includes(module) ? ["page_token"] : [])]);
        if (route[2] === "search") {
          const fields: Record<string, string> = { Accounts: "Account_Name", Contacts: "Last_Name", Products: "Product_Name", Deals: "Deal_Name", Quotes: "Subject", Notes: "Note_Title" };
          const criteria = params.get("criteria");
          if (!criteria || criteria.length > 512 || !criteria.startsWith(`(${fields[module]}:equals:`)
            || !/^\([A-Za-z_]+:equals:[^(),:\\]{1,200}\)$/.test(criteria)) throw new ZohoClientError("REQUEST_INVALID");
        }
      } else {
        if (params.size || search !== undefined || route[2] === "search" || (value.method === "POST" && recordId && !route[3])
          || (value.method === "PUT" && route[3])) throw new ZohoClientError("REQUEST_INVALID");
        return { suffix: `/crm/${value.apiVersion}${pathname}`, method: value.method,
          body: checkBody(value.body, module, value.method, recordId, value.exactDecimalSerialization === "quote-v8"),
          ...(value.ifUnmodifiedSince === undefined ? {} : { ifUnmodifiedSince: value.ifUnmodifiedSince }) };
      }
    }
    return { suffix: `/crm/${value.apiVersion}${pathname}${search === undefined ? "" : `?${params.toString()}`}`, method: value.method,
      ...(value.ifModifiedSince === undefined ? {} : { ifModifiedSince: value.ifModifiedSince }) };
  } catch (error) { throw failure(error, "REQUEST_INVALID"); }
}

/** Explicit construction is offline. Credentials are never read from .env;
 * production mutations require the separately verified, organization-bound profile.
 * Every token is bound to configured org id AND environment before use. */
export function createZohoClient(input: ZohoClientConfig, dependencies: ZohoClientDependencies = {}) {
  let config: ZohoClientConfig;
  try { config = configSchema.parse(input); } catch { throw new ZohoClientError("CONFIG_INVALID"); }
  if (!object(dependencies) || (dependencies.fetch !== undefined && typeof dependencies.fetch !== "function") || (dependencies.now !== undefined && typeof dependencies.now !== "function")
    || (dependencies.networkEnabled !== undefined && typeof dependencies.networkEnabled !== "boolean")) throw new ZohoClientError("CONFIG_INVALID");
  const environment = config.environment, organizationId = config.organizationId, allowWrites = config.allowWrites;
  let credentials: Pick<ZohoClientConfig, "clientId" | "clientSecret" | "refreshToken"> | undefined = { clientId: config.clientId, clientSecret: config.clientSecret, refreshToken: config.refreshToken };
  const fetcher = dependencies.fetch ?? fetch, clock = dependencies.now ?? Date.now, networkEnabled = dependencies.networkEnabled === true;
  let closed = false;
  const controllers = new Set<AbortController>();
  type Access = { value: string; expiresAt: number };
  let cached: Access | undefined, pending: Promise<Access> | undefined;
  function now() {
    try { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) throw new ZohoClientError("CONFIG_INVALID"); return value; }
    catch { throw new ZohoClientError("CONFIG_INVALID"); }
  }
  function active() {
    if (closed) throw new ZohoClientError("CLOSED");
    if (!networkEnabled) throw new ZohoClientError("NETWORK_DISABLED");
  }
  async function http(url: string, init: RequestInit, limit: number, lossless: boolean, tokenRequest = false, allowNotModified = false): Promise<{ status: number; body: unknown }> {
    active();
    const controller = new AbortController(); controllers.add(controller);
    let timedOut = false;
    const aborted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new ZohoClientError(closed ? "CLOSED" : timedOut ? "TIMEOUT" : "UNAVAILABLE")), { once: true }));
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      return await Promise.race([aborted, (async () => {
        const response = await fetcher(url, { ...init, redirect: "error", cache: "no-store", credentials: "omit", signal: controller.signal });
        if (controller.signal.aborted) {
          try { void response.body?.cancel().catch(() => {}); } catch { /* redacted cleanup */ }
          throw new ZohoClientError(closed ? "CLOSED" : "TIMEOUT");
        }
        if (response.status === 304 && allowNotModified && !response.redirected && response.body === null) return { status: 304, body: undefined };
        if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300 || response.redirected) {
          try { void response.body?.cancel().catch(() => {}); } catch { /* redacted cleanup */ }
          throw new ZohoClientError(tokenRequest ? "TOKEN_REJECTED" : "HTTP_FAILED", response.status);
        }
        return { status: response.status, body: await readBoundedZohoJson(response, limit, lossless, controller.signal) };
      })()]);
    } catch (error) { throw failure(error); }
    finally { if (timer) clearTimeout(timer); controllers.delete(controller); }
  }
  async function access(): Promise<Access> {
    active();
    if (cached && now() < cached.expiresAt) return cached;
    if (pending) return pending;
    const work = (async () => {
      if (!credentials) throw new ZohoClientError("CLOSED");
      const started = now();
      const reply = await http(`${accountsOrigin}/oauth/v2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret, refresh_token: credentials.refreshToken, grant_type: "refresh_token" }) }, 65_536, false, true);
      const body = reply.body;
      if (!object(body) || body.error || typeof body.access_token !== "string" || !token.test(body.access_token)
        || ![origins.production, origins.sandbox].includes(body.api_domain as typeof origins.production)
        || body.token_type !== "Bearer" || typeof body.expires_in !== "number" || !Number.isInteger(body.expires_in)
        || body.expires_in < 1 || body.expires_in > 3600) throw new ZohoClientError("TOKEN_REJECTED");
      const expiry = started + body.expires_in * 1000 - Math.min(30_000, body.expires_in * 100);
      const candidate = { value: body.access_token, expiresAt: expiry };
      const organization = await http(`${origins[environment]}/crm/v8/org`, { method: "GET", headers: { Authorization: `Zoho-oauthtoken ${candidate.value}` } }, 262_144, true);
      if (!object(organization.body) || organization.body.error !== undefined || organization.body.code !== undefined
        || !Array.isArray(organization.body.org) || organization.body.org.length !== 1
        || !object(organization.body.org[0]) || organization.body.org[0].id !== organizationId || organization.body.org[0].type !== environment) throw new ZohoClientError("ORGANIZATION_MISMATCH");
      active();
      if (now() >= expiry) throw new ZohoClientError("TOKEN_REJECTED");
      cached = candidate; return candidate;
    })();
    pending = work;
    try { return await work; } finally { if (pending === work) pending = undefined; }
  }
  return {
    async request(input: ZohoClientRequest): Promise<{ status: number; body: unknown }> {
      let details = requestDetails(input);
      active();
      if (details.method !== "GET") {
        if (!allowWrites) throw new ZohoClientError("WRITE_DISABLED");
        if (environment === "production") {
          try { assertProductionZohoAuthority(dependencies.productionAuthority, organizationId); }
          catch { throw new ZohoClientError("WRITE_DISABLED"); }
          if (input.apiVersion !== "v8" || !object(input.body)
            || (input.body.trigger !== undefined && JSON.stringify(input.body.trigger) !== "[]")) throw new ZohoClientError("REQUEST_INVALID");
          details = requestDetails({ ...input, body: { ...input.body, trigger: [], skip_feature_execution: [{ name: "cadences" }] } });
        }
      }
      const current = await access();
      active();
      if (cached !== current || now() >= current.expiresAt) throw new ZohoClientError("TOKEN_REJECTED");
      try {
        return await http(origins[environment] + details.suffix, { method: details.method,
          headers: { Authorization: `Zoho-oauthtoken ${current.value}`, ...(details.body === undefined ? {} : { "Content-Type": "application/json" }),
            ...(details.ifUnmodifiedSince === undefined ? {} : { "If-Unmodified-Since": details.ifUnmodifiedSince }),
            ...(details.ifModifiedSince === undefined ? {} : { "If-Modified-Since": details.ifModifiedSince }) },
          ...(details.body === undefined ? {} : { body: details.body }) }, maximumJsonBytes, true, false, details.ifModifiedSince !== undefined);
      } catch (error) {
        if (error instanceof ZohoClientError && error.httpStatus === 401 && cached === current) cached = undefined;
        throw failure(error);
      }
    },
    async verifyOrganization(): Promise<ZohoOrganization> { await access(); return { id: organizationId, environment }; },
    close(): void { closed = true; cached = undefined; credentials = undefined; for (const controller of controllers) controller.abort(); },
  };
}
