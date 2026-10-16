import { createAssetServer } from "remix/assets";
import type { ScriptEntry } from "remix/assets";
import { dirname, join, relative } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";
import { realpathSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";

const rootDir = realpathSync(new URL("../../", import.meta.url));

export function createBuildAssetServer(development = false) {
  return createAssetServer({
    basePath: "/assets",
    rootDir,
    mounts: {
      app: "packages/gateway/app",
      npm: "node_modules",
      gatewayNpm: "packages/gateway/node_modules",
      protocol: "packages/protocol/src",
      result: "packages/result/src",
    },
    allowPackages: ["@pierre/diffs", "@remix-run/data-schema", "lucide", "marked"],
    allowFiles: [
      "packages/gateway/app/**/public/**",
      "packages/gateway/app/routes.ts",
      "packages/protocol/src/model-provider.ts",
      "packages/protocol/src/orb-size.ts",
      "packages/protocol/src/thinking-level.ts",
      "packages/result/src/index.ts",
      "**/node_modules/@remix-run/data-schema/dist/**/*.js",
      "**/node_modules/remix/dist/data-schema.js",
      "**/node_modules/remix/dist/fetch-router/routes.js",
      "**/node_modules/remix/dist/multiple-import-maps-polyfill.js",
      "**/node_modules/remix/dist/{component.js,component/*.js}",
      "**/node_modules/@remix-run/fetch-router/dist/**/*.js",
      "**/node_modules/@remix-run/multiple-import-maps-polyfill/dist/**/*.js",
      "**/node_modules/@remix-run/route-pattern/dist/**/*.js",
      "**/node_modules/@remix-run/component/dist/**/*.js",
      "**/node_modules/@remix-run/ui/dist/**/*.js",
      "**/node_modules/es-module-lexer/dist/lexer.js",
      "**/node_modules/@earendil-works/chord/dist/delta/*.js",
      "**/node_modules/@earendil-works/chord/dist/json.js",
    ],
    denyFiles: [
      "packages/gateway/app/**/*.test.*",
      "**/node_modules/remix/dist/component/{server,test}.js",
      "**/node_modules/@remix-run/component/dist/{server/**,test.js}",
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
    ...(development ? { sourceMaps: "external" as const } : {}),
    minify: !development,
    watch: false,
  });
}

// Remix 3.0.0 exposes inspection, compilation/fetch and graph metadata, but no disk export API.
// Export its responses rather than introducing a second compiler or dependency resolver.
export async function buildGatewayAssets(
  outputDir = fromFileUrl(new URL("./dist/", import.meta.url)),
  development = false,
) {
  const server = createBuildAssetServer(development);
  const directory = join(outputDir, "assets");
  const entries: Record<string, ScriptEntry> = {};
  const hrefs: Record<string, string> = {};
  const urls = new Set<string>();
  const publicFiles: string[] = [];
  const styleUrls: string[] = [];

  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => server.close());
  // Every colocated browser script is a root: SSR client entries are not necessarily reachable
  // from client.ts. Inspection applies the same allow/deny policy as compilation.
  const assets = await server.getAssets();
  for (const asset of assets) {
    if (!asset.filePath?.startsWith(join(rootDir, "packages/gateway/app/"))) continue;
    if (!asset.url || asset.filePath.endsWith(".d.ts")) continue;
    const id = relative(rootDir, asset.filePath);
    hrefs[id] = await server.getHref(asset.filePath);
    urls.add(hrefs[id]);
    if (asset.type === "style") styleUrls.push(hrefs[id]);
    if (asset.type !== "script") continue;
    entries[id] = await server.getScriptEntry(asset.filePath);
  }

  // new Worker(new URL(..., import.meta.resolve(...))) is outside Remix's import graph.
  // Pierre's portable bundle also has hashed dynamic wasm chunks. Export those as roots, since
  // Remix's optimized import map for this self-contained bundle does not list the chunks.
  const workerAssets = assets.filter(
    (asset) =>
      asset.filePath?.includes("/node_modules/@pierre/diffs/dist/worker/") &&
      /\/(?:worker-portable|wasm-[^/]+)\.js$/.test(asset.filePath),
  );
  if (!workerAssets.some((asset) => asset.filePath?.endsWith("/worker-portable.js"))) {
    throw new Error("Pierre portable worker is not browser-reachable");
  }
  const workerEntries: ScriptEntry[] = [];
  for (const asset of workerAssets) {
    const entry = await server.getScriptEntry(asset.filePath!);
    workerEntries.push(entry);
    urls.add(entry.href);
  }

  // Import maps include literal dynamic imports (Shiki grammars/themes/wasm, `import("@pierre/diffs")`),
  // unlike preloads. A dynamically imported script is a root too: its static graph is not preloaded.
  const scriptsByHref = new Map(
    assets.flatMap((asset) =>
      asset.type === "script" && asset.url && asset.filePath ? [[asset.url, asset.filePath]] : [],
    ),
  );
  const pending = [...Object.values(entries), ...workerEntries];
  const visited = new Set(pending.map((entry) => entry.href));
  for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
    for (const href of entry.preloads) urls.add(href);
    const mapped = [
      ...Object.values(entry.importMap.imports),
      ...Object.values(entry.importMap.scopes ?? {}).flatMap((scope) => Object.values(scope)),
    ];
    for (const href of mapped) {
      urls.add(href);
      const filePath = scriptsByHref.get(href);
      if (filePath === undefined || visited.has(href)) continue;
      visited.add(href);
      pending.push(await server.getScriptEntry(filePath));
    }
  }

  // This directory is dedicated to deployable public bytes; metadata stays outside it.
  await mkdir(outputDir, { recursive: true });
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  for (const href of [...urls].sort()) {
    const response = await server.fetch(new Request(new URL(href, "http://assets.build")));
    if (!response?.ok) throw new Error(`Asset export failed: ${href} (${response?.status})`);
    if (response.headers.get("Content-Type")?.startsWith("text/css") && !styleUrls.includes(href)) {
      styleUrls.push(href);
    }
    const destination = join(directory, decodeURIComponent(href));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
    if (development) {
      const map = await server.fetch(new Request(new URL(`${href}.map`, "http://assets.build")));
      if (map?.ok) {
        await writeFile(`${destination}.map`, new Uint8Array(await map.arrayBuffer()));
        urls.add(`${href}.map`);
      }
    }
  }

  const copyPublic = async (source: string, prefix = "") => {
    for (const file of await readdir(source, { withFileTypes: true })) {
      const path = `${prefix}/${file.name}`;
      if (file.isDirectory()) {
        await copyPublic(join(source, file.name), path);
      } else if (file.isFile()) {
        if (path.startsWith("/assets/") || path === "/_headers" || path === "/_redirects") {
          throw new Error(`Static public file collides with the compiled asset namespace: ${path}`);
        }
        const destination = join(directory, path);
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(join(source, file.name), destination);
        publicFiles.push(path);
      } else {
        throw new Error(`Static public files must be regular files: ${path}`);
      }
    }
  };
  await copyPublic(join(rootDir, "packages/gateway/public"));

  // celld does not infer JavaScript MIME for .ts/.tsx. Worker and direct asset routes both
  // consume _headers, so browser entry URLs can retain their original extensions.
  await writeFile(
    join(directory, "_headers"),
    `/assets/*\n  Content-Type: text/javascript; charset=utf-8\n  Cache-Control: no-cache\n  X-Content-Type-Options: nosniff\n` +
      (development ? `/assets/*.map\n  Content-Type: application/json\n` : "") +
      styleUrls
        .sort()
        .map((href) => `${href}\n  Content-Type: text/css; charset=utf-8\n`)
        .join(""),
  );
  const metadata = {
    entries,
    hrefs,
    assetUrls: [...urls].sort(),
    publicFiles: publicFiles.sort(),
  };
  await writeFile(join(outputDir, "asset-manifest.json"), JSON.stringify(metadata));
  return metadata;
}

if (import.meta.main) {
  const metadata = await buildGatewayAssets(undefined, process.argv.includes("--development"));
  console.log(
    `Exported ${metadata.assetUrls.length} browser assets and ${metadata.publicFiles.length} public files`,
  );
}
