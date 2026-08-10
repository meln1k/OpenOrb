import { createAppServices } from "./app/middleware/services.ts";
import { createDefaultStore } from "./app/data/store.ts";
import { createAppRouter } from "./app/router.ts";
import { migrate } from "./db/migrate.ts";

const store = await createDefaultStore();
await migrate(store.pool);
const router = createAppRouter(createAppServices(store));

const port = Number(Deno.env.get("PORT") ?? "44100");
const abortController = new AbortController();
const server = Deno.serve(
  {
    port,
    signal: abortController.signal,
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
      return await router.fetch(request);
    } catch (error) {
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
  abortController.abort();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => shutdown(signal));
}

try {
  await server.finished;
} finally {
  await store.close();
}
