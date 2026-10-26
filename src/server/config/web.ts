export interface WebConfig {
  origin: string;
  secureCookies: boolean;
  sessionCookie: string;
  csrfCookie: string;
}

export function parseWebConfig(environment: Record<string, string | undefined>): WebConfig {
  try {
    const value = environment.APP_ORIGIN;
    if (!value) throw new Error();
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw new Error();
    const secureCookies = url.protocol === "https:";
    if (!secureCookies && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error();
    return {
      origin: url.origin, secureCookies,
      sessionCookie: secureCookies ? "__Host-crm_session" : "crm_session",
      csrfCookie: secureCookies ? "__Host-crm_csrf" : "crm_csrf",
    };
  } catch { throw new Error("Invalid APP_ORIGIN configuration."); }
}
