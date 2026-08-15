import { createAppServices } from "@/app/middleware/services.ts";
import { createDefaultStore } from "@/app/data/store.ts";
import { createAppRouter } from "@/app/router.ts";
import { routes } from "@/app/routes.ts";
import { RunnerConnectionGateway } from "@/app/runner-connection-gateway.ts";
import { migrate } from "@/db/migrate.ts";
import { SpanStatusCode, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("openorb-control", "0.0.0");
const { store, router, runnerConnectionGateway } = await tracer.startActiveSpan(
  "control.initialize",
  async (span) => {
    try {
      const store = await createDefaultStore();
      await tracer.startActiveSpan("database.migrate", async (migrationSpan) => {
        try {
          await migrate(store.pool);
        } catch (error) {
          migrationSpan.recordException(toError(error));
          migrationSpan.setStatus({ code: SpanStatusCode.ERROR, message: toError(error).message });
          throw error;
        } finally {
          migrationSpan.end();
        }
      });
      return {
        store,
        router: createAppRouter(createAppServices(store)),
        runnerConnectionGateway: new RunnerConnectionGateway(store),
      };
    } catch (error) {
      span.recordException(toError(error));
      span.setStatus({ code: SpanStatusCode.ERROR, message: toError(error).message });
      throw error;
    } finally {
      span.end();
    }
  },
);

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
    try {
      if (new URL(request.url).pathname === routes.api.runners.connect.href()) {
        return runnerConnectionGateway.handleUpgrade(request);
      }
      return await router.fetch(request);
    } catch (error) {
      const exception = toError(error);
      const span = trace.getActiveSpan();
      span?.recordException(exception);
      span?.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
      if (!(request.signal.aborted && error === request.signal.reason)) {
        console.error(error);
      }
      return new Response("Internal Server Error", { status: 500 });
    }
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

try {
  await server.finished;
} finally {
  runnerConnectionGateway.close();
  await store.close();
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
