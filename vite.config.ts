import { defineConfig } from "vite-plus";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import openorb from "./scripts/lint-plugin.ts";

export default defineConfig({
  plugins: [
    {
      name: "durable-object-sql-migrations",
      async load(id) {
        if (!id.endsWith(".sql")) return;
        return `export default ${JSON.stringify(await readFile(id, "utf8"))};`;
      },
    },
  ],
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./packages/gateway/test/workspace/runtime.ts", import.meta.url),
      ),
    },
  },
  oxc: { jsx: { runtime: "automatic", importSource: "remix/component" } },
  test: {
    include: ["packages/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    env: { NODE_ENV: "test" },
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  fmt: {
    printWidth: 100,
    ignorePatterns: [
      ".agents/skills/**",
      "packages/gateway/.agents/**",
      "**/dist/**",
      "**/.celld/**",
      ".openorb-runner-dev/**",
      "packages/workspace/**",
      "packages/gateway/public/**",
      "packages/gateway/worker-configuration.d.ts",
      "packages/gateway/AGENTS.md",
      "packages/gateway/README.md",
      "AGENTS.md",
      "deno_migration.md",
      "MASTER_PLAN.md",
      "README.md",
      ".amp/**",
      "node_modules/**",
    ],
  },
  lint: {
    ignorePatterns: [
      ".agents/skills/**",
      "**/dist/**",
      "**/.celld/**",
      ".openorb-runner-dev/**",
      "packages/workspace/**",
      "scripts/anti-slop/**",
      "scripts/lint-rules/**",
      "scripts/lint-plugin.ts",
      "packages/gateway/worker-configuration.d.ts",
      ".amp/**",
    ],
    jsPlugins: [{ name: "openorb", specifier: "./scripts/lint-plugin.ts" }],
    rules: Object.fromEntries(
      Object.keys(openorb.rules).map((name) => [`openorb/${name}`, "error"]),
    ),
  },
});
