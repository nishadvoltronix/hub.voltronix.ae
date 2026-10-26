import type { CommercialTransport } from "../../crm/commercial/transport.js";
import type { ZohoTransport } from "../../crm/lead-mutations/contracts.js";
import type { ZohoClientRequest } from "./client.js";

export interface VerifiedZohoRequestPort {
  request(input: ZohoClientRequest): Promise<{ status: number; body: unknown }>;
}

/** New lead adapter explicitly targets v8; commercial contracts retain their
 * individually declared v2.1/v8 versions. This bridge neither enables an API
 * runtime nor imports/synchronizes existing records. The supplied client owns
 * verified organization binding and the sandbox-only mutation boundary. */
export function createZohoTransports(client: VerifiedZohoRequestPort): { leads: ZohoTransport; commercial: CommercialTransport } {
  return {
    leads: { request: input => client.request({ apiVersion: "v8", method: input.method, path: input.path,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.ifUnmodifiedSince === undefined ? {} : { ifUnmodifiedSince: input.ifUnmodifiedSince }) }) },
    // Some source builders return local result hints alongside the HTTP DTO.
    // Project only the declared request; never transmit bookkeeping fields.
    commercial: { request: input => client.request({ apiVersion: input.apiVersion, method: input.method, path: input.path,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.ifUnmodifiedSince === undefined ? {} : { ifUnmodifiedSince: input.ifUnmodifiedSince }),
      ...(input.exactDecimalSerialization === undefined ? {} : { exactDecimalSerialization: input.exactDecimalSerialization }) }) },
  };
}
