import { lstatSync, readFileSync } from "node:fs";
import { parseProbeConfig, probeConfigFingerprint, probeRequests, runHttpProbes } from "./staging/http-probe";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== "--config" || !["--validate-only", "--execute-approved-probes"].includes(args[2]!)) throw new Error();
  const stat = lstatSync(args[1]!);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32_768) throw new Error();
  const config = parseProbeConfig(JSON.parse(readFileSync(args[1]!, "utf8")));
  if (args[2] === "--validate-only") {
    console.log(JSON.stringify({ status: "CONFIG_VALID", plannedGetRequests: probeRequests(config).length,
      configSha256: probeConfigFingerprint(config), networkPerformed: false, approvalIndependentlyVerified: false,
      artifactIndependentlyVerified: false, stagingReady: false }, null, 2));
    return;
  }
  const { approvedHttpsTransport } = await import("./staging/https-transport");
  const result = await runHttpProbes(config, approvedHttpsTransport(config));
  console.log(JSON.stringify({ ...result, checkedAt: new Date().toISOString(), approvalIndependentlyVerified: false }, null, 2));
  if (result.status !== "PASS") process.exitCode = 1;
}
main().catch(() => {
  console.error("Staging probe refused or failed. Use --config <approved-private-json> with exactly --validate-only or --execute-approved-probes. No configuration values, headers or body contents were logged.");
  process.exitCode = 1;
});
