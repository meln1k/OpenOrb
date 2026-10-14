import { test } from "vite-plus/test";
import { assertEquals, assertRejects } from "@jsr/std__assert";

import { validateRunnerWorkingDirectory } from "../../src/runtime/working-directory.ts";

test("accepts a canonical runner working directory", async () => {
  const result = await validateRunnerWorkingDirectory({
    cwd: "/var/lib/openorb-runner",
    logicalCwd: "/var/lib/openorb-runner",
    realPath: (path) => Promise.resolve(path),
  });
  assertEquals(result, "/var/lib/openorb-runner");
});

test("rejects a mismatched PWD", async () => {
  await assertRejects(
    () =>
      validateRunnerWorkingDirectory({
        cwd: "/var/lib/openorb-runner",
        logicalCwd: "/tmp",
        realPath: (path) => Promise.resolve(path),
      }),
    Error,
    "PWD does not match",
  );
});

test("rejects a symlinked runner working directory", async () => {
  await assertRejects(
    () =>
      validateRunnerWorkingDirectory({
        cwd: "/srv/actual-openorb-runner",
        logicalCwd: "/var/lib/openorb-runner",
        realPath(path) {
          return Promise.resolve(
            path === "/var/lib/openorb-runner" ? "/srv/actual-openorb-runner" : path,
          );
        },
      }),
    Error,
    "must not be a symlink",
  );
});
