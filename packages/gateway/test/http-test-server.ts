import { createServer } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";

export interface TestServer {
  readonly baseUrl: URL;
  close(): Promise<void>;
}

export async function createTestServer(
  handler: (request: Request) => Response | Promise<Response>,
): Promise<TestServer> {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const method = incoming.method ?? "GET";
      const abort = new AbortController();
      outgoing.once("close", () => abort.abort());
      const headers = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
      }
      const request = new Request(new URL(incoming.url ?? "/", `http://${incoming.headers.host}`), {
        method,
        headers,
        signal: abort.signal,
        ...(method === "GET" || method === "HEAD"
          ? {}
          : {
              // SAFETY: IncomingMessage emits Buffer (Uint8Array) chunks; toWeb preserves those bytes.
              body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
              duplex: "half" as const,
            }),
      });
      const response = await handler(request);
      for (const [name, value] of response.headers) outgoing.setHeader(name, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outgoing.setHeader("set-cookie", cookies);
      outgoing.writeHead(response.status);
      if (response.body && method !== "HEAD") {
        const reader = response.body.getReader();
        const cancel = () => {
          void reader.cancel().catch(() => {});
        };
        abort.signal.addEventListener("abort", cancel, { once: true });
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!outgoing.write(value)) await once(outgoing, "drain");
          }
        } finally {
          abort.signal.removeEventListener("abort", cancel);
          reader.releaseLock();
        }
      }
      outgoing.end();
    } catch (error) {
      outgoing.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  // oxlint-disable-next-line openorb/no-runtime-typeof -- Validate Node's socket address union at the listener I/O boundary.
  if (!address || typeof address === "string") throw new Error("Expected TCP address");

  return {
    baseUrl: new URL(`http://127.0.0.1:${address.port}/`),
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
