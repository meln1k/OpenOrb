import type { WorkspaceApi } from "@/app/cells/workspace/api.ts";
import { serveDir } from "@std/http/file-server";
import type { Cookie } from "remix/cookie";
import type { SessionStorage } from "remix/session";
import type { MediaReader, SessionDirectory } from "@/app/cells/session/api.ts";
import {
  type AppServices,
  createAppServices as createWorkspaceAppServices,
} from "@/app/middleware/services.ts";
import type { Runners } from "@/app/cells/runners/runner-registry-do.ts";
import { createGatewayAssets } from "@/app/assets.ts";
import {
  createAppRouter as createGatewayRouter,
  createSessionCookie as createGatewayCookie,
} from "@/app/router.ts";

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
  // deno-lint-ignore openorb/no-chained-type-assertions
  const stub = connections as unknown as AppServices["runnerConnections"];
  return createWorkspaceAppServices(workspace, stub, sessionStorage, {
    assets: createGatewayAssets({
      fetch: (request) =>
        serveDir(request, {
          fsRoot: new URL("../dist/assets/", import.meta.url).pathname,
          quiet: true,
        }),
    }),
    sessions,
    media,
  });
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
