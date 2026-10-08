import { createAppServices } from "@/app/middleware/services.ts";
import { WorkspaceClient } from "@openorb/workspace";
import { createAppRouter } from "@/app/router.ts";
import { routes } from "@/app/routes.ts";
import {
  RunnerRegistry,
  runnerRegistryLayer,
  type RunnerRegistryService,
} from "@/app/runner-registry.ts";
import * as DenoHttpClient from "@effect/platform-deno/DenoHttpClient";
import * as DenoHttpServer from "@effect/platform-deno/DenoHttpServer";
import * as DenoRuntime from "@effect/platform-deno/DenoRuntime";
import { Context, Effect, Layer } from "effect";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as OtlpSerialization from "effect/observability/OtlpSerialization";
import * as OtlpTracer from "effect/observability/OtlpTracer";

const port = Number(Deno.env.get("PORT") ?? "44100");

const telemetryLayer = OtlpTracer.layerFromConfig({
  resource: {
    serviceName: "openorb-gateway",
    serviceVersion: "0.0.0",
  },
}).pipe(
  Layer.provide(
    Layer.merge(DenoHttpClient.layer, OtlpSerialization.layerProtobuf),
  ),
);

function makeRemixHandler(
  router: InitializedGateway["router"],
): (request: Request) => Promise<Response> {
  return (request) => router.fetch(request);
}

interface InitializedGateway {
  router: ReturnType<typeof createAppRouter>;
  runnerRegistry: RunnerRegistryService;
}

const initializeGateway = Effect.fn("gateway.initialize")(function* () {
  const workspaceUrl = Deno.env.get("OPENORB_WORKSPACE_URL") ?? "http://127.0.0.1:44200";
  const workspace = new WorkspaceClient(workspaceUrl);
  yield* Effect.tryPromise({
    try: async () => {
      const response = await fetch(new URL("/healthz", workspaceUrl), {
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      await response.body?.cancel();
      if (!response.ok) throw new GatewayInitializationError("Workspace unavailable", undefined);
    },
    catch: (cause) => new GatewayInitializationError("Workspace initialization failed.", cause),
  });

  const registryContext = yield* Layer.build(runnerRegistryLayer({
    authenticateRunner: (token) => workspace.call("authenticateRunner", token),
    reconcileSessionManifestEntries: (workspaceId, entries) =>
      workspace.call("reconcileSessionManifestEntries", workspaceId, entries),
  }));
  const runnerRegistry = Context.get(registryContext, RunnerRegistry);

  const router = yield* Effect.try({
    try: () => createAppRouter(createAppServices(workspace, runnerRegistry)),
    catch: (cause) =>
      new GatewayInitializationError("Gateway services initialization failed.", cause),
  });

  return { router, runnerRegistry } satisfies InitializedGateway;
});

class GatewayInitializationError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message, { cause });
    this.name = "GatewayInitializationError";
  }
}

const gatewayLive = Effect.scoped(Effect.gen(function* () {
  const { router, runnerRegistry } = yield* initializeGateway();
  const gatewayScope = yield* Effect.scope;

  yield* Layer.launch(
    Layer.effectDiscard(Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const remix = HttpEffect.fromWebHandler(makeRemixHandler(router));
      yield* server.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const requestPath = request.url.split("?", 1)[0];
          const isControl = requestPath === routes.api.runners.connect.href();
          const isBulk = requestPath === routes.api.runners.connectBulk.href();
          if (!isControl && !isBulk) {
            return yield* remix;
          }
          const socket = yield* request.upgrade;
          yield* Effect.forkIn(
            isBulk ? runnerRegistry.acceptBulk(socket) : runnerRegistry.accept(socket),
            gatewayScope,
          );
          return HttpServerResponse.empty();
        }),
      );
    })).pipe(
      Layer.provide(
        DenoHttpServer.layer({
          port,
          automaticCompression: true,
          onListen({ hostname, port: listeningPort }: { hostname: string; port: number }) {
            const displayHost = hostname === "0.0.0.0" ? "localhost" : hostname;
            console.log(
              JSON.stringify({
                component: "openorb-gateway",
                status: "healthy",
                url: `http://${displayHost}:${listeningPort}`,
                healthUrl: `http://${displayHost}:${listeningPort}/healthz`,
              }),
            );
          },
        }),
      ),
    ),
  );
}));

gatewayLive.pipe(
  Effect.provide(telemetryLayer),
  DenoRuntime.runMain,
);
