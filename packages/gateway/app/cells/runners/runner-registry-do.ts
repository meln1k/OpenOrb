import { DurableObject } from "cloudflare:workers";
import type { DurableObjectState } from "@cloudflare/workers-types";
import { Effect, ManagedRuntime, Schema, Scope } from "effect";
import * as Socket from "effect/socket/Socket";
import type { Env } from "../../env.ts";
import type { WorkspaceApi } from "../workspace/api.ts";
import { RunnerRegistry as Registry, runnerRegistryLayer } from "./runner-registry.ts";
import type {
  AbortSessionInput,
  DeleteSessionInput,
  PromptSessionInput,
  ProvisionSessionInput,
  ReadSessionArtifactChunkInput,
  ReadSessionGitPatchChunkInput,
  SetSessionThinkingLevelInput,
  StopSessionInput,
  UpdateSessionGitFileInput,
  WakeSessionInput,
} from "./runner-registry.ts";
import { WorkspaceId } from "@openorb/protocol/runner-api";
import { createSessionEventStream } from "../../actions/api/sessions/session-event-stream.ts";

export class Runners extends DurableObject<Env> {
  readonly #runtime;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // SAFETY: native RPC implements WorkspaceApi; platform thenables differ only in checker types.
    // deno-lint-ignore openorb/no-chained-type-assertions
    const workspace = env.WORKSPACE.getByName("workspace") as unknown as WorkspaceApi;
    this.#runtime = ManagedRuntime.make(runnerRegistryLayer(workspace));
  }

  async #run<A>(operation: Effect.Effect<A, never, Registry>): Promise<A> {
    const result = await this.#runtime.runPromise(operation);
    // Native RPC needs plain records, including Schema.Class values and bulk Uint8Arrays.
    return structuredClone(result);
  }

  health() {
    return this.#runtime.runPromise(Effect.void);
  }
  getRunnerLiveState(id: WorkspaceId, runner: string) {
    return this.#run(Effect.flatMap(Registry, (r) => r.getRunnerLiveState(id, runner)));
  }
  getSessionRunner(id: WorkspaceId, session: string) {
    return this.#run(Effect.flatMap(Registry, (r) => r.getSessionRunner(id, session)));
  }
  getSessionSnapshot(id: WorkspaceId, session: string) {
    return this.#run(Effect.flatMap(Registry, (r) => r.getSessionSnapshot(id, session)));
  }
  getSessionGitSnapshot(id: WorkspaceId, session: string) {
    return this.#run(Effect.flatMap(Registry, (r) => r.getSessionGitSnapshot(id, session)));
  }
  provisionSession(input: ProvisionSessionInput) {
    return this.#run(Effect.flatMap(Registry, (r) => r.provisionSession(input)));
  }
  promptSession(input: PromptSessionInput) {
    return this.#run(Effect.flatMap(Registry, (r) => r.promptSession(input)));
  }
  wakeSession(input: WakeSessionInput) {
    return this.#run(Effect.flatMap(Registry, (r) => r.wakeSession(input)));
  }
  setSessionThinkingLevel(input: SetSessionThinkingLevelInput) {
    return this.#run(Effect.flatMap(Registry, (r) => r.setSessionThinkingLevel(input)));
  }
  abortSession(input: AbortSessionInput) {
    return this.#run(Effect.flatMap(Registry, (r) => r.abortSession(input)));
  }
  stopSession(input: StopSessionInput) {
    return this.#run(Effect.flatMap(Registry, (r) => r.stopSession(input)));
  }
  deleteSession(input: DeleteSessionInput) {
    return this.#run(Effect.flatMap(Registry, (r) => r.deleteSession(input)));
  }
  updateSessionGitFile(input: UpdateSessionGitFileInput) {
    return this.#run(Effect.flatMap(Registry, (r) => r.updateSessionGitFile(input)));
  }
  readSessionGitPatchChunk(input: ReadSessionGitPatchChunkInput) {
    return this.#run(Effect.flatMap(Registry, (r) => r.readSessionGitPatchChunk(input)));
  }
  readSessionArtifactChunk(input: ReadSessionArtifactChunkInput) {
    return this.#run(Effect.flatMap(Registry, (r) => r.readSessionArtifactChunk(input)));
  }
  disconnectRunner(id: WorkspaceId, runner: string) {
    return this.#run(Effect.flatMap(Registry, (r) => r.disconnectRunner(id, runner)));
  }

  // Only upgrade and stream transport use fetch; commands use named native RPC methods.
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/watch") {
      const id = Schema.decodeUnknownSync(WorkspaceId)(url.searchParams.get("workspaceId"));
      const session = url.searchParams.get("sessionId");
      if (!session) return new Response("Missing session", { status: 400 });
      const stream = await this.#runtime.runPromise(
        Effect.flatMap(Registry, (r) => createSessionEventStream(r.watchSession(id, session))),
      );
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
        },
      });
    }
    if (url.pathname !== "/api/runners/connect" && url.pathname !== "/api/runners/connect/bulk") {
      return new Response("Not found", { status: 404 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }
    await this.health();
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    // The protocol's reader scope owns the accepted socket, including replacement and revocation.
    const socket = Socket.fromWebSocket(Effect.acquireRelease(
      Effect.succeed(server),
      (socket) => Effect.sync(() => socket.close(1000, "Connection closed")),
    ));
    this.#runtime.runFork(
      Effect.gen(function* () {
        const registry = yield* Registry;
        const accepted = yield* socket;
        yield* url.pathname.endsWith("/bulk")
          ? registry.acceptBulk(accepted)
          : registry.accept(accepted);
      }).pipe(
        Effect.provideService(Scope.Scope, this.#runtime.scope),
        Effect.catchCause(() => Effect.sync(() => server.close(1011, "Connection closed"))),
      ),
    );
    return new Response(null, { status: 101, webSocket: client });
  }
}
