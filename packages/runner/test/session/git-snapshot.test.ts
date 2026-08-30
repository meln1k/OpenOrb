import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import * as DenoFileSystem from "@effect/platform-deno/DenoFileSystem";
import { GitAuthor, ProjectId, SessionId, UserId } from "@openorb/protocol/runner-api";
import { Effect, Exit, Schema, Scope } from "effect";

import type {
  AgentEnvironment,
  AgentEnvironmentCommandOptions,
} from "@/src/environment/agent-environment.ts";
import { createGondolinAgentEnvironment } from "@/src/environment/gondolin/layer.ts";
import { RunnerSessionDefinition } from "@/src/session/definition.ts";
import { generateSessionGitSnapshot, updateSessionGitFile } from "@/src/session/git-snapshot.ts";
import { makeRunnerSessionStore } from "@/src/session/store.ts";
import { installLocalGuestImage } from "@/test/environment/gondolin/local-guest-image.ts";

const RUNNER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c09";
const SESSION_ID = Schema.decodeUnknownSync(SessionId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c10",
);
const PROJECT_ID = Schema.decodeUnknownSync(ProjectId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c11",
);
const USER_ID = Schema.decodeUnknownSync(UserId)(
  "01989d78-65ee-7f6a-a97e-0f16ad134c12",
);
const GIT_AUTHOR = new GitAuthor({ name: "OpenOrb User", email: "user@example.com" });
const BASE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

function sessionDefinition(branchName: string): RunnerSessionDefinition {
  return new RunnerSessionDefinition({
    userId: USER_ID,
    projectId: PROJECT_ID,
    repositoryUrl: "https://github.com/meln1k/openorb-test-repo.git",
    ref: "main",
    branchName,
    gitAuthor: GIT_AUTHOR,
    initialPrompt: "Inspect the repository",
    model: "opencode-go/deepseek-v4-flash",
    orbSize: "small",
  });
}

class GitSnapshotEnvironment implements AgentEnvironment {
  readonly commands: string[][] = [];
  readonly files = new Map<string, string>();

  constructor(private readonly scenario: "states" | "bounds" = "states") {}

  checkpoint: AgentEnvironment["checkpoint"] = () => Effect.die("unexpected checkpoint");

  run: AgentEnvironment["run"] = (command, options = {}) => {
    this.commands.push([...command]);
    if (command.includes("/bin/sh")) {
      const stdout = this.scenario === "bounds"
        ? untrackedDiff("generated/00000-bounds.txt", `+${"x".repeat(600_000)}\n`)
        : [
          untrackedBinaryDiff("src/binary-untracked.dat"),
          untrackedDiff("src/control\\nname.ts", "+control name\n"),
          untrackedDiff("src/untracked.ts", "+untracked content\n"),
        ].join("");
      return emitCommandOutput(stdout, options.onOutput);
    }
    const git = command.indexOf("/usr/bin/git");
    const args = command.slice(git + 1);
    let stdout = "";
    if (this.scenario === "bounds" && args.includes("status")) {
      stdout = [
        `# branch.oid ${BASE_COMMIT}`,
        "# branch.head openorb/snapshot-test",
        "1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb binary.dat",
        ...Array.from(
          { length: 12_000 },
          (_, index) => `? generated/${String(index).padStart(5, "0")}-${"x".repeat(20)}.txt`,
        ),
        "",
      ].join("\0");
    } else if (
      this.scenario === "bounds" && args.includes("diff") && !args.includes("--cached")
    ) {
      stdout = trackedDiff(
        `diff --git a/binary.dat b/binary.dat\nBinary files a/binary.dat and b/binary.dat differ\n\u001b${
          "x".repeat(600_000)
        }`,
        "-\t-\tbinary.dat\0",
      );
    } else if (args.includes("status")) {
      stdout = [
        `# branch.oid ${BASE_COMMIT}`,
        "# branch.head openorb/snapshot-test",
        "1 MM N... 100644 100644 100644 aaaaaaa bbbbbbb src/modified.ts",
        "1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb src/staged.ts",
        "1 A. N... 000000 100644 100644 0000000 bbbbbbb src/staged-added.ts",
        "1 .D N... 100644 100644 000000 aaaaaaa aaaaaaa src/deleted.ts",
        "2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 src/new.ts",
        "src/old.ts",
        "? src/binary-untracked.dat",
        "? src/control\nname.ts",
        "? src/untracked.ts",
        "",
      ].join("\0");
    } else if (args.includes("diff") && args.includes("--cached")) {
      stdout = trackedDiff(
        [
          "diff --git a/src/modified.ts b/src/modified.ts",
          "--- a/src/modified.ts",
          "+++ b/src/modified.ts",
          "@@ -1 +1 @@",
          "-base",
          "+staged modified",
          "diff --git a/src/staged.ts b/src/staged.ts",
          "--- a/src/staged.ts",
          "+++ b/src/staged.ts",
          "@@ -1 +1 @@",
          "-before staged",
          "+after staged",
          "",
        ].join("\n"),
        ["1\t1\tsrc/modified.ts", "1\t1\tsrc/staged.ts", ""].join("\0"),
      );
    } else if (args.includes("diff")) {
      stdout = trackedDiff(
        "diff --git a/src/modified.ts b/src/modified.ts\n--- a/src/modified.ts\n+++ b/src/modified.ts\n@@ -1 +1 @@\n-old\n+new\u001b[31m\u202E\n",
        "1\t1\tsrc/modified.ts\0",
      );
    }
    return emitCommandOutput(stdout, options.onOutput);
  };
  runShell: AgentEnvironment["runShell"] = () => Effect.die("Git snapshots must not use a shell.");
  readFile: AgentEnvironment["readFile"] = () => Effect.succeed(new Uint8Array());
  access: AgentEnvironment["access"] = () => Effect.void;
  writeFile: AgentEnvironment["writeFile"] = (path, content) =>
    Effect.sync(() => {
      this.files.set(path, content);
    });
  makeDirectory: AgentEnvironment["makeDirectory"] = () => Effect.void;
  detectImageMimeType: AgentEnvironment["detectImageMimeType"] = () => Effect.succeed(null);
}

