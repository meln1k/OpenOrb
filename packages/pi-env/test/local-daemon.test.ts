import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import { spawn } from "node:child_process";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { randomBytes } from "node:crypto";
import { RemoteExecutionEnv } from "../src/index.ts";
import { assertions, type DaemonProcess, relayedConnection } from "./fixtures.ts";

// The vendored client against the pinned daemon running natively on a Linux host, through the
// same relay the runner uses. The Gondolin suite runs the same cases inside the guest.
const daemonPath = new URL(
  `../../../node_modules/@earendil-works/pi-env/bin/pi-env-linux-${
    process.arch === "arm64" ? "arm64" : "x64"
  }/pi-env`,
  import.meta.url,
).pathname;
// Only `npm run test:pi-env` enables host processes; the default suite skips this integration.
const daemonRunnable = process.platform === "linux" && process.env.OPENORB_RUN_PI_ENV_TESTS === "1";

function startLocalDaemon(): Promise<DaemonProcess> {
  const token = randomBytes(16).toString("hex");
  const child = spawn(daemonPath, ["serve", "--token", token], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.stdin.on("error", () => {});
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  // The fixture consumes exit asynchronously; attach a handler before any spawn failure.
  void exited.catch(() => {});
  return Promise.resolve({
    token,
    write: (bytes) => {
      child.stdin.write(bytes);
    },
    end: () => {
      child.stdin.end();
    },
    stdout: child.stdout,
    exited,
  });
}

const connection = relayedConnection(startLocalDaemon);

for (const conformance of createEnvConformance({
  assertions,
  withEnv: async (use) => {
    const cwd = await mkdtemp(join(tmpdir(), "openorb-pi-env-"));
    try {
      await use(new RemoteExecutionEnv({ connection, id: `local:${cwd}`, cwd }));
    } finally {
      await rm(cwd, { recursive: true });
    }
  },
})) {
  test(
    `pi-env over a relayed link: ${conformance.name}`,
    { skip: !daemonRunnable, timeout: 120_000 },
    () => conformance.run(),
  );
}

test(
  "pi-env over a relayed link: closing the connection stops the daemon",
  { skip: !daemonRunnable, timeout: 120_000 },
  () => connection.close(),
);
