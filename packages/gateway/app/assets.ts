import manifest from "../dist/asset-manifest.json" with { type: "json" };
import type { ScriptEntry } from "remix/assets";

/** celld's assets.binding (ASSETS): no filesystem or compiler is needed in the Worker. */
export interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

interface AssetManifest {
  entries: Record<string, ScriptEntry>;
  hrefs: Record<string, string>;
  assetUrls: string[];
  publicFiles: string[];
}

const metadata: AssetManifest = manifest;
const assetUrls = new Set(metadata.assetUrls);
const publicFiles = new Set(metadata.publicFiles);

function sourceId(input: string): string {
  const path = input.startsWith("file:")
    ? decodeURIComponent(new URL(input).pathname)
    : input.split(/[?#]/, 1)[0]!;
  // Preserve source-based clientEntry IDs across checkout relocation. The server bundler must
  // retain each public module's import.meta.url as a distinct file: source ID, not the bundle URL.
  const index = path.indexOf("/packages/gateway/app/");
  return index === -1 ? path.replace(/^\.\//, "") : path.slice(index + 1);
}

function getEntry(input: string): ScriptEntry {
  const id = sourceId(input);
  const entry = (Object.hasOwn(metadata.entries, id) ? metadata.entries[id] : undefined) ??
    Object.values(metadata.entries).find((entry) => entry.href === input.split(/[?#]/, 1)[0]);
  if (!entry) throw new TypeError(`Browser entry was not built: ${input}`);
  return structuredClone(entry);
}

/**
 * Inject createGatewayAssets(env.ASSETS) into render({ assets }) and the assets controller.
 * Use fetchPublic(request) before app routing instead of filesystem-backed publicFiles middleware.
 * Configure celld assets.directory = "./dist/assets", binding = "ASSETS", html_handling = "none";
 * do not enable SPA/404-page fallbacks. Build assets before bundling the Worker.
 */
export function createGatewayAssets(binding?: AssetsBinding) {
  async function fetchBuilt(request: Request, allowed: Set<string>) {
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    if (!allowed.has(new URL(request.url).pathname)) return null;
    if (!binding) {
      throw new TypeError("The gateway requires the ASSETS binding to serve built assets");
    }
    // Pass the original request through: celld owns HEAD, ETag revalidation and byte ranges.
    const response = await binding.fetch(request);
    return response.status === 404 ? null : response;
  }

  return {
    getScriptEntry(input: string): Promise<ScriptEntry> {
      return Promise.resolve().then(() => getEntry(input));
    },
    getHref(input: string): Promise<string> {
      return Promise.resolve().then(() => {
        const id = sourceId(input);
        const href = Object.hasOwn(metadata.hrefs, id) ? metadata.hrefs[id] : undefined;
        if (!href) throw new TypeError(`Browser asset was not built: ${input}`);
        return href;
      });
    },
    getPreloads(input: string | readonly string[]): Promise<string[]> {
      return Promise.resolve().then(() => {
        const inputs = [input].flat();
        return [...new Set(inputs.flatMap((id) => getEntry(id).preloads))];
      });
    },
    fetch(request: Request): Promise<Response | null> {
      return fetchBuilt(request, assetUrls);
    },
    fetchPublic(request: Request): Promise<Response | null> {
      return fetchBuilt(request, publicFiles);
    },
  };
}

// Metadata resolution remains usable without a binding (e.g. Document and SSR).
// HTTP serving requires the explicitly injected instance above; never store env in a global.
export const assetServer = createGatewayAssets();
export const clientScriptEntry = getEntry("packages/gateway/app/public/client.ts");
export type GatewayAssets = ReturnType<typeof createGatewayAssets>;
