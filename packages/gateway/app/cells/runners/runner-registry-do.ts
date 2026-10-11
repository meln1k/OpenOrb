import { DurableObject } from "cloudflare:workers";
import type { DurableObjectState } from "@cloudflare/workers-types";
import { Effect, ManagedRuntime, Scope } from "effect";
import * as Socket from "effect/socket/Socket";
import type { Env } from "../../env.ts";
import type { WorkspaceApi } from "../workspace/api.ts";
import { RunnerRegistry as Registry, runnerRegistryLayer } from "./runner-registry.ts";
import type {
  AttachEnvironmentInput,
  ControlEnvironmentInput,
  CreateEnvironmentInput,
  EnvironmentInput,
  EnvironmentObserver,
} from "./runner-registry.ts";
import type { WorkspaceId } from "@openorb/protocol/runner-api";

export class Runners extends DurableObject<Env> {
  readonly #runtime;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // SAFETY: native RPC implements WorkspaceApi; platform thenables differ only in checker types.
    // deno-lint-ignore openorb/no-chained-type-assertions
    const workspace = env.WORKSPACE.getByName("workspace") as unknown as WorkspaceApi;
    // Runner-side environment changes go to the Session Durable Object that owns the agent.
    const observer: EnvironmentObserver = {
      notify: async (workspaceId, sessionId, notice) => {
        // Native RPC rejects Schema.Class values such as the environment snapshot.
        await env.SESSIONS.getByName(sessionId).environmentNotice(
          workspaceId,
          sessionId,
          structuredClone(notice),
        );
      },
    };
    this.#runtime = ManagedRuntime.make(runnerRegistryLayer(workspace, observer));
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
  disconnectRunner(id: WorkspaceId, runner: string) {
    return this.#run(Effect.flatMap(Registry, (r) => r.disconnectRunner(id, runner)));
  }

  getEnvironment(id: WorkspaceId, session: string) {
    return this.#run(Effect.flatMap(Registry, (r) => r.getEnvironment(id, session)));
  }
  createEnvironment(input: CreateEnvironmentInput) {
    return this.#run(Effect.flatMap(Registry, (r) => r.createEnvironment(input)));
  }
  controlEnvironment(input: ControlEnvironmentInput) {
    return this.#run(Effect.flatMap(Registry, (r) => r.controlEnvironment(input)));
  }
  attachEnvironment(input: AttachEnvironmentInput) {
    return this.#run(Effect.flatMap(Registry, (r) => r.attachEnvironment(input)));
  }
  deleteEnvironment(input: EnvironmentInput) {
    return this.#run(Effect.flatMap(Registry, (r) => r.deleteEnvironment(input)));
  }

  // Only upgrade and stream transport use fetch; commands use named native RPC methods.
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
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
