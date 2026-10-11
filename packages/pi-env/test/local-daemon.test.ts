import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { encodeHex } from "@std/encoding/hex";
import { RemoteExecutionEnv } from "../src/index.ts";
import { assertions, type DaemonProcess, relayedConnection } from "./fixtures.ts";

// The vendored client against the pinned daemon running natively on a Linux host, through the
// same relay the runner uses. The Gondolin suite runs the same cases inside the guest.
const daemonPath = new URL(
  `../../../node_modules/@earendil-works/pi-env/bin/pi-env-linux-${
    Deno.build.arch === "aarch64" ? "arm64" : "x64"
  }/pi-env`,
  import.meta.url,
).pathname;
// Only `deno task test:pi-env` may run the daemon; the repository-wide test task skips it.
const daemonRunnable = Deno.build.os === "linux" &&
  (await Deno.permissions.query({ name: "run", command: daemonPath })).state === "granted";

function startLocalDaemon(): Promise<DaemonProcess> {
  const token = encodeHex(crypto.getRandomValues(new Uint8Array(16)));
  const child = new Deno.Command(daemonPath, {
    args: ["serve", "--token", token],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const stdin = child.stdin.getWriter();
  return Promise.resolve({
    token,
    write: (bytes) => void stdin.write(bytes).catch(() => {}),
    end: () => void stdin.close().catch(() => {}),
    stdout: child.stdout,
    exited: child.status,
  });
}

const connection = relayedConnection(startLocalDaemon);

for (
  const conformance of createEnvConformance({
    assertions,
    withEnv: async (use) => {
      const cwd = await Deno.makeTempDir({ prefix: "openorb-pi-env-" });
      try {
        await use(new RemoteExecutionEnv({ connection, id: `local:${cwd}`, cwd }));
      } finally {
        await Deno.remove(cwd, { recursive: true });
      }
    },
  })
) {
  Deno.test({
    name: `pi-env over a relayed link: ${conformance.name}`,
    ignore: !daemonRunnable,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => conformance.run(),
  });
}

Deno.test({
  name: "pi-env over a relayed link: closing the connection stops the daemon",
  ignore: !daemonRunnable,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => connection.close(),
});
