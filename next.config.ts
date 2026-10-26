import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Next and the linked browser-safe contracts share this single project root.
  turbopack: { root: dirname(fileURLToPath(import.meta.url)) },
  transpilePackages: ["@voltronix/crm-contracts"],
  serverExternalPackages: ["mysql2", "pdfkit"],
  outputFileTracingIncludes: {
    "/api/quotations/*/pdf": ["./resources/quotation-pdf/**/*", "./node_modules/pdfkit/js/data/**/*"],
  },
  // Express is built separately. Private data, credentials and retained originals
  // are never included in the Next deployment traces.
  outputFileTracingExcludes: {
    "/*": ["./.local-data/**/*", "./.private/**/*", "./.env*", "./server/**/*",
      "./.local-dev/**/*", "./.private-legacy/**/*", "./nextjs/**/*", "./tools/**/*",
      "./frontend/**/*", "./backend/**/*", "./release/**/*", "./assets/**/*",
      "./application/**/*", "./system/**/*", "./vendor/**/*", "./include/**/*"],
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    }];
  },
};

export default config;
