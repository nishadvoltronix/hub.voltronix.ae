import express from "express";
import helmet from "helmet";
import { API_IDENTITY_PATH, API_SERVICE_ID, LIVENESS_PATH, type ApiIdentityResponse, type LivenessResponse } from "@voltronix/crm-contracts";
import { validateConfig, type ApiConfig } from "./config.js";
import { errorHandler, SafeHttpError } from "./http/errors.js";
import { livenessRequest, privateResponse } from "./http/security.js";
import { createAuthRouter } from "./auth/http.js";
import type { AuthService } from "./auth/service.js";
import { createCrmRouter, createCrmRouterWithServices, type CrmServices } from "./crm/router.js";
import type { MysqlDatabase } from "./crm/db/mysql/database.js";
import type { ReadinessProbe } from "./runtime/readiness.js";

export interface AppDependencies { auth?: AuthService; crmDatabase?: MysqlDatabase; crmServices?: CrmServices; readiness?: ReadinessProbe }
export const READINESS_PATH = "/api/v1/health/ready";

/** Pure composition: no listener, database, profile, seed, worker or external transport. */
export function createApp(input: ApiConfig, dependencies: AppDependencies = {}) {
  const config = validateConfig(input);
  if (dependencies.crmDatabase && dependencies.crmServices) throw new Error("Select one explicit CRM composition.");
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  app.set("trust proxy", false);
  app.set("query parser", false);
  app.enable("strict routing");
  app.enable("case sensitive routing");
  app.use(privateResponse);
  app.use(helmet({
    // HTTPS terminates at the approved proxy. The policy follows trusted config,
    // never X-Forwarded-Proto; no includeSubDomains/preload claim is made.
    strictTransportSecurity: config.environment === "production" ? { maxAge: 31_536_000, includeSubDomains: false } : false,
    xFrameOptions: { action: "deny" },
    referrerPolicy: { policy: "no-referrer" },
    contentSecurityPolicy: { useDefaults: false, directives: {
      defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"],
    } },
  }));
  app.all(API_IDENTITY_PATH, (request, response, next) => {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      next(new SafeHttpError("methodNotAllowed")); return;
    }
    next();
  }, livenessRequest(config.appOrigin), (_request, response) => {
    if (config.instanceId === undefined) {
      response.status(503).json({ error: "The service is temporarily unavailable." }); return;
    }
    const body: ApiIdentityResponse = { service: API_SERVICE_ID, instanceId: config.instanceId, appOrigin: config.appOrigin };
    response.json(body);
  });
  app.all(LIVENESS_PATH, (request, response, next) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      next(new SafeHttpError("methodNotAllowed")); return;
    }
    next();
  }, livenessRequest(config.appOrigin), (_request, response) => {
    const body: LivenessResponse = { status: "running" };
    response.json(body);
  });
  app.all(READINESS_PATH, (request, response, next) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      next(new SafeHttpError("methodNotAllowed")); return;
    }
    next();
  }, livenessRequest(config.appOrigin), async (_request, response) => {
    let ready = false;
    try { ready = await dependencies.readiness?.() === true; } catch { /* Never expose dependency details. */ }
    response.status(ready ? 200 : 503).json({ status: ready ? "ready" : "unavailable" });
  });
  app.use(createAuthRouter(config.appOrigin, dependencies.auth));
  app.use(dependencies.crmServices ? createCrmRouterWithServices(config.appOrigin, dependencies.crmServices)
    : createCrmRouter(config.appOrigin, dependencies.crmDatabase));
  app.use((_request, _response, next) => next(new SafeHttpError("notFound")));
  app.use(errorHandler);
  return app;
}