class GitMutationEnvironment extends GitSnapshotEnvironment {
  state: "staged" | "unstaged" = "unstaged";
  failNextMutation = false;

  override run: AgentEnvironment["run"] = (command, options = {}) => {
    this.commands.push([...command]);
    const git = command.indexOf("/usr/bin/git");
    const args = command.slice(git + 1);
    let stdout = "";
    if (args.includes("status")) {
      const xy = this.state === "staged" ? "M." : ".M";
      stdout = `1 ${xy} N... 100644 100644 100644 aaaaaaa bbbbbbb src/dual.ts\0`;
    } else if (args.includes("diff") && args.includes("--cached")) {
      if (this.state === "staged") {
        stdout = trackedDiff(patch("base", "staged"), "1\t1\tsrc/dual.ts\0");
      }
    } else if (args.includes("diff")) {
      if (this.state === "unstaged") {
        stdout = trackedDiff(patch("base", "unstaged"), "1\t1\tsrc/dual.ts\0");
      }
    } else if (args.includes("add")) {
      if (!this.failNextMutation) this.state = "staged";
    } else if (args.includes("restore")) {
      if (!this.failNextMutation) this.state = "unstaged";
    }
    const mutationFailed = (args.includes("add") || args.includes("restore")) &&
      this.failNextMutation;
    if (mutationFailed) this.failNextMutation = false;
    return Effect.gen(function* () {
      if (stdout && options.onOutput) {
        yield* options.onOutput({ stream: "stdout", text: stdout }).pipe(Effect.orDie);
      }
      return { exitCode: mutationFailed ? 1 : 0 };
    });
  };
}

function patch(before: string, after: string): string {
  return [
    "diff --git a/src/dual.ts b/src/dual.ts",
    "--- a/src/dual.ts",
    "+++ b/src/dual.ts",
    "@@ -1 +1 @@",
    `-${before}`,
    `+${after}`,
    "",
  ].join("\n");
}

function trackedDiff(patch: string, numstat: string): string {
  return `${numstat}\0${patch}`;
}

function untrackedDiff(path: string, addition: string): string {
  return "\0" +
    `1\t0\t/dev/null => ${path}\n\ndiff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n${addition}`;
}

