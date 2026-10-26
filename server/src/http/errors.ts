import type { ErrorRequestHandler } from "express";
import type { ErrorResponse } from "@voltronix/crm-contracts";

const failures = {
  badRequest: { status: 400, message: "Invalid request." },
  forbidden: { status: 403, message: "Request not permitted." },
  notFound: { status: 404, message: "Not found." },
  methodNotAllowed: { status: 405, message: "Method not permitted." },
} as const;
const errorKinds = new WeakMap<Error, keyof typeof failures>();

export class SafeHttpError extends Error {
  constructor(kind: keyof typeof failures) {
    super(failures[kind].message);
    errorKinds.set(this, kind);
  }
}

/** Never use a driver/parser/error object's arbitrary message, status or body. */
export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  if (response.headersSent) { response.destroy(); return; }
  const kind = error instanceof Error ? errorKinds.get(error) : undefined;
  const status = kind === undefined ? 500 : failures[kind].status;
  const body: ErrorResponse = { error: kind === undefined ? "Request failed." : failures[kind].message };
  response.status(status).json(body);
};
