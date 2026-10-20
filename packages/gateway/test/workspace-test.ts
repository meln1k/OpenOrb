import type { WorkspaceApi } from "../app/cells/workspace/api.ts";
import { readFile, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Cookie } from "remix/cookie";
import type { SessionStorage } from "remix/session";
import type { MediaReader, SessionDirectory } from "../app/cells/session/api.ts";
import { Workspace } from "../app/cells/workspace/workspace.ts";
import { workspaceEventsFrom } from "../app/cells/workspace/events.ts";
import {
  type AppServices,
  createAppServices as createWorkspaceAppServices,
} from "../app/middleware/services.ts";
import type { Runners } from "../app/cells/runners/runner-registry-do.ts";
import { createGatewayAssets } from "../app/assets.ts";
import {
  createAppRouter as createGatewayRouter,
  createSessionCookie as createGatewayCookie,
} from "../app/router.ts";

export {
  activate,
  createWorkspace,
  MemoryStorage,
  TEST_MASTER_KEY_BYTES,
  TEST_MASTER_KEY_HEX,
} from "./workspace/storage.ts";

export function createSessionCookie(): Cookie {
  return createGatewayCookie({ secret: "test-only-session-secret" });
}

export function createAppRouter(services: AppServices, cookie = createSessionCookie()) {
  return createGatewayRouter(services, cookie);
}

export type TestRunnerConnections = Omit<
  Runners,
  | "fetch"
  | "health"
  | "__DURABLE_OBJECT_BRAND"
  // Environment procedures serve Session Durable Objects, not browser routes.
  | "getEnvironment"
  | "createEnvironment"
  | "controlEnvironment"
  | "attachEnvironment"
  | "deleteEnvironment"
>;

export function createAppServices(
  workspace: WorkspaceApi,
  connections: TestRunnerConnections = disconnectedRunnerRegistry,
  sessionStorage?: SessionStorage,
  sessions: SessionDirectory = missingSessions,
  media: MediaReader = missingMedia,
) {
  // SAFETY: route fixtures implement the command methods, not native stub metadata or pipelining.
  // oxlint-disable-next-line openorb/no-chained-type-assertions
  const stub = connections as unknown as AppServices["runnerConnections"];
  return createWorkspaceAppServices(workspace, stub, sessionStorage, {
    assets: createGatewayAssets({
      fetch: serveBuiltAsset,
    }),
    sessions,
    media,
    // An in-process Workspace serves its own streams; other fixtures have none.
    workspaceEvents:
      workspace instanceof Workspace
        ? workspaceEventsFrom(workspace)
        : () => Promise.resolve(new Response("Not found", { status: 404 })),
  });
}

async function serveBuiltAsset(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405 });
  }
  const root = fileURLToPath(new URL("../dist/assets/", import.meta.url));
  try {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const path = await realpath(resolve(root, `.${pathname}`));
    if (!path.startsWith(`${await realpath(root)}${sep}`)) {
      return new Response(null, { status: 404 });
    }
    const bytes = await readFile(path);
    const mime = new Map(
      Object.entries({
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".ts": "text/javascript",
        ".tsx": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".map": "application/json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".wasm": "application/wasm",
      }),
    );
    return new Response(request.method === "HEAD" ? null : bytes, {
      headers: { "Content-Type": mime.get(extname(path)) ?? "application/octet-stream" },
    });
  } catch (error) {
    if (
      error instanceof URIError ||
      (error instanceof Error &&
        "code" in error &&
        ["ENOENT", "ENOTDIR", "EISDIR"].includes(String(error.code)))
    ) {
      return new Response(null, { status: 404 });
    }
    throw error;
  }
}

/** No Session Durable Objects exist; every call fails like an unknown Session. */
export const missingSessions: SessionDirectory = () => {
  const missing = () => Promise.reject(new Error("Session not found."));
  return {
    create: missing,
    view: () => Promise.resolve(null),
    submit: missing,
    setThinkingLevel: missing,
    abort: missing,
    stop: missing,
    wake: missing,
    retry: missing,
    delete: () => Promise.resolve(),
    media: () => Promise.resolve(null),
    gitSnapshot: missing,
    gitPatchChunk: missing,
    updateGitFile: missing,
    events: () => Promise.resolve(new Response("Session not found.", { status: 404 })),
  };
};

export const missingMedia: MediaReader = { get: () => Promise.resolve(null) };

export const disconnectedRunnerRegistry: TestRunnerConnections = {
  getRunnerLiveState: () => Promise.resolve(null),
  disconnectRunner: () => Promise.resolve(false),
};
