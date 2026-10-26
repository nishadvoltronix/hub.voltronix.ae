import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { checkServerIdentity, type TLSSocket } from "node:tls";
import { parseProbeConfig, type ProbeConfig, type ProbeTransport, type ProbeResponse } from "./http-probe";

export function assertApprovedAddresses(addresses: { address: string; family: number }[], approved: string[]) {
  if (!addresses.length || addresses.some((entry) => !approved.includes(entry.address) || ![4, 6].includes(entry.family))) throw new Error("Unapproved DNS result.");
}
/** Only the explicitly selected CLI execution mode constructs this network transport. */
export function approvedHttpsTransport(config: ProbeConfig): ProbeTransport {
  const origin = new URL(config.origin);
  return async (probe) => {
    parseProbeConfig(config);
    let dnsTimer: ReturnType<typeof setTimeout> | undefined;
    const addresses = await Promise.race([
      lookup(origin.hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => { dnsTimer = setTimeout(() => reject(new Error("DNS timeout.")), 10_000); }),
    ]).finally(() => clearTimeout(dnsTimer));
    assertApprovedAddresses(addresses, config.approvedAddresses);
    // Resolve once, then pin the socket to an approved address with original SNI/Host.
    // A changed or mixed DNS answer is refused. Node retains certificate validation.
    parseProbeConfig(config);
    const selected = addresses[0]!;
    return new Promise<ProbeResponse>((resolve, reject) => {
      const request = httpsRequest({
        hostname: selected.address, family: selected.family, port: Number(origin.port || 443),
        servername: origin.hostname, method: "GET", path: probe.path, agent: false,
        rejectUnauthorized: true, minVersion: "TLSv1.2", maxHeaderSize: 16_384,
        checkServerIdentity: (_hostname, certificate) => checkServerIdentity(origin.hostname, certificate),
        headers: { Host: origin.host, "User-Agent": "Voltronix-staging-readonly-probe/1", ...probe.headers },
      }, (response) => {
        clearTimeout(timer);
        const socket = response.socket as TLSSocket;
        // Do not follow redirects, consume bodies, retain cookies or print headers.
        const result = { status: response.statusCode ?? 0, headers: response.headers,
          tlsAuthorized: socket.authorized, tlsProtocol: socket.getProtocol() };
        response.destroy();
        resolve(result);
      });
      const timer = setTimeout(() => request.destroy(new Error("Request timeout.")), 10_000);
      request.once("error", () => { clearTimeout(timer); reject(new Error("HTTPS probe failed.")); });
      request.end();
    });
  };
}
