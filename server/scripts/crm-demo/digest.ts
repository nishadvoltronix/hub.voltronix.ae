import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { assertOrdinaryPath } from "../mysql-auth/files.js";
import { CrmDemoRefusal } from "./guard.js";

export const crmDemoDigestPaths = Object.freeze([
  "server/src", "server/scripts", "server/tests", "server/assets",
  "src", "scripts", "tests", "resources/quotation-pdf", "package.json", "package-lock.json",
  "next.config.ts", "tsconfig.json", "tsconfig.server.json", "tsconfig.server.build.json", "tsconfig.demo.json", "eslint.config.mjs",
  "shared/contracts/src", "shared/contracts/package.json", "shared/contracts/tsconfig.json",
]);

/** Bind root UI, Express server, contracts and PDF assets to an approval. Fixed roots
 * only: no .env/private/operator/SQL/database/build/package-cache discovery.
 * Fingerprint remains private; this function never writes or logs it. */
export function crmDemoDigest(packageRoot: string): string {
  try {
    const workspace = resolve(packageRoot, ".."), digest = createHash("sha256");
    let total = 0, files = 0;
    const visit = (path: string) => {
      assertOrdinaryPath(workspace, path);
      const name = relative(workspace, path).replaceAll("\\", "/"), stat = lstatSync(path);
      if (name.split("/").some(part => part.startsWith(".") || ["node_modules", "backups"].includes(part))) throw new Error();
      if (stat.isDirectory()) { for (const child of readdirSync(path).sort()) visit(join(path, child)); return; }
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2_000_000 || ++files > 5_000
        || (total += stat.size) > 50_000_000 || !/\.(?:ts|tsx|mjs|js|json|css|md|txt|rst|ps1|svg|png|jpe?g|ttf|woff2?|ico)$/i.test(name)) throw new Error();
      digest.update(name + "\0").update(readFileSync(path)).update("\0");
    };
    for (const name of crmDemoDigestPaths) visit(join(workspace, name));
    return digest.digest("hex");
  } catch { throw new CrmDemoRefusal("OWNERSHIP"); }
}