function untrackedBinaryDiff(path: string): string {
  return "\0" +
    `-\t-\t/dev/null => ${path}\n\ndiff --git a/${path} b/${path}\nBinary files /dev/null and b/${path} differ\n`;
}

function emitCommandOutput(
  stdout: string,
  onOutput: AgentEnvironmentCommandOptions["onOutput"],
) {
  return Effect.gen(function* () {
    if (stdout && onOutput) {
      yield* onOutput({ stream: "stdout", text: stdout }).pipe(Effect.orDie);
    }
    return { exitCode: 0 };
  });
}

Deno.test("Git Snapshot is generated through bounded direct guest commands", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await Effect.runPromise(
      makeRunnerSessionStore({ workingDirectory, runnerId: RUNNER_ID }).pipe(
        Effect.provide(DenoFileSystem.layer),
      ),
    );
    await Effect.runPromise(store.ensureSession(
      SESSION_ID,
      sessionDefinition(
        "openorb/snapshot-test",
      ),
    ));
    const metadata = await Effect.runPromise(store.updateProvisioning(SESSION_ID, {
      state: "running",
      checkoutState: "available",
      baseCommit: BASE_COMMIT,
    }));
    const environment = new GitSnapshotEnvironment();
    const snapshot = await Effect.runPromise(generateSessionGitSnapshot(environment, metadata));

    assertEquals(snapshot.completeness, "complete");
    assertEquals(snapshot.branch, "openorb/snapshot-test");
    assertEquals(snapshot.head, BASE_COMMIT);
    assertEquals(
      snapshot.sections.staged.files.map((file) => ({
        kind: file.kind,
        path: file.path,
        previousPath: "previousPath" in file ? file.previousPath : undefined,
        status: file.status,
        diffState: file.diffState,
      })),
      [
        {
          kind: "tracked",
          path: "src/modified.ts",
          previousPath: undefined,
          status: "modified",
          diffState: "available",
        },
        {
          kind: "tracked",
          path: "src/new.ts",
          previousPath: "src/old.ts",
          status: "renamed",
          diffState: "available",
        },
        {
          kind: "tracked",
          path: "src/staged-added.ts",
          previousPath: undefined,
          status: "added",
          diffState: "available",
        },
        {
          kind: "tracked",
          path: "src/staged.ts",
          previousPath: undefined,
          status: "modified",
          diffState: "available",
        },
      ],
    );
    assertEquals(
      snapshot.sections.unstaged.files.map((file) => ({
        kind: file.kind,
        path: file.path,
        displayPath: file.displayPath,
        status: file.status,
        diffState: file.diffState,
      })),
      [
        {
          kind: "untracked",
          path: "src/binary-untracked.dat",
          displayPath: "src/binary-untracked.dat",
          status: "added",
          diffState: "binary",
        },
        {
          kind: "untracked",
          path: "src/control\nname.ts",
          displayPath: "src/control\\u{A}name.ts",
          status: "added",
          diffState: "available",
        },
        {
          kind: "tracked",
          path: "src/deleted.ts",
          displayPath: "src/deleted.ts",
          status: "deleted",
          diffState: "available",
        },
        {
          kind: "tracked",
          path: "src/modified.ts",
          displayPath: "src/modified.ts",
          status: "modified",
          diffState: "available",
        },
        {
          kind: "untracked",
          path: "src/untracked.ts",
          displayPath: "src/untracked.ts",
          status: "added",
          diffState: "available",
        },
      ],
    );
    assertStringIncludes(snapshot.sections.staged.patch, "+after staged");
    assertStringIncludes(snapshot.sections.staged.patch, "+staged modified");
    assertStringIncludes(snapshot.sections.unstaged.patch, "+new");
    assertStringIncludes(snapshot.sections.unstaged.patch, "+untracked content");
    assertEquals(snapshot.sections.unstaged.patch.includes("binary-untracked.dat"), false);
    assertEquals(snapshot.sections.unstaged.patch.includes("\u001b"), false);
    assertEquals(snapshot.sections.unstaged.patch.includes("\u202e"), false);
    assertStringIncludes(snapshot.sections.unstaged.patch, "\\u{1B}");
    assertStringIncludes(snapshot.sections.unstaged.patch, "\\u{202E}");

    assertEquals(environment.commands.length, 4);
    const gitCommands = environment.commands.filter((command) => command.includes("/usr/bin/git"));
    assertEquals(gitCommands.length, 3);
    for (const command of gitCommands) {
      assertEquals(command[0], "/usr/bin/timeout");
      assert(command.includes("/usr/bin/env"));
      assert(command.includes("-i"));
      assert(command.includes("GIT_CONFIG_NOSYSTEM=1"));
      assert(command.includes("GIT_CONFIG_GLOBAL=/dev/null"));
      assert(command.includes("GIT_ATTR_NOSYSTEM=1"));
      assert(command.includes("safe.directory=/workspace"));
      assert(command.includes("core.fsmonitor=false"));
      assert(command.includes("core.hooksPath=/dev/null"));
      assert(command.includes("diff.external="));
      assertEquals(command.some((part) => part.startsWith("GIT_DIR=")), false);
    }
    const stagedPatchCommand = gitCommands.find((command) =>
      command.includes("diff") && command.includes("--cached")
    );
    assert(stagedPatchCommand);
    assert(stagedPatchCommand.includes("--no-ext-diff"));
    assert(stagedPatchCommand.includes("--no-textconv"));
    assert(stagedPatchCommand.includes("--numstat"));
    assert(stagedPatchCommand.includes("-z"));
    assert(stagedPatchCommand.includes("--unified=1000000"));
    assert(stagedPatchCommand.includes("HEAD"));
    assertEquals(stagedPatchCommand.includes(BASE_COMMIT), false);
    const unstagedPatchCommand = gitCommands.find((command) =>
      command.includes("diff") && !command.includes("--cached")
    );
    assert(unstagedPatchCommand);
    assertEquals(unstagedPatchCommand.includes("HEAD"), false);
    const untrackedPatchCommand = environment.commands.find((command) =>
      command.includes("/bin/sh")
    );
    assert(untrackedPatchCommand);
    assert(untrackedPatchCommand.includes("src/binary-untracked.dat"));
    assert(untrackedPatchCommand.includes("src/control\nname.ts"));
    assert(untrackedPatchCommand.includes("src/untracked.ts"));
    assertStringIncludes(
      untrackedPatchCommand[untrackedPatchCommand.indexOf("-c") + 1] ?? "",
      "diff --no-index",
    );
    assertEquals(gitCommands.some((command) => command.includes("init")), false);
    assertEquals(environment.commands.some((command) => command[0] === "/bin/rm"), false);
    assertEquals(environment.files.size, 0);
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("Git file updates proxy fixed direct mutation commands", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await Effect.runPromise(
      makeRunnerSessionStore({ workingDirectory, runnerId: RUNNER_ID }).pipe(
        Effect.provide(DenoFileSystem.layer),
      ),
    );
    await Effect.runPromise(store.ensureSession(
      SESSION_ID,
      sessionDefinition(
        "openorb/git-mutation-test",
      ),
    ));
    const metadata = await Effect.runPromise(store.updateProvisioning(SESSION_ID, {
      state: "ready",
      checkoutState: "available",
      baseCommit: BASE_COMMIT,
    }));
    const environment = new GitMutationEnvironment();

    const exactPath = "src/literal*.ts";
    const exactPreviousPath = "src/old\nname.ts";
    const staged = await Effect.runPromise(updateSessionGitFile(environment, metadata, {
      action: "stage",
      path: exactPath,
      previousPath: exactPreviousPath,
    }));
    assert(staged.ok);
    assertEquals(environment.state, "staged");
    const add = environment.commands.find((command) => command.includes("add"));
    assert(add);
    assertEquals(add.slice(-5), ["add", "-A", "--", exactPath, exactPreviousPath]);
    assertEquals(add.some((part) => part.startsWith("GIT_DIR=")), false);
    assertEquals(add.includes("GIT_OPTIONAL_LOCKS=0"), false);
    assert(add.includes("GIT_LITERAL_PATHSPECS=1"));

    const unstaged = await Effect.runPromise(updateSessionGitFile(environment, metadata, {
      action: "unstage",
      path: exactPath,
      previousPath: exactPreviousPath,
    }));
    assert(unstaged.ok);
    assertEquals(environment.state, "unstaged");
    const restore = environment.commands.find((command) => command.includes("restore"));
    assert(restore);
    assertEquals(restore.slice(-5), [
      "restore",
      "--staged",
      "--",
      exactPath,
      exactPreviousPath,
    ]);

    environment.failNextMutation = true;
    const failed = await Effect.runPromise(updateSessionGitFile(environment, metadata, {
      action: "stage",
      path: "--config=core.hooksPath=/tmp/hostile",
    }));
    assertEquals(failed.ok, false);
    assertEquals(environment.state, "unstaged");
    const failedAdd = environment.commands.filter((command) => command.includes("add")).at(-1);
    assert(failedAdd);
    assertEquals(failedAdd.slice(-4), [
      "add",
      "-A",
      "--",
      "--config=core.hooksPath=/tmp/hostile",
    ]);
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test("Git Snapshot bounds large file lists and binary/control patch output", async () => {
  const workingDirectory = await Deno.makeTempDir();
  try {
    const store = await Effect.runPromise(
      makeRunnerSessionStore({ workingDirectory, runnerId: RUNNER_ID }).pipe(
        Effect.provide(DenoFileSystem.layer),
      ),
    );
    await Effect.runPromise(store.ensureSession(
      SESSION_ID,
      sessionDefinition(
        "openorb/snapshot-bounds-test",
      ),
    ));
    const metadata = await Effect.runPromise(store.updateProvisioning(SESSION_ID, {
      state: "running",
      checkoutState: "available",
      baseCommit: BASE_COMMIT,
    }));
    const snapshot = await Effect.runPromise(
      generateSessionGitSnapshot(new GitSnapshotEnvironment("bounds"), metadata),
    );

    assertEquals(snapshot.completeness, "complete");
    assertEquals(snapshot.truncated, true);
    assert(
      snapshot.sections.staged.files.length + snapshot.sections.unstaged.files.length <= 1_000,
    );
    assert(new TextEncoder().encode(snapshot.sections.unstaged.patch).byteLength <= 256 * 1024);
    assert(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength < 1024 * 1024);
    assertEquals(
      snapshot.sections.unstaged.files.find((file) => file.path === "binary.dat")?.diffState,
      "binary",
    );
    assertStringIncludes(
      snapshot.sections.unstaged.patch,
      "Binary files a/binary.dat and b/binary.dat differ",
    );
    assertStringIncludes(snapshot.sections.unstaged.patch, "\\u{1B}");
    assertEquals(snapshot.sections.unstaged.patch.includes("\u001b"), false);
  } finally {
    await Deno.remove(workingDirectory, { recursive: true });
  }
});

Deno.test({
  name: "Git Snapshot and durable staging stay inside Gondolin",
  ignore: Deno.env.get("OPENORB_RUN_GONDOLIN_TESTS") !== "1",
  async fn() {
    const workingDirectory = await Deno.makeTempDir();
    const hostMarker = `${workingDirectory}/runner-host-marker`;
    const guestMarker = "/workspace/git-snapshot-helper-executed";
    const store = await Effect.runPromise(
      makeRunnerSessionStore({ workingDirectory, runnerId: RUNNER_ID }).pipe(
        Effect.provide(DenoFileSystem.layer),
      ),
    );
    await Effect.runPromise(store.ensureSession(
      SESSION_ID,
      sessionDefinition(
        "openorb/hostile-snapshot-test",
      ),
    ));
    const workspacePath = await Effect.runPromise(store.getSessionWorkspacePath(SESSION_ID));
    const scope = await Effect.runPromise(Scope.make());
    const runtime = await Effect.runPromise(
      createGondolinAgentEnvironment({
        workspacePath,
        guestImage: await installLocalGuestImage(workingDirectory),
        sessionLabel: "openorb OO-016 hostile Git Snapshot test",
        github: {
          repositoryUrl: "https://github.com/meln1k/openorb-test-repo.git",
          gitAuthor: GIT_AUTHOR,
        },
        cpuCount: 1,
        memoryMiB: 1024,
      }).pipe(Effect.provideService(Scope.Scope, scope)),
    );

    try {
      await Effect.runPromise(runtime.writeFile(
        "hostile.sh",
        [
          "#!/bin/sh",
          `printf hostile > ${guestMarker}`,
          `printf hostile > ${hostMarker}`,
          "cat",
          "",
        ].join("\n"),
      ));
      let setupOutput = "";
      const initialized = await Effect.runPromise(runtime.run(
        ["/usr/bin/git", "init", "-q", "/workspace"],
        {
          cwd: ".",
          onOutput: (output) =>
            Effect.sync(() => {
              setupOutput = `${setupOutput}${output.text}`.slice(-4_096);
            }),
        },
      ));
      assertEquals(initialized.exitCode, 0, setupOutput);
      const setup = await Effect.runPromise(runtime.run([
        "/bin/sh",
        "-lc",
        [
          "set -eu",
          "cd /workspace",
          "git config user.name OpenOrb",
          "git config user.email openorb@example.invalid",
          "printf 'before\\n' > modified.txt",
          "printf 'delete\\n' > deleted.txt",
          "printf 'rename\\n' > renamed-old.txt",
          "printf 'stage\\n' > staged.txt",
          "printf '\\000\\001before' > binary.dat",
          "git add modified.txt deleted.txt renamed-old.txt staged.txt binary.dat",
          "git commit -qm base",
          "printf 'after\\n' > modified.txt",
          "rm deleted.txt",
          "mv renamed-old.txt renamed-new.txt",
          "git add renamed-old.txt renamed-new.txt",
          "printf 'staged after\\n' > staged.txt",
          "git add staged.txt",
          "printf 'added\\n' > added.txt",
          "git add added.txt",
          "printf 'untracked\\n' > untracked.txt",
          "printf 'literal\\n' > 'literal*.txt'",
          "printf 'ordinary\\n' > literal-other.txt",
          "control_path='control\nname.txt'",
          "printf 'control\\n' > \"$control_path\"",
          "printf '\\000\\002after' > binary.dat",
          "chmod +x hostile.sh",
          "mkdir -p .githooks",
          "cp hostile.sh .githooks/post-index-change",
          "git config core.hooksPath .githooks",
          "git config core.fsmonitor ./hostile.sh",
          "git config diff.external ./hostile.sh",
          "git config diff.hostile.command ./hostile.sh",
          "git config diff.hostile.textconv ./hostile.sh",
          "git config filter.hostile.clean ./hostile.sh",
          "git config filter.hostile.smudge ./hostile.sh",
          "printf '*.txt diff=hostile filter=hostile\\n' > .gitattributes",
          "mkdir -p .git/info",
          "printf '* diff=hostile filter=hostile\\n' > .git/info/attributes",
        ].join("\n"),
      ], {
        cwd: ".",
        onOutput: (output) =>
          Effect.sync(() => {
            setupOutput = `${setupOutput}${output.text}`.slice(-4_096);
          }),
      }));
      assertEquals(setup.exitCode, 0, setupOutput);
      let revision = "";
      await Effect.runPromise(runtime.run(["/usr/bin/git", "rev-parse", "HEAD"], {
        cwd: ".",
        onOutput: (output) =>
          Effect.sync(() => {
            if (output.stream === "stdout") revision += output.text;
          }),
      }));
      const metadata = await Effect.runPromise(store.updateProvisioning(SESSION_ID, {
        state: "running",
        checkoutState: "available",
        baseCommit: revision.trim(),
      }));
      const snapshotDiagnostics: string[] = [];
      const snapshotEnvironment: AgentEnvironment = {
        ...runtime,
        run: (command, options = {}) => {
          let outputText = "";
          return runtime.run(command, {
            ...options,
            onOutput: (output) =>
              Effect.all([
                Effect.sync(() => outputText += output.text),
                options.onOutput?.(output) ?? Effect.void,
              ], { discard: true }),
          }).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                snapshotDiagnostics.push(
                  `${result.exitCode}: ${command.join(" ")}\n${outputText.slice(-4_096)}`,
                );
              })
            ),
          );
        },
      };
      const snapshot = await Effect.runPromise(
        generateSessionGitSnapshot(snapshotEnvironment, metadata),
      );

      assertEquals(snapshot.completeness, "complete", snapshotDiagnostics.join("\n"));
      assertEquals(
        snapshot.sections.staged.files.find((file) => file.path === "added.txt")?.status,
        "added",
      );
      assertEquals(
        snapshot.sections.unstaged.files.find((file) => file.path === "deleted.txt")?.status,
        "deleted",
      );
      assertEquals(
        snapshot.sections.unstaged.files.find((file) => file.path === "modified.txt")?.status,
        "modified",
      );
      assertEquals(
        snapshot.sections.staged.files.find((file) => file.path === "renamed-new.txt")?.status,
        "renamed",
      );
      assertEquals(
        snapshot.sections.staged.files.find((file) => file.path === "staged.txt")?.status,
        "modified",
      );
      assertEquals(
        snapshot.sections.unstaged.files.find((file) => file.path === "untracked.txt")?.kind,
        "untracked",
      );
      assertEquals(
        snapshot.sections.unstaged.files.find((file) => file.path === "control\nname.txt")
          ?.displayPath,
        "control\\u{A}name.txt",
      );
      assertStringIncludes(snapshot.sections.unstaged.patch, "-before");
      assertStringIncludes(snapshot.sections.unstaged.patch, "+after");
      assertStringIncludes(snapshot.sections.unstaged.patch, "+untracked");
      assertEquals(snapshot.sections.unstaged.patch.includes("Binary files a/modified.txt"), false);
      assertEquals(
        snapshot.sections.unstaged.files.find((file) => file.path === "binary.dat")?.diffState,
        "binary",
      );
      assertStringIncludes(
        snapshot.sections.unstaged.patch,
        "Binary files a/binary.dat and b/binary.dat differ",
      );

      const literalPath = "literal*.txt";
      const stagedLiteral = await Effect.runPromise(
        updateSessionGitFile(snapshotEnvironment, metadata, {
          action: "stage",
          path: literalPath,
        }),
      );
      assert(stagedLiteral.ok, snapshotDiagnostics.join("\n"));
      let stagedPaths = "";
      await Effect.runPromise(runtime.run(
        ["/usr/bin/git", "diff", "--cached", "--name-only", "-z"],
        {
          cwd: ".",
          onOutput: (output) =>
            Effect.sync(() => {
              if (output.stream === "stdout") stagedPaths += output.text;
            }),
        },
      ));
      assert(stagedPaths.split("\0").includes(literalPath));
      assertEquals(stagedPaths.split("\0").includes("literal-other.txt"), false);

      const controlPath = "control\nname.txt";
      const stagedControl = await Effect.runPromise(
        updateSessionGitFile(snapshotEnvironment, metadata, {
          action: "stage",
          path: controlPath,
        }),
      );
      assert(stagedControl.ok, snapshotDiagnostics.join("\n"));
      let controlObjectId = "";
      const resolvedControl = await Effect.runPromise(runtime.run(
        ["/usr/bin/git", "rev-parse", `:${controlPath}`],
        {
          cwd: ".",
          onOutput: (output) =>
            Effect.sync(() => {
              if (output.stream === "stdout") controlObjectId += output.text;
            }),
        },
      ));
      assertEquals(resolvedControl.exitCode, 0);
      assert(/^[0-9a-f]{40,64}$/.test(controlObjectId.trim()));

      const staged = await Effect.runPromise(updateSessionGitFile(snapshotEnvironment, metadata, {
        action: "stage",
        path: "untracked.txt",
      }));
      assert(staged.ok, snapshotDiagnostics.join("\n"));
      let objectId = "";
      const resolved = await Effect.runPromise(runtime.run(
        ["/usr/bin/git", "rev-parse", ":untracked.txt"],
        {
          cwd: ".",
          onOutput: (output) =>
            Effect.sync(() => {
              if (output.stream === "stdout") objectId += output.text;
            }),
        },
      ));
      assertEquals(resolved.exitCode, 0);
      assert(/^[0-9a-f]{40,64}$/.test(objectId.trim()));
      const objectReadable = await Effect.runPromise(runtime.run([
        "/usr/bin/git",
        "cat-file",
        "-e",
        objectId.trim(),
      ], { cwd: "." }));
      assertEquals(objectReadable.exitCode, 0, "The staged Git object must remain readable.");
      await assertRejects(() => Deno.stat(hostMarker), Deno.errors.NotFound);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await Deno.remove(workingDirectory, { recursive: true });
    }
  },
});
