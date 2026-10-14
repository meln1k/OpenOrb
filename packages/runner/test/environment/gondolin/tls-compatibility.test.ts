import { test, expect } from "vite-plus/test";
import { createServer } from "node:net";
import { Duplex } from "node:stream";
import { connect, createSecureContext, TLSSocket } from "node:tls";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execute } from "../../../src/runtime/process.ts";

// Gondolin supplies a custom Duplex and resolves SNI asynchronously. This exercises
// native Node's handshake resumption, with no private _start() calls or monkey patch.
test("native TLS resumes asynchronous SNI over a custom Duplex and still verifies trust", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openorb-tls-"));
  const sockets = new Set<TLSSocket>();
  const server = createServer((transport) => {
    const stream = new Duplex({
      read() {
        transport.resume();
      },
      write(chunk, encoding, callback) {
        transport.write(chunk, encoding, callback);
      },
      final(callback) {
        transport.end(callback);
      },
      destroy(error, callback) {
        transport.destroy();
        callback(error);
      },
    });
    transport.on("data", (chunk: Buffer) => {
      if (!stream.push(chunk)) transport.pause();
    });
    transport.on("end", () => stream.push(null));
    transport.on("error", (error) => stream.destroy(error));
    const socket = new TLSSocket(stream, {
      isServer: true,
      SNICallback(host, callback) {
        setTimeout(() => {
          expect(host).toBe("localhost");
          callback(null, context);
        }, 10);
      },
    });
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (data: Buffer) => socket.end(data));
  });
  let context: ReturnType<typeof createSecureContext>;
  try {
    const generated = await execute("openssl", {
      args: [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "cert.pem"),
      ],
    });
    expect(generated.success).toBe(true);
    const cert = await readFile(join(directory, "cert.pem"));
    context = createSecureContext({ key: await readFile(join(directory, "key.pem")), cert });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    // oxlint-disable-next-line openorb/no-runtime-typeof -- Validate Node's socket address union at the listener I/O boundary.
    if (!address || typeof address === "string") throw new Error("Expected TCP listener.");
    const client = connect({
      host: "127.0.0.1",
      port: address.port,
      servername: "localhost",
      ca: cert,
    });
    try {
      await once(client, "secureConnect");
      expect(client.authorized).toBe(true);
      client.write("mediated HTTPS plaintext");
      const [data] = await once(client, "data");
      expect(data.toString()).toBe("mediated HTTPS plaintext");
    } finally {
      client.destroy();
    }
    const untrusted = connect({ host: "127.0.0.1", port: address.port, servername: "localhost" });
    try {
      await expect(once(untrusted, "secureConnect")).rejects.toMatchObject({
        code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      });
    } finally {
      untrusted.destroy();
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true });
  }
}, 15_000);
