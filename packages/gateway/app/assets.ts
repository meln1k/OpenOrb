import { createAssetServer } from "remix/assets";

const rootDir = Deno.realPathSync(new URL("../../../", import.meta.url));
const nodeEnv = Deno.env.get("NODE_ENV") ?? "development";
const isDevelopment = nodeEnv === "development";

export const assetServer = createAssetServer({
  basePath: "/assets",
  rootDir,
  mounts: {
    app: "packages/gateway/app",
    npm: "node_modules",
    protocol: "packages/protocol/src",
    result: "packages/result/src",
  },
  allowPackages: [
    "@pierre/diffs",
    "@remix-run/data-schema",
    "lucide",
    "marked",
  ],
  allowFiles: [
    "packages/gateway/app/**/public/**",
    "packages/gateway/app/routes.ts",
    "packages/protocol/src/browser-session-git-snapshot.ts",
    "packages/protocol/src/browser-session-events.ts",
    "packages/protocol/src/conversation-frame.ts",
    "packages/protocol/src/model-provider.ts",
    "packages/protocol/src/orb-size.ts",
    "packages/protocol/src/runner-api-limits.ts",
    "packages/protocol/src/thinking-level.ts",
    "packages/result/src/index.ts",
    "node_modules/.deno/@remix-run+data-schema@1.0.0/node_modules/@remix-run/data-schema/dist/**/*.js",
    "node_modules/.deno/remix@3.0.0/node_modules/remix/dist/data-schema.js",
    "node_modules/.deno/remix@3.0.0/node_modules/remix/dist/fetch-router/routes.js",
    "node_modules/.deno/remix@3.0.0/node_modules/remix/dist/multiple-import-maps-polyfill.js",
    "node_modules/.deno/remix@3.0.0/node_modules/remix/dist/{component.js,component/*.js}",
    "node_modules/.deno/@remix-run+fetch-router@1.0.0/node_modules/@remix-run/fetch-router/dist/**/*.js",
    "node_modules/.deno/@remix-run+multiple-import-maps-polyfill@1.0.0/node_modules/@remix-run/multiple-import-maps-polyfill/dist/**/*.js",
    "node_modules/.deno/@remix-run+route-pattern@1.0.0/node_modules/@remix-run/route-pattern/dist/**/*.js",
    "node_modules/.deno/@remix-run+component@1.0.0/node_modules/@remix-run/component/dist/**/*.js",
    "node_modules/.deno/@remix-run+ui@0.12.1/node_modules/@remix-run/ui/dist/**/*.js",
    "node_modules/.deno/es-module-lexer@2.3.2/node_modules/es-module-lexer/dist/lexer.js",
    "node_modules/.deno/@earendil-works+chord@1.0.0/node_modules/@earendil-works/chord/dist/delta/*.js",
    "node_modules/.deno/@earendil-works+chord@1.0.0/node_modules/@earendil-works/chord/dist/json.js",
  ],
  denyFiles: [
    "packages/gateway/app/**/*.test.*",
    "node_modules/.deno/remix@3.0.0/node_modules/remix/dist/component/{server,test}.js",
    "node_modules/.deno/@remix-run+component@1.0.0/node_modules/@remix-run/component/dist/{server/**,test.js}",
  ],
  scripts: {
    loaders: [
      (url, context, nextLoad) => {
        const loaded = nextLoad(url, context);
        if (!new URL(url).pathname.endsWith("/node_modules/lru_map/dist/lru.js")) return loaded;
        // Pierre's worker manager imports this UMD-only dependency as an ESM default.
        return {
          ...loaded,
          source: `${loaded.source}\nexport default globalThis.lru_map;`,
        };
      },
    ],
  },
  ...(isDevelopment ? { sourceMaps: "external" as const } : {}),
  minify: !isDevelopment,
  watch: false,
});

export const clientScriptEntry = await assetServer.getScriptEntry(
  "packages/gateway/app/public/client.ts",
);
