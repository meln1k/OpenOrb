import { test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assert,
  assertEquals,
  assertGreater,
  assertObjectMatch,
  assertRejects,
} from "@jsr/std__assert";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { RemoteExecutionEnv } from "@openorb/pi-env";
import { Effect, Exit, Scope } from "effect";
import { makeGondolinAgentEnvironmentProvider } from "../../../src/environment/gondolin/layer.ts";
import { relayedConnection } from "./guest-tools.ts";
import { gondolinTestEnvironmentOptions, installLocalGuestImage } from "./local-guest-image.ts";

test.skipIf(process.env.OPENORB_RUN_GONDOLIN_TESTS !== "1")(
  "the guest Environment Daemon conforms to ExecutionEnv over a relayed link",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "openorb-"));
    const scope = await Effect.runPromise(Scope.make());
    try {
      const options = gondolinTestEnvironmentOptions();
      const provider = makeGondolinAgentEnvironmentProvider(
        await installLocalGuestImage(directory),
        options.softwareEmulation,
      );
      const rootDiskPath = `${directory}/root-disk.qcow2`;
      await Effect.runPromise(provider.initializeRootDisk(rootDiskPath));
      const environment = await Effect.runPromise(
        provider
          .make({
            rootDiskPath,
            sessionLabel: "openorb environment daemon test",
            cpuCount: 2,
            memoryMiB: 2 * 1024,
          })
          .pipe(Effect.provideService(Scope.Scope, scope)),
      );
      const connection = relayedConnection(environment);
      const root = new RemoteExecutionEnv({ connection, id: "guest", cwd: "/" });

      const cases = createEnvConformance({
        assertions: {
          ok: (value, message) => assert(value, message),
          strictEqual: (actual, expected) => assertEquals(actual, expected),
          deepEqual: (actual, expected) => assertEquals(actual, expected),
          partialDeepEqual: (actual, expected) =>
            assertObjectMatch(
              // SAFETY: conformance cases only compare record-shaped results partially.
              // oxlint-disable-next-line openorb/no-unsafe-dictionary-type
              actual as Record<PropertyKey, unknown>,
              // SAFETY: as above; `assertObjectMatch` accepts only records.
              // oxlint-disable-next-line openorb/no-unsafe-dictionary-type
              expected as Record<PropertyKey, unknown>,
            ),
          greaterThan: (actual, expected) => assertGreater(actual, expected),
          rejects: async (operation, messageIncludes) => {
            await assertRejects(() => operation, Error, messageIncludes);
          },
        },
        withEnv: async (use) => {
          const cwd = getOrThrow(await root.createTempDir("conformance-", context));
          try {
            await use(new RemoteExecutionEnv({ connection, id: "guest", cwd }));
          } finally {
            getOrThrow(await root.remove(cwd, { recursive: true, force: true }, context));
          }
        },
      });
      for (const conformance of cases) {
        await conformance.run();
      }

      {
        let output = "";
        const result = getOrThrow(
          await root.exec(
            'printf %s "$OPENORB_GUEST"',
            {
              onOutput: (text) => void (output += text),
            },
            context,
          ),
        );
        assertEquals(result.exitCode, 0);
        assertEquals(output, "1");
      }

      {
        const marker = "/tmp/openorb-link-loss.pid";
        const running = root.exec(`echo $$ > ${marker}; exec sleep 600`, {}, context);
        for (let attempt = 0; attempt < 100; attempt++) {
          if (getOrThrow(await root.exists(marker, context))) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        connection.close();
        const lost = await running;
        assert(!lost.ok);
        let alive = true;
        for (let attempt = 0; attempt < 50 && alive; attempt++) {
          const probe = await Effect.runPromise(
            environment.run(["/bin/sh", "-c", `kill -0 "$(cat ${marker})"`]),
          );
          alive = probe.exitCode === 0;
          if (alive) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert(!alive, "the command survived the lost link");
      }
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await rm(directory, { recursive: true });
    }
  },
  600_000,
);
