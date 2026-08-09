import { assertEquals, assertRejects } from "@std/assert";

import { validateRunnerWorkingDirectory } from "../src/working-directory.ts";

Deno.test("accepts a canonical runner working directory", async () => {
  const result = await validateRunnerWorkingDirectory({
    cwd: "/var/lib/openorb-runner",
    logicalCwd: "/var/lib/openorb-runner",
    realPath: (path) => Promise.resolve(path),
  });
  assertEquals(result, "/var/lib/openorb-runner");
});

Deno.test("rejects a mismatched PWD", async () => {
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

Deno.test("rejects a symlinked runner working directory", async () => {
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
