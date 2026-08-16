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
  },
  allowFiles: [
    "packages/control/app/assets/**",
    "packages/control/app/ui/components/**",
    "packages/control/app/ui/responsive.ts",
    "node_modules/.deno/lucide@1.31.0/node_modules/lucide/dist/esm/icons/*.mjs",
    "node_modules/.deno/remix@3.0.0-beta.6/node_modules/remix/dist/{ui.js,ui/*.js}",
    "node_modules/.deno/@remix-run+ui@0.5.0/node_modules/@remix-run/ui/dist/**/*.js",
  ],
  denyFiles: [
    "node_modules/.deno/remix@3.0.0-beta.6/node_modules/remix/dist/ui/{server,test}.js",
    "node_modules/.deno/@remix-run+ui@0.5.0/node_modules/@remix-run/ui/dist/{server/**,test.js}",
  ],
  sourceMaps: isDevelopment ? "external" : undefined,
  minify: !isDevelopment,
  watch: false,
});
