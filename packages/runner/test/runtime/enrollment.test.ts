import { test } from "vite-plus/test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertThrows } from "@jsr/std__assert";
import type { Result } from "@openorb/result";

import { enrollRunner } from "../../src/runtime/enrollment.ts";
import { readRunnerIdentity, writeRunnerIdentity } from "../../src/runtime/identity.ts";
import { parseRunnerCommand } from "../../src/runtime/options.ts";

const RUNNER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c09";
const ENROLLMENT_PSK = `openorb_enroll_${"a".repeat(43)}`;
const RUNNER_TOKEN = `openorb_runner_${"b".repeat(43)}`;

test("parses first-start enrollment options", () => {
  assertEquals(
    parseRunnerCommand([
      "--gateway",
      "https://openorb.example.com",
      "--enrollment-token",
      ENROLLMENT_PSK,
      "--name",
      "Home runner",
    ]),
    {
      type: "start",
      options: {
        gateway: "https://openorb.example.com",
        enrollmentToken: ENROLLMENT_PSK,
        name: "Home runner",
      },
    },
  );
  assertThrows(
    () => parseRunnerCommand(["--data-dir", "/tmp/openorb"]),
    Error,
    "--data-dir is not supported",
  );
  assertEquals(
    assertThrows(() => parseRunnerCommand(["--unknown", ENROLLMENT_PSK]), Error).message,
    "Unknown argument.",
  );
  assertThrows(
    () => parseRunnerCommand(["--max-concurrent-sessions", "0"]),
    Error,
    "Unknown argument.",
  );
  assertThrows(
    () => parseRunnerCommand(["--vm-memory-mib", "4.5"]),
    Error,
    "--vm-memory-mib must be a positive integer",
  );
});

test("parses doctor gateway options without accepting enrollment credentials", () => {
  assertEquals(parseRunnerCommand(["doctor"]), { type: "doctor", options: {} });
  assertEquals(parseRunnerCommand(["doctor", "--gateway", "https://openorb.example.com"]), {
    type: "doctor",
    options: { gateway: "https://openorb.example.com" },
  });
  assertThrows(
    () => parseRunnerCommand(["doctor", "--enrollment-token", ENROLLMENT_PSK]),
    Error,
    "Unknown doctor argument",
  );
  assertThrows(
    () => parseRunnerCommand(["doctor", "--data-dir", "/tmp/openorb"]),
    Error,
    "--data-dir is not supported",
  );
});

test("enrolls with the PSK and validates the runner-token response", async () => {
  let received: unknown;
  const enrolled = success(
    await enrollRunner({
      gatewayUrl: "https://openorb.example.com",
      enrollmentPsk: ENROLLMENT_PSK,
      name: "Home runner",
      architecture: "arm64",
      fetch(_input, init) {
        received = JSON.parse(String(init?.body));
        return Promise.resolve(
          Response.json({ runnerId: RUNNER_ID, runnerToken: RUNNER_TOKEN }, { status: 201 }),
        );
      },
    }),
  );
  assertEquals(received, {
    enrollmentPsk: ENROLLMENT_PSK,
    name: "Home runner",
    architecture: "arm64",
  });
  assertEquals(enrolled, { runnerId: RUNNER_ID, runnerToken: RUNNER_TOKEN });

  const [, enrollmentError] = await enrollRunner({
    gatewayUrl: "https://openorb.example.com",
    enrollmentPsk: ENROLLMENT_PSK,
    name: "Home runner",
    architecture: "arm64",
    fetch: () => Promise.resolve(Response.json({ runnerId: RUNNER_ID, runnerToken: "bad" })),
  });
  if (enrollmentError === undefined) throw new Error("Expected invalid enrollment response.");
  assert(enrollmentError.message.includes("invalid enrollment response"));
});

test("stores the runner bearer token in a regular 0600 file", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "openorb-"));
  try {
    success(
      await writeRunnerIdentity(directory, {
        runnerId: RUNNER_ID,
        runnerToken: RUNNER_TOKEN,
        gatewayUrl: "https://openorb.example.com",
      }),
    );
    assertEquals(success(await readRunnerIdentity(directory)), {
      runnerId: RUNNER_ID,
      runnerToken: RUNNER_TOKEN,
      gatewayUrl: "https://openorb.example.com",
    });
    const tokenInfo = await fs.lstat(`${directory}/token`);
    assert(tokenInfo.isFile());
    assertEquals(tokenInfo.isSymbolicLink(), false);
    if (process.platform !== "win32") {
      assertEquals(tokenInfo.mode & 0o777, 0o600);
      await fs.chmod(`${directory}/token`, 0o644);
      const [, readError] = await readRunnerIdentity(directory);
      if (readError === undefined) throw new Error("Expected insecure token permissions to fail.");
      assert(readError.message.includes("permissions must be 0600"));
    }
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

function success<T, E>(result: Result<T, E>): T {
  const [value, error] = result;
  if (error !== undefined) throw error;
  // SAFETY: Result guarantees a value when its error slot is undefined.
  return value as T;
}
