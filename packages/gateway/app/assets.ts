import { createAssetServer } from "remix/assets";

const rootDir = Deno.realPathSync(new URL("../../../", import.meta.url));
const nodeEnv = Deno.env.get("NODE_ENV") ?? "development";
const isDevelopment = nodeEnv === "development";

export const assetServer = createAssetServer({
  basePath: "/assets",
  rootDir,
  fileMap: {
    "app/*path": "packages/gateway/app/*path",
    "npm/*path": "node_modules/*path",
    "protocol/*path": "packages/protocol/src/*path",
    "result/*path": "packages/result/src/*path",
  },
  allowPackages: ["@pierre/diffs"],
  allowFiles: [
    "packages/gateway/app/assets/**",
    "packages/gateway/app/ui/components/**",
    "packages/gateway/app/ui/responsive.ts",
    "packages/gateway/app/ui/session/session-change-files.tsx",
    "packages/gateway/app/ui/session/session-change-items.ts",
    "packages/gateway/app/ui/session/session-composer-behavior.tsx",
    "packages/gateway/app/ui/session/session-changes-panel.tsx",
    "packages/gateway/app/ui/session/session-event-view.tsx",
    "packages/gateway/app/ui/session/session-markdown.tsx",
    "packages/gateway/app/ui/session/session-transcript-state.ts",
    "packages/protocol/src/browser-session-git-snapshot.ts",
    "packages/protocol/src/browser-session-events.ts",
    "packages/protocol/src/runner-api-limits.ts",
    "packages/result/src/index.ts",
    "node_modules/.deno/@remix-run+data-schema@0.3.0/node_modules/@remix-run/data-schema/dist/**/*.js",
    "node_modules/.deno/lucide@1.31.0/node_modules/lucide/dist/esm/icons/*.mjs",
    "node_modules/.deno/marked@18.0.5/node_modules/marked/lib/marked.esm.js",
    "node_modules/.deno/remix@3.0.0-beta.10/node_modules/remix/dist/data-schema.js",
    "node_modules/.deno/remix@3.0.0-beta.10/node_modules/remix/dist/{ui.js,ui/*.js}",
    "node_modules/.deno/@remix-run+ui@0.7.0/node_modules/@remix-run/ui/dist/**/*.js",
  ],
  denyFiles: [
    "node_modules/.deno/remix@3.0.0-beta.10/node_modules/remix/dist/ui/{server,test}.js",
    "node_modules/.deno/@remix-run+ui@0.7.0/node_modules/@remix-run/ui/dist/{server/**,test.js}",
  ],
  ...(isDevelopment ? { sourceMaps: "external" as const } : {}),
  minify: !isDevelopment,
  watch: false,
});
