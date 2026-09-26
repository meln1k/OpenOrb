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
  allowPackages: ["@pierre/diffs"],
  allowFiles: [
    "packages/gateway/app/assets/**",
    "packages/gateway/app/ui/components/**",
    "packages/gateway/app/ui/responsive.ts",
    "packages/gateway/app/ui/session-composer.tsx",
    "packages/gateway/app/ui/session-thinking-level.ts",
    "packages/gateway/app/ui/session/session-action-response.ts",
    "packages/gateway/app/ui/session/session-change-files.tsx",
    "packages/gateway/app/ui/session/session-change-items.ts",
    "packages/gateway/app/ui/session/session-composer-behavior.tsx",
    "packages/gateway/app/ui/session/session-model-picker.tsx",
    "packages/gateway/app/ui/session/session-selector-styles.ts",
    "packages/gateway/app/ui/session/session-changes-panel.tsx",
    "packages/gateway/app/ui/session/session-changes-resource.tsx",
    "packages/gateway/app/ui/session/session-detail-client.tsx",
    "packages/gateway/app/ui/session/session-failure-notices.tsx",
    "packages/gateway/app/ui/session/session-markdown.tsx",
    "packages/gateway/app/ui/session/session-page-controller.tsx",
    "packages/gateway/app/ui/session/session-thinking-level-controller.ts",
    "packages/gateway/app/ui/session/session-transcript.tsx",
    "packages/gateway/app/ui/session/session-transcript-state.ts",
    "packages/gateway/app/ui/session/session-vm-control.tsx",
    "packages/gateway/app/ui/session/session-vm-state.ts",
    "packages/gateway/app/ui/settings/model-providers.tsx",
    "packages/gateway/app/ui/settings/settings-shared.ts",
    "packages/gateway/app/ui/shell.tsx",
    "packages/gateway/app/routes.ts",
    "packages/protocol/src/browser-session-git-snapshot.ts",
    "packages/protocol/src/browser-session-events.ts",
    "packages/protocol/src/model-provider.ts",
    "packages/protocol/src/orb-size.ts",
    "packages/protocol/src/runner-api-limits.ts",
    "packages/protocol/src/thinking-level.ts",
    "packages/result/src/index.ts",
    "node_modules/.deno/@remix-run+data-schema@0.3.0/node_modules/@remix-run/data-schema/dist/**/*.js",
    "node_modules/.deno/@remix-run+data-schema@0.3.1/node_modules/@remix-run/data-schema/dist/**/*.js",
    "node_modules/.deno/lucide@1.31.0/node_modules/lucide/dist/esm/icons/*.mjs",
    "node_modules/.deno/marked@18.0.5/node_modules/marked/lib/marked.esm.js",
    "node_modules/.deno/remix@3.0.0-rc.3/node_modules/remix/dist/data-schema.js",
    "node_modules/.deno/remix@3.0.0-rc.3/node_modules/remix/dist/fetch-router/routes.js",
    "node_modules/.deno/remix@3.0.0-rc.3/node_modules/remix/dist/multiple-import-maps-polyfill.js",
    "node_modules/.deno/remix@3.0.0-rc.3/node_modules/remix/dist/{ui.js,ui/*.js}",
    "node_modules/.deno/remix@3.0.0-rc.3/node_modules/remix/dist/ui/combobox/primitives.js",
    "node_modules/.deno/remix@3.0.0-rc.3/node_modules/remix/dist/ui/select/primitives.js",
    "node_modules/.deno/@remix-run+fetch-router@0.22.1/node_modules/@remix-run/fetch-router/dist/**/*.js",
    "node_modules/.deno/@remix-run+multiple-import-maps-polyfill@0.1.0/node_modules/@remix-run/multiple-import-maps-polyfill/dist/**/*.js",
    "node_modules/.deno/@remix-run+route-pattern@0.24.1/node_modules/@remix-run/route-pattern/dist/**/*.js",
    "node_modules/.deno/@remix-run+ui@0.10.0/node_modules/@remix-run/ui/dist/**/*.js",
    "node_modules/.deno/es-module-lexer@2.3.2/node_modules/es-module-lexer/dist/lexer.js",
  ],
  denyFiles: [
    "node_modules/.deno/remix@3.0.0-rc.3/node_modules/remix/dist/ui/{server,test}.js",
    "node_modules/.deno/@remix-run+ui@0.10.0/node_modules/@remix-run/ui/dist/{server/**,test.js}",
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
  "packages/gateway/app/assets/client.ts",
);
