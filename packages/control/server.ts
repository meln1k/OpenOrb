import { createAppServices } from "@/app/middleware/services.ts";
import { createDefaultStore } from "@/app/data/store.ts";
import { createAppRouter } from "@/app/router.ts";
import { routes } from "@/app/routes.ts";
import { RunnerConnectionGateway } from "@/app/runner-connection-gateway.ts";
import { migrate } from "@/db/migrate.ts";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { err, ok, type Result, tryAsync, trySync } from "@openorb/result";

const tracer = trace.getTracer("openorb-control", "0.0.0");
const [initialized, initializationError] = await tracer.startActiveSpan(
  "control.initialize",
  async (span) => {
    const [value, error] = await initializeControl();
    if (error !== undefined) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.end();
      return err(error);
    }
    span.end();
    return ok(value);
  },
);
if (initializationError !== undefined) throw initializationError;
const { store, router, runnerConnectionGateway } = initialized;
await using cleanup = new AsyncDisposableStack();
cleanup.defer(async () => {
  runnerConnectionGateway.close();
  await store.close();
});

const port = Number(Deno.env.get("PORT") ?? "44100");
const abortController = new AbortController();
const server = Deno.serve(
  {
    port,
    signal: abortController.signal,
    automaticCompression: true,
    onListen({ hostname, port: listeningPort }) {
      const displayHost = hostname === "0.0.0.0" ? "localhost" : hostname;
      console.log(
        JSON.stringify({
          component: "openorb-control",
          status: "healthy",
          url: `http://${displayHost}:${listeningPort}`,
          healthUrl: `http://${displayHost}:${listeningPort}/healthz`,
        }),
      );
    },
  },
  async (request) => {
    const [response, requestError] = await tryAsync(
      (async () => {
        if (new URL(request.url).pathname === routes.api.runners.connect.href()) {
          return runnerConnectionGateway.handleUpgrade(request);
        }
        return await router.fetch(request);
      })(),
      (cause) => new ControlRequestError(cause),
    );
    if (requestError !== undefined) {
      const span = trace.getActiveSpan();
      span?.recordException(requestError);
      span?.setStatus({ code: SpanStatusCode.ERROR, message: requestError.message });
      if (!(request.signal.aborted && requestError.cause === request.signal.reason)) {
        console.error(requestError);
      }
      return new Response("Internal Server Error", { status: 500 });
    }
    return response;
  },
);

let shuttingDown = false;

function shutdown(signal: Deno.Signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[openorb-control] received ${signal}; shutting down`);
  runnerConnectionGateway.close();
  abortController.abort();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => shutdown(signal));
}

await server.finished;

interface InitializedControl {
  store: Awaited<ReturnType<typeof createDefaultStore>>;
  router: ReturnType<typeof createAppRouter>;
  runnerConnectionGateway: RunnerConnectionGateway;
}

async function initializeControl(): Promise<
  Result<InitializedControl, ControlInitializationError>
> {
  const [store, storeError] = await tryAsync(
    createDefaultStore(),
    (cause) => new ControlInitializationError("Control data store initialization failed.", cause),
  );
  if (storeError !== undefined) return err(storeError);

  const [, migrationError] = await tracer.startActiveSpan(
    "database.migrate",
    async (span) => {
      const [value, error] = await tryAsync(
        migrate(store.pool),
        (cause) => new ControlInitializationError("Control database migration failed.", cause),
      );
      if (error !== undefined) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span.end();
        return err(error);
      }
      span.end();
      return ok(value);
    },
  );
  if (migrationError !== undefined) return err(migrationError);

  const [services, serviceError] = trySync(
    () => {
      const runnerConnectionGateway = new RunnerConnectionGateway(store);
      return {
        store,
        router: createAppRouter(createAppServices(store, runnerConnectionGateway)),
        runnerConnectionGateway,
      };
    },
    (cause) => new ControlInitializationError("Control services initialization failed.", cause),
  );
  if (serviceError !== undefined) return err(serviceError);
  return ok(services);
}

class ControlInitializationError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message, { cause });
    this.name = "ControlInitializationError";
  }
}

class ControlRequestError extends Error {
  constructor(override readonly cause: unknown) {
    super("Control request handling failed.", { cause });
    this.name = "ControlRequestError";
  }
}
