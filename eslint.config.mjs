import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import next from "@next/eslint-plugin-next";
import ts from "typescript-eslint";
import hooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default defineConfig([
  globalIgnores(["node_modules/**", ".next/**", "dist/**", "out/**", "next-env.d.ts", "**/node_modules/**", "**/dist/**",
    ".private/**", ".private-legacy/**", ".local-data/**", ".local-dev/**", "**/.local-data/**", "release/**",
    "frontend/**", "backend/**", "nextjs/**", "assets/**", "public/**", "resources/**", "coverage/**", "test-results/**"]),
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.ts", "scripts/**/*.ts", "server/**/*.ts", "shared/contracts/src/**/*.ts", "next.config.ts"],
    extends: [js.configs.recommended, ts.configs.recommended],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "@next/next": next, "react-hooks": hooks },
    rules: {
      ...next.configs.recommended.rules,
      ...next.configs["core-web-vitals"].rules,
      ...hooks.configs.recommended.rules,
    },
  },
  {
    files: ["server/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-restricted-imports": ["error", { patterns: [
        { group: ["next", "next/*", "server-only", "better-sqlite3", "sqlite3", "mariadb", "@/server/*", "**/nextjs/**", "**/frontend/**", "**/src/server/**"],
          message: "Express cannot import Next, SQLite, MariaDB or frontend application sources." },
      ] }],
    },
  },
  // The explicit retained demo may reuse the frozen SQLite services; production
  // Express sources and scripts keep their established import restrictions.
  { files: ["server/demo-sqlite/**/*.ts"], rules: { "no-restricted-imports": "off" } },
]);
