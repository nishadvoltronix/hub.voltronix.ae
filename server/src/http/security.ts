import type { RequestHandler } from "express";
import { SafeHttpError } from "./errors.js";

export const privateResponse: RequestHandler = (_request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  response.vary("Cookie");
  next();
};

/** Process-only liveness policy; protected routes get their own reviewed auth adapters. */
export function livenessRequest(appOrigin: string): RequestHandler {
  return (request, _response, next) => {
    const origin = request.get("origin");
    const site = request.get("sec-fetch-site");
    if ((origin !== undefined && origin !== appOrigin)
      || (site !== undefined && site !== "same-origin" && site !== "none")) {
      next(new SafeHttpError("forbidden")); return;
    }
    if (request.originalUrl.includes("?") || request.headers["transfer-encoding"] !== undefined
      || (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0")) {
      next(new SafeHttpError("badRequest")); return;
    }
    next();
  };
}
