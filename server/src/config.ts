import { validateZohoEnvironment } from "./runtime/environment-settings.js";

export interface ApiConfig {
  readonly environment: "development" | "test" | "production";
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly appOrigin: string;
  readonly instanceId?: string;
}

export class ConfigurationError extends Error {
  constructor() { super("Invalid local API configuration; no server was started."); }
}

/** Canonical public HTTPS origin, never a forwarded request/header value. */
export function isProductionOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && url.origin === origin && url.port === ""
      && url.hostname.length <= 253 && url.hostname.includes(".")
      && !/^[0-9.]+$/.test(url.hostname) && !url.hostname.endsWith(".localhost")
      && url.hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  } catch { return false; }
}

/** Only explicit process settings. Never read .env, profiles or credentials. */
export function loadConfig(environment: Readonly<Record<string, string | undefined>>): ApiConfig {
  try {
    validateZohoEnvironment(environment);
    const keys = new Set(["CRM_API_ENVIRONMENT", "CRM_API_HOST", "CRM_API_PORT", "CRM_API_INSTANCE_ID"]);
    if (Object.keys(environment).some(key => key.startsWith("CRM_API_") && !keys.has(key))) throw new Error();
    const mode = environment.CRM_API_ENVIRONMENT;
    if (mode !== "development" && mode !== "test" && mode !== "production") throw new Error();
    const host = environment.CRM_API_HOST;
    if (host !== "127.0.0.1" && host !== "::1") throw new Error();
    const instanceId = environment.CRM_API_INSTANCE_ID;
    if (instanceId !== undefined && !/^[a-z][a-z0-9-]{0,63}$/.test(instanceId)) throw new Error();
    const rawPort = environment.CRM_API_PORT;
    if (!rawPort || !/^[1-9][0-9]{3,4}$/.test(rawPort)) throw new Error();
    const port = Number(rawPort);
    if (port < 1024 || port > 65535) throw new Error();
    const origin = environment.APP_ORIGIN;
    if (!origin) throw new Error();
    if (mode === "production") {
      if (!isProductionOrigin(origin)) throw new Error();
    } else {
      if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$/.test(origin)) throw new Error();
      const url = new URL(origin);
      if (url.origin !== origin || Number(url.port) < 1024 || Number(url.port) > 65535) throw new Error();
    }
    return Object.freeze({ environment: mode, host, port, appOrigin: origin, ...(instanceId === undefined ? {} : { instanceId }) });
  } catch { throw new ConfigurationError(); }
}

/** Revalidate at the listener boundary; a TypeScript cast is not configuration validation. */
export function validateConfig(config: ApiConfig): ApiConfig {
  try {
    return loadConfig({ CRM_API_ENVIRONMENT: config.environment, CRM_API_HOST: config.host,
      CRM_API_PORT: String(config.port), APP_ORIGIN: config.appOrigin, CRM_API_INSTANCE_ID: config.instanceId });
  } catch { throw new ConfigurationError(); }
}
