import { test } from "vite-plus/test";
import { assert, assertEquals, assertStringIncludes } from "@jsr/std__assert";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { MAX_SESSION_OUTPUT_BYTES } from "../app/cells/session/view.ts";
import {
  provisionCheckout,
  type ProvisioningReporter,
  resumeCheckout,
  setupEntry,
  type SetupOutput,
} from "../app/cells/session/provisioning.ts";

const SECRET = "gh-secret-token";
const CHECKOUT = { repositoryUrl: "https://github.com/acme/app.git", ref: "main", branchName: "s" };

/** A guest whose commands print the given chunks and exit with the given status. */
function guest(hooks: Readonly<Record<string, { chunks: readonly string[]; exitCode: number }>>) {
  const fake: Partial<ExecutionEnv> = {
    createDir: () => Promise.resolve({ ok: true, value: undefined }),
    exec: async (argv, options) => {
      const script = argv.at(-1) ?? "";
      const hook = Object.entries(hooks).find(([name]) => script.includes(name))?.[1];
      const chunks = hook?.chunks ?? (argv[1] === "rev-parse" ? ["0123abc\n"] : []);
      for (const text of chunks) {
        await options?.onOutput?.(text, BACKGROUND_CONTEXT, { stream: "stdout" });
      }
      return { ok: true, value: { exitCode: hook?.exitCode ?? 0 } };
    },
  };
  // SAFETY: provisioning uses only createDir and exec.
  return fake as ExecutionEnv;
}

function recorder() {
  const outputs: SetupOutput[] = [];
  const reporter: ProvisioningReporter = {
    stage: () => {},
    output: (output) => {
      outputs.push(output);
      return Promise.resolve();
    },
  };
  return { outputs, reporter };
}

test("setup output reaches the transcript redacted, keeping its end", async () => {
  const { outputs, reporter } = recorder();
  const filler = "added 1 package\n".repeat(4_000);
  const env = guest({
    ".agents/setup": {
      // The secret also arrives split across output chunks.
      chunks: [`token ${SECRET}\n`, filler, "npm ERR! missing script: build gh-sec", "ret-token\n"],
      exitCode: 1,
    },
  });
  const result = await provisionCheckout(env, CHECKOUT, reporter, [SECRET], BACKGROUND_CONTEXT);
  assertEquals(result.checkoutState, "available");
  assertEquals(
    result.issues.map((issue) => issue.category),
    ["setup"],
  );
  assertEquals(
    outputs.map(({ step, exitCode }) => ({ step, exitCode })),
    [{ step: "setup", exitCode: 1 }],
  );
  const { output } = outputs[0]!;
  assert(output.startsWith("[Earlier output was truncated.]\n"));
  assert(output.endsWith("npm ERR! missing script: build [REDACTED]\n"));
  assert(!output.includes(SECRET) && !output.includes("ret-token"));
  assert(new TextEncoder().encode(output).length <= MAX_SESSION_OUTPUT_BYTES);
});

test("only a failed project command reaches the agent; a silent hook leaves no entry", async () => {
  const silent = recorder();
  assertEquals(await resumeCheckout(guest({}), silent.reporter, [], BACKGROUND_CONTEXT), []);
  assertEquals(silent.outputs, []);

  const failed = recorder();
  const issues = await resumeCheckout(
    guest({ ".agents/resume": { chunks: ["port 3000 in use\n"], exitCode: 3 } }),
    failed.reporter,
    [],
    BACKGROUND_CONTEXT,
  );
  assertEquals(
    issues.map((issue) => issue.category),
    ["resume-hook"],
  );
  const entry = setupEntry(failed.outputs[0]!, 7);
  assertEquals(entry.kind, "openorb.setup");
  assertEquals(entry.data, { step: "resume", exitCode: 3, output: "port 3000 in use\n" });
  assertEquals(entry.model?.[0]?.role, "user");
  assertStringIncludes(entry.model?.[0]?.content ?? "", "exit status 3");
  assertStringIncludes(entry.model?.[0]?.content ?? "", "port 3000 in use");

  const succeeded = setupEntry({ step: "setup", exitCode: 0, output: "installed\n" }, 7);
  assertEquals("model" in succeeded, false);
});
