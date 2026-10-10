import type { WorkspaceApi } from "@/app/cells/workspace/api.ts";
import { WorkspaceId } from "@openorb/protocol/runner-api";
import { Effect, Stream } from "effect";
import { serveDir } from "@std/http/file-server";
import type { Cookie } from "remix/cookie";
import type { SessionStorage } from "remix/session";
import {
  type AppServices,
  createAppServices as createWorkspaceAppServices,
} from "@/app/middleware/services.ts";
import type { Runners } from "@/app/cells/runners/runner-registry-do.ts";
import { createGatewayAssets } from "@/app/assets.ts";
import { createSessionEventStream } from "@/app/actions/api/sessions/session-event-stream.ts";
import type { RunnerRegistry } from "@/app/cells/runners/runner-registry.ts";
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

export type TestRunnerConnections =
  & Omit<Runners, "fetch" | "health" | "__DURABLE_OBJECT_BRAND">
  & Pick<RunnerRegistry, "watchSession">;

export function createAppServices(
  workspace: WorkspaceApi,
  connections: TestRunnerConnections = disconnectedRunnerRegistry,
  sessionStorage?: SessionStorage,
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
    sessionEvents: async (workspaceId, sessionId, request) => {
      const stream = await Effect.runPromise(
        createSessionEventStream(
          connections.watchSession(WorkspaceId.make(workspaceId), sessionId),
        ),
        { signal: request.signal },
      );
      return new Response(stream, {
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "Content-Type": "text/event-stream; charset=utf-8",
          "X-Accel-Buffering": "no",
        },
      });
    },
  });
}

export const disconnectedRunnerRegistry: TestRunnerConnections = {
  getRunnerLiveState: () => Promise.resolve(null),
  getSessionRunner: () => Promise.resolve(null),
  getSessionSnapshot: () => Promise.resolve(null),
  getSessionGitSnapshot: () =>
    Promise.resolve({ status: "unavailable", message: "Runner connections are unavailable." }),
  updateSessionGitFile: () =>
    Promise.resolve({ status: "unavailable", message: "Runner connections are unavailable." }),
  readSessionGitPatchChunk: () =>
    Promise.resolve({ status: "unavailable", message: "Runner connections are unavailable." }),
  readSessionArtifactChunk: () =>
    Promise.resolve({ status: "unavailable", message: "Runner connections are unavailable." }),
  provisionSession: () =>
    Promise.resolve({ status: "unavailable", message: "Runner connections are unavailable." }),
  wakeSession: () =>
    Promise.resolve({ status: "unavailable", message: "Runner connections are unavailable." }),
  promptSession: () =>
    Promise.resolve({ status: "unavailable", message: "Runner connections are unavailable." }),
  setSessionThinkingLevel: () =>
    Promise.resolve({ status: "unavailable", message: "Runner connections are unavailable." }),
  abortSession: () =>
    Promise.resolve({ status: "unavailable", message: "Runner connections are unavailable." }),
  stopSession: () =>
    Promise.resolve({ status: "unavailable", message: "Runner connections are unavailable." }),
  deleteSession: () => Promise.resolve(),
  watchSession: () => Stream.fail(new Error("Runner connections are unavailable.")),
  disconnectRunner: () => Promise.resolve(false),
};
