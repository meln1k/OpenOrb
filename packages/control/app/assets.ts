import { createAssetServer } from "remix/assets";

const rootDir = Deno.realPathSync(new URL("../../../", import.meta.url));
const nodeEnv = Deno.env.get("NODE_ENV") ?? "development";
const isDevelopment = nodeEnv === "development";

export const assetServer = createAssetServer({
  basePath: "/assets",
  rootDir,
  fileMap: {
    "app/*path": "packages/control/app/*path",
    "npm/*path": "node_modules/*path",
    "protocol/*path": "packages/protocol/src/*path",
    "result/*path": "packages/result/src/*path",
  },
  allowFiles: [
    "packages/control/app/actions/settings/{git-author,github-credential,provider-secrets,runners,settings-shared,settings-tabs}.{ts,tsx}",
    "packages/control/app/assets/**",
    "packages/control/app/ui/components/**",
    "packages/control/app/ui/responsive.ts",
    "packages/protocol/src/runner-session-events.ts",
    "packages/result/src/index.ts",
    "node_modules/.deno/@remix-run+data-schema@0.3.0/node_modules/@remix-run/data-schema/dist/**/*.js",
    "node_modules/.deno/lucide@1.31.0/node_modules/lucide/dist/esm/icons/*.mjs",
    "node_modules/.deno/remix@3.0.0-beta.10/node_modules/remix/dist/data-schema.js",
    "node_modules/.deno/remix@3.0.0-beta.10/node_modules/remix/dist/{ui.js,ui/*.js}",
    "node_modules/.deno/@remix-run+ui@0.7.0/node_modules/@remix-run/ui/dist/**/*.js",
  ],
  denyFiles: [
    "node_modules/.deno/remix@3.0.0-beta.10/node_modules/remix/dist/ui/{server,test}.js",
    "node_modules/.deno/@remix-run+ui@0.7.0/node_modules/@remix-run/ui/dist/{server/**,test.js}",
  ],
  sourceMaps: isDevelopment ? "external" : undefined,
  minify: !isDevelopment,
  watch: false,
});
