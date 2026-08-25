import { createAppServices } from "@/app/middleware/services.ts";
import { createDefaultStore } from "@/app/data/store.ts";
import { createAppRouter } from "@/app/router.ts";
import { routes } from "@/app/routes.ts";
import {
  RunnerRegistry,
  runnerRegistryLayer,
  type RunnerRegistryService,
} from "@/app/runner-registry.ts";
import { migrate } from "@/db/migrate.ts";
import * as DenoHttpClient from "@effect/platform-deno/DenoHttpClient";
import * as DenoHttpServer from "@effect/platform-deno/DenoHttpServer";
import * as DenoRuntime from "@effect/platform-deno/DenoRuntime";
import { Context, Effect, Layer } from "effect";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as OtlpSerialization from "effect/unstable/observability/OtlpSerialization";
import * as OtlpTracer from "effect/unstable/observability/OtlpTracer";

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
  store: Awaited<ReturnType<typeof createDefaultStore>>;
  router: ReturnType<typeof createAppRouter>;
  runnerRegistry: RunnerRegistryService;
}

const initializeGateway = Effect.fn("gateway.initialize")(function* () {
  const store = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => createDefaultStore(),
      catch: (cause) =>
        new GatewayInitializationError("Gateway data store initialization failed.", cause),
    }),
    (store) => Effect.promise(() => store.close()),
  );

  yield* Effect.tryPromise({
    try: () => migrate(store.pool),
    catch: (cause) => new GatewayInitializationError("Gateway database migration failed.", cause),
  }).pipe(
    Effect.withSpan("database.migrate"),
  );

  const registryContext = yield* Layer.build(runnerRegistryLayer(store));
  const runnerRegistry = Context.get(registryContext, RunnerRegistry);

  const router = yield* Effect.try({
    try: () => createAppRouter(createAppServices(store, runnerRegistry)),
    catch: (cause) =>
      new GatewayInitializationError("Gateway services initialization failed.", cause),
  });

  return { store, router, runnerRegistry } satisfies InitializedGateway;
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
          if (request.url.split("?", 1)[0] !== routes.api.runners.connect.href()) {
            return yield* remix;
          }
          const socket = yield* request.upgrade;
          yield* Effect.forkIn(runnerRegistry.accept(socket), gatewayScope);
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
