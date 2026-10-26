/** Explicit API selection. Never reads a profile, starts a server or chooses a database. */
export type FrontendBackend = { mode: "nextjs" } | { mode: "express"; origin: string; appOrigin: string; instanceId?: string };

function loopbackOrigin(url: URL): boolean {
  return url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname) && /^\d+$/.test(url.port)
    && Number(url.port) >= 1024 && Number(url.port) <= 65535;
}

/** The TLS terminator has an explicitly approved DNS host on the standard HTTPS
 * port. A browser/forwarded Host header can never change this server setting. */
function httpsOrigin(url: URL): boolean {
  const labels = url.hostname.split(".");
  return url.protocol === "https:" && url.port === "" && url.hostname.length <= 253 && labels.length >= 2
    && !url.hostname.endsWith(".localhost")
    && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    && !labels.every(label => /^\d+$/.test(label));
}

export function frontendBackend(environment: Record<string, string | undefined>): FrontendBackend {
  try {
    const mode = environment.CRM_FRONTEND_BACKEND;
    if (mode === undefined || mode === "nextjs") {
      // The retained direct-Next provider is test/development-only. A production
      // process or HTTPS deployment must never silently select a database fallback.
      if (environment.CRM_EXPRESS_ORIGIN !== undefined || environment.CRM_API_INSTANCE_ID !== undefined || environment.NODE_ENV === "production"
        || environment.APP_ORIGIN?.startsWith("https:")) throw new Error();
      return { mode: "nextjs" };
    }
    if (mode !== "express") throw new Error();
    const origin = environment.CRM_EXPRESS_ORIGIN, appOrigin = environment.APP_ORIGIN;
    const instanceId = environment.CRM_API_INSTANCE_ID;
    if (!origin || !appOrigin) throw new Error();
    const upstream = new URL(origin), app = new URL(appOrigin);
    for (const url of [upstream, app]) {
      if (url.username || url.password) throw new Error();
    }
    if (!loopbackOrigin(upstream) || (!(loopbackOrigin(app) && app.hostname === "127.0.0.1") && !httpsOrigin(app))) throw new Error();
    if (upstream.origin !== origin || app.origin !== appOrigin || origin === appOrigin) throw new Error();
    if (instanceId !== undefined && !/^[a-z][a-z0-9-]{0,63}$/.test(instanceId)) throw new Error();
    if (app.protocol === "https:" && instanceId === undefined) throw new Error();
    return { mode: "express", origin, appOrigin, ...(instanceId === undefined ? {} : { instanceId }) };
  } catch { throw new Error("Invalid frontend backend configuration."); }
}

export function requireNextDatabase(environment: Record<string, string | undefined>): void {
  if (frontendBackend(environment).mode !== "nextjs") throw new Error("Direct frontend database access is disabled.");
}
