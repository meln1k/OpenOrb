export interface TestServer {
  readonly baseUrl: URL;
  close(): Promise<void>;
}

export async function createTestServer(
  handler: (request: Request) => Response | Promise<Response>,
): Promise<TestServer> {
  let resolveAddress: (address: Deno.NetAddr) => void;
  const listening = new Promise<Deno.NetAddr>((resolve) => {
    resolveAddress = resolve;
  });

  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen: resolveAddress!,
    },
    handler,
  );
  const address = await listening;

  return {
    baseUrl: new URL(`http://${address.hostname}:${address.port}/`),
    async close() {
      await server.shutdown();
      await server.finished;
    },
  };
}
