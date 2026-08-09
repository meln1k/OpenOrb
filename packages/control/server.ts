import * as http from "node:http";
import { createRequestListener } from "remix/node-fetch-server";

import { createControlRuntime } from "./app/data/runtime.ts";
import { createDefaultStore } from "./app/data/store.ts";
import { createAppRouter } from "./app/router.ts";
import { migrate } from "./db/migrate.ts";

const store = createDefaultStore();
await migrate(store.pool);
const router = createAppRouter(createControlRuntime(store));

const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 44100;

const server = http.createServer(
  createRequestListener(async (request) => {
    try {
      return await router.fetch(request);
    } catch (error) {
      if (!(request.signal.aborted && error === request.signal.reason)) {
        console.error(error);
      }
      return new Response("Internal Server Error", { status: 500 });
    }
  }),
);

server.listen(port, () => {
  console.log(
    JSON.stringify({
      component: "openorb-control",
      status: "healthy",
      url: `http://localhost:${port}`,
      healthUrl: `http://localhost:${port}/healthz`,
    }),
  );
});

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  server.close(async () => {
    await store.close();
    process.exit(0);
  });
  server.closeAllConnections();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
