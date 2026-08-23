import { createAppServices } from "@/app/middleware/services.ts";
import { createDefaultStore } from "@/app/data/store.ts";
import { createAppRouter } from "@/app/router.ts";
import { routes } from "@/app/routes.ts";
import { RunnerConnectionGateway } from "@/app/runner-connection-gateway.ts";
import { migrate } from "@/db/migrate.ts";
import * as DenoHttpClient from "@effect/platform-deno/DenoHttpClient";
import * as DenoHttpServer from "@effect/platform-deno/DenoHttpServer";
import * as DenoRuntime from "@effect/platform-deno/DenoRuntime";
import { Effect, Layer } from "effect";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServer from "effect/unstable/http/HttpServer";
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

function makeGatewayHandler(
  router: InitializedGateway["router"],
  runnerConnectionGateway: RunnerConnectionGateway,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (new URL(request.url).pathname === routes.api.runners.connect.href()) {
      return runnerConnectionGateway.handleUpgrade(request);
    }
    return await router.fetch(request);
  };
}

interface InitializedGateway {
  store: Awaited<ReturnType<typeof createDefaultStore>>;
  router: ReturnType<typeof createAppRouter>;
  runnerConnectionGateway: RunnerConnectionGateway;
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

  const runnerConnectionGateway = yield* Effect.acquireRelease(
    Effect.try({
      try: () => new RunnerConnectionGateway(store),
      catch: (cause) =>
        new GatewayInitializationError("Gateway services initialization failed.", cause),
    }),
    (runnerConnectionGateway) => Effect.sync(() => runnerConnectionGateway.close()),
  );

  const router = yield* Effect.try({
    try: () => createAppRouter(createAppServices(store, runnerConnectionGateway)),
    catch: (cause) =>
      new GatewayInitializationError("Gateway services initialization failed.", cause),
  });

  return { store, router, runnerConnectionGateway } satisfies InitializedGateway;
});

class GatewayInitializationError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message, { cause });
    this.name = "GatewayInitializationError";
  }
}

const gatewayLive = Effect.scoped(Effect.gen(function* () {
  const { router, runnerConnectionGateway } = yield* initializeGateway();

  yield* Layer.launch(
    Layer.effectDiscard(Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      yield* server.serve(
        HttpEffect.fromWebHandler(
          makeGatewayHandler(router, runnerConnectionGateway),
        ),
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
