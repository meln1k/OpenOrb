import { basename, isAbsolute, resolve } from "node:path";

import { RealFSProvider, VM, VmCheckpoint, type VMOptions } from "@earendil-works/gondolin";
import { Effect, Layer, type Scope, Semaphore } from "effect";
import type { Result } from "@openorb/result";

import { type GuestImage, prepareGuestImageForVm } from "./guest-image/installer.ts";
import {
  createOpenOrbGitHubVmOptions,
  type OpenOrbGitHubMediationOptions,
} from "./github-mediation.ts";
import { installGondolinTlsCompatibility } from "./tls-compatibility.ts";
import { shellWaitTimeoutMs } from "./shell-timeout.ts";
import {
  AGENT_WORKSPACE,
  type AgentEnvironment,
  type AgentEnvironmentBackend,
  type AgentEnvironmentCheckpoint,
  AgentEnvironmentCheckpointError,
  AgentEnvironmentError,
  type AgentEnvironmentOptions,
  AgentEnvironmentProvider,
  resolveAgentPath,
} from "../agent-environment.ts";

export const OPENORB_GUEST_MARKER = "OPENORB_GUEST";

export interface GondolinAgentEnvironmentConfig extends AgentEnvironmentOptions {
  readonly guestImage: GuestImage;
  /** Use QEMU's software accelerator when KVM is unavailable. */
  readonly softwareEmulation?: boolean;
}

interface RunningVm {
  readonly vm: VM;
  readonly shellPath: string;
}

interface GondolinEnvironmentInternals extends AgentEnvironment {
  readonly start: Effect.Effect<void, AgentEnvironmentError>;
  readonly close: Effect.Effect<void, AgentEnvironmentError>;
  readonly getVm: Effect.Effect<RunningVm, AgentEnvironmentError>;
}

export function makeGondolinAgentEnvironmentProvider(
  guestImage: GuestImage,
  softwareEmulation = false,
): AgentEnvironmentProvider {
  return AgentEnvironmentProvider.of({
    make: (options) =>
      createGondolinAgentEnvironment({ ...options, guestImage, softwareEmulation }),
  });
}

export function gondolinAgentEnvironmentProviderLayer(
  guestImage: GuestImage,
  softwareEmulation = false,
): Layer.Layer<AgentEnvironmentProvider> {
  return Layer.succeed(
    AgentEnvironmentProvider,
    makeGondolinAgentEnvironmentProvider(guestImage, softwareEmulation),
  );
}

export function createGondolinAgentEnvironment(
  options: GondolinAgentEnvironmentConfig,
): Effect.Effect<AgentEnvironment, AgentEnvironmentError, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const workspace = yield* Effect.tryPromise({
        try: () => Deno.lstat(options.workspacePath),
        catch: (cause) =>
          new AgentEnvironmentError("The agent workspace could not be inspected.", cause),
      });
      if (!workspace.isDirectory || workspace.isSymlink) {
        return yield* new AgentEnvironmentError(
          "The agent workspace must be a real host directory.",
          undefined,
        );
      }
      const workspacePath = yield* Effect.tryPromise({
        try: () => Deno.realPath(options.workspacePath),
        catch: (cause) =>
          new AgentEnvironmentError("The agent environment could not be created.", cause),
      });
      const environment = yield* makeGondolinEnvironment(
        workspacePath,
        options.guestImage,
        options.cpuCount,
        options.memoryMiB,
        options.sessionLabel,
        options.github,
        options.resumeCheckpoint,
        options.sessionId,
        options.softwareEmulation,
      );
      yield* environment.start;
      return environment;
    }),
    (environment) => environment.close.pipe(Effect.orDie),
  );
}

function makeGondolinEnvironment(
  workspacePath: string,
  guestImage: GuestImage,
  cpuCount: number,
  memoryMiB: number,
  sessionLabel = `openorb ${basename(workspacePath)}`,
  github?: OpenOrbGitHubMediationOptions,
  resumeCheckpoint?: AgentEnvironmentCheckpoint,
  sessionId?: string,
  softwareEmulation = false,
): Effect.Effect<GondolinEnvironmentInternals> {
  return Effect.gen(function* () {
    const gate = yield* Semaphore.make(1);
    // Command failures never clear this reference. Only explicit lifecycle cleanup owns the VM.
    let running: RunningVm | undefined;
    let closed = false;
    const logAnnotations = {
      component: "openorb-runner",
      sessionLabel,
      ...(sessionId === undefined ? {} : { sessionId }),
    };

    const startVm: Effect.Effect<RunningVm, AgentEnvironmentError> = Effect.gen(function* () {
      const imagePath = yield* fromLegacyResult(
        prepareGuestImageForVm(guestImage),
        (cause) => new AgentEnvironmentError("The guest image could not be prepared.", cause),
      );
      const githubOptions = github
        ? yield* fromLegacyResult(
          Promise.resolve(createOpenOrbGitHubVmOptions(github)),
          (cause) => new AgentEnvironmentError("GitHub mediation could not be configured.", cause),
        )
        : undefined;
      if (softwareEmulation && Deno.build.os === "linux") {
        yield* Effect.logWarning("gondolin.software-emulation").pipe(
          Effect.annotateLogs({
            ...logAnnotations,
            reason: "KVM is unavailable; QEMU is starting with TCG software emulation.",
          }),
        );
      }
      const vm = yield* Effect.tryPromise({
        try: () => {
          installGondolinTlsCompatibility();
          const vmOptions: VMOptions = {
            sessionLabel,
            cpus: cpuCount,
            memory: `${memoryMiB}M`,
            rootfs: { mode: "cow" },
            ...githubOptions,
            sandbox: createOpenOrbGondolinSandboxOptions(imagePath, softwareEmulation),
            vfs: {
              mounts: {
                [AGENT_WORKSPACE]: new RealFSProvider(workspacePath),
              },
            },
          };
          if (resumeCheckpoint) {
            const checkpoint = loadCheckpoint(resumeCheckpoint, guestImage);
            return checkpoint.resume<VM>(vmOptions);
          }
          return VM.create(vmOptions);
        },
        catch: (cause) =>
          new AgentEnvironmentError(
            resumeCheckpoint
              ? "The Gondolin checkpoint could not be resumed."
              : "The Gondolin VM could not be created.",
            cause,
          ),
      });
      const probe = yield* Effect.exit(Effect.tryPromise({
        try: async () => {
          let nestedKvmWarning: string | undefined;
          if (Deno.build.os === "linux" && !softwareEmulation) {
            const nestedKvmProbe = await vm.exec([
              "/bin/sh",
              "-lc",
              [
                "set -eu",
                'case "$(uname -m)" in',
                "  x86_64)",
                "    if grep -qw vmx /proc/cpuinfo; then",
                "      modprobe kvm_intel",
                "    elif grep -qw svm /proc/cpuinfo; then",
                "      modprobe kvm_amd",
                "    else",
                '      echo "the guest CPU does not expose VMX or SVM" >&2',
                "      exit 1",
                "    fi",
                "    ;;",
                "  aarch64)",
                "    ;;",
                "  *)",
                '    echo "unsupported nested-KVM guest architecture: $(uname -m)" >&2',
                "    exit 1",
                "    ;;",
                "esac",
                'test -c /dev/kvm || { echo "nested KVM did not create /dev/kvm" >&2; exit 1; }',
                '/usr/bin/python3 -c \'import fcntl, os; fd = os.open("/dev/kvm", os.O_RDWR); assert fcntl.ioctl(fd, 0xAE00) == 12\' || { echo "nested KVM rejected KVM_GET_API_VERSION" >&2; exit 1; }',
              ].join("\n"),
            ]);
            if (!nestedKvmProbe.ok) {
              const detail = nestedKvmProbe.stderr.trim() ||
                `initialization exited with status ${nestedKvmProbe.exitCode}`;
              nestedKvmWarning = `Nested KVM is unavailable in the Gondolin guest: ${detail}`;
            }
          }
          const shellProbe = await vm.exec(["/bin/sh", "-lc", "command -v bash || true"]);
          if (closed) {
            throw new AgentEnvironmentError(
              "The agent environment was closed during startup.",
              undefined,
            );
          }
          return {
            running: { vm, shellPath: shellProbe.stdout.trim() || "/bin/sh" },
            nestedKvmWarning,
          };
        },
        catch: (cause) =>
          cause instanceof AgentEnvironmentError
            ? cause
            : new AgentEnvironmentError("The Gondolin VM startup probe failed.", cause),
      }));
      if (probe._tag === "Failure") {
        yield* closeVm(vm, "The failed Gondolin VM could not be closed.");
        return yield* Effect.failCause(probe.cause);
      }
      if (probe.value.nestedKvmWarning) {
        yield* Effect.logWarning("nested-kvm.unavailable").pipe(
          Effect.annotateLogs({
            component: "openorb-runner",
            sessionLabel,
            reason: probe.value.nestedKvmWarning,
          }),
        );
      }
      yield* Effect.logInfo("gondolin.vm.started").pipe(
        Effect.annotateLogs({ ...logAnnotations, gondolinId: vm.id }),
      );
      return probe.value.running;
    });

    const getVm = gate.withPermit(
      Effect.suspend(() => {
        if (closed) {
          return Effect.fail(
            new AgentEnvironmentError("The agent environment is closed.", undefined),
          );
        }
        if (running) return Effect.succeed(running);
        return startVm.pipe(Effect.tap((started) => Effect.sync(() => running = started)));
      }),
    );

    const run: AgentEnvironment["run"] = Effect.fn("AgentEnvironment.run")(function* (
      command,
      options = {},
    ) {
      if (command.length === 0 || !command[0]?.startsWith("/")) {
        return yield* new AgentEnvironmentError(
          "Guest commands require an absolute executable path.",
          undefined,
        );
      }
      if (options.signal?.aborted) {
        return yield* aborted(options.signal.reason);
      }
      const activeVm = yield* getVm;
      if (options.signal?.aborted) {
        return yield* aborted(options.signal.reason);
      }
      const execution = yield* Effect.exit(Effect.tryPromise({
        try: async () => {
          let observerError: AgentEnvironmentError | undefined;
          const process = activeVm.vm.exec([...command], {
            cwd: options.cwd === undefined ? AGENT_WORKSPACE : resolveAgentPath(options.cwd),
            env: { [OPENORB_GUEST_MARKER]: "1" },
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            stdout: "pipe",
            stderr: "pipe",
          });
          for await (const chunk of process.output()) {
            if (!observerError && options.onOutput) {
              observerError = await runObserver(
                options.onOutput({ stream: chunk.stream, text: chunk.text }),
              );
            }
          }
          const exitCode = (await process).exitCode;
          return { exitCode, observerError };
        },
        catch: (cause) => new AgentEnvironmentError("Guest command execution failed.", cause),
      }));
      if (execution._tag === "Failure") {
        if (options.signal?.aborted) return yield* aborted(options.signal.reason);
        return yield* Effect.failCause(execution.cause);
      }
      if (execution.value.observerError) return yield* execution.value.observerError;
      return { exitCode: execution.value.exitCode };
    });

    const runShell: AgentEnvironment["runShell"] = Effect.fn("AgentEnvironment.runShell")(
      function* (command, options) {
        const timeoutSeconds = options.timeoutSeconds;
        const waitTimeoutMs = yield* shellWaitTimeoutMs(timeoutSeconds);
        if (options.signal?.aborted) return yield* aborted(options.signal.reason);
        const activeVm = yield* getVm;
        if (options.signal?.aborted) return yield* aborted(options.signal.reason);
        let waitTimedOut = false;
        const execution = yield* Effect.exit(Effect.tryPromise({
          try: async () => {
            const controller = new AbortController();
            const abort = () => controller.abort(options.signal?.reason);
            options.signal?.addEventListener("abort", abort, { once: true });
            using cleanup = new DisposableStack();
            cleanup.defer(() => options.signal?.removeEventListener("abort", abort));
            // Allow the guest's one-second kill grace plus one second for output draining.
            // Gondolin abort only abandons the host wait: surviving descendants are accepted.
            if (waitTimeoutMs !== undefined) {
              const timer = setTimeout(() => {
                waitTimedOut = true;
                controller.abort();
              }, waitTimeoutMs);
              cleanup.defer(() => clearTimeout(timer));
            }
            // Guest process-group cleanup is best effort; never reset the VM for a timeout.
            const shellCommand = [activeVm.shellPath, "-lc", command];
            const process = activeVm.vm.exec(
              timeoutSeconds === undefined ? shellCommand : [
                "/usr/bin/timeout",
                "--kill-after=1s",
                `${timeoutSeconds}s`,
                ...shellCommand,
              ],
              {
                cwd: resolveAgentPath(options.cwd),
                env: { [OPENORB_GUEST_MARKER]: "1" },
                signal: controller.signal,
                stdout: "pipe",
                stderr: "pipe",
              },
            );
            for await (const chunk of process.output()) {
              const observerError = await runObserver(options.onOutput(chunk.data));
              if (observerError) throw observerError;
            }
            return { exitCode: (await process).exitCode };
          },
          catch: (cause) =>
            new AgentEnvironmentError("Guest shell command execution failed.", cause),
        }));
        if (execution._tag === "Failure") {
          if (waitTimedOut && waitTimeoutMs !== undefined && !options.signal?.aborted) {
            return yield* new AgentEnvironmentError(
              `Stopped waiting after ${
                waitTimeoutMs / 1000
              } seconds. The VM was preserved; command descendants may still be running.`,
              undefined,
            );
          }
          if (options.signal?.aborted) return yield* aborted(options.signal.reason);
          return yield* Effect.failCause(execution.cause);
        }
        return { exitCode: execution.value.exitCode };
      },
    );

    const readFile: AgentEnvironment["readFile"] = Effect.fn("AgentEnvironment.readFile")(
      function* (path) {
        const activeVm = yield* getVm;
        return yield* Effect.tryPromise({
          try: () => activeVm.vm.fs.readFile(resolveAgentPath(path)),
          catch: (cause) => new AgentEnvironmentError("Guest file could not be read.", cause),
        });
      },
    );
    const access: AgentEnvironment["access"] = Effect.fn("AgentEnvironment.access")(
      function* (path) {
        const activeVm = yield* getVm;
        yield* Effect.tryPromise({
          try: () => activeVm.vm.fs.access(resolveAgentPath(path)),
          catch: (cause) => new AgentEnvironmentError("Guest file could not be accessed.", cause),
        });
      },
    );
    const writeFile: AgentEnvironment["writeFile"] = Effect.fn("AgentEnvironment.writeFile")(
      function* (path, content) {
        const activeVm = yield* getVm;
        yield* Effect.tryPromise({
          try: () =>
            activeVm.vm.fs.writeFile(resolveAgentPath(path), content, {
              encoding: "utf8",
            }),
          catch: (cause) => new AgentEnvironmentError("Guest file could not be written.", cause),
        });
      },
    );
    const makeDirectory: AgentEnvironment["makeDirectory"] = Effect.fn(
      "AgentEnvironment.makeDirectory",
    )(function* (path) {
      const activeVm = yield* getVm;
      yield* Effect.tryPromise({
        try: () => activeVm.vm.fs.mkdir(resolveAgentPath(path), { recursive: true }),
        catch: (cause) => new AgentEnvironmentError("Guest directory could not be created.", cause),
      });
    });
    const detectImageMimeType: AgentEnvironment["detectImageMimeType"] = (path) =>
      Effect.sync(() => {
        const extension = path.toLowerCase().match(/\.[^.\/]+$/)?.[0];
        switch (extension) {
          case ".png":
            return "image/png";
          case ".jpg":
          case ".jpeg":
            return "image/jpeg";
          case ".gif":
            return "image/gif";
          case ".webp":
            return "image/webp";
          default:
            return null;
        }
      });

    const checkpoint: AgentEnvironment["checkpoint"] = (checkpointPath) =>
      gate.withPermit(Effect.suspend(() => {
        if (!isAbsolute(checkpointPath)) {
          return Effect.fail(
            new AgentEnvironmentCheckpointError(
              "The checkpoint path must be absolute.",
              undefined,
              false,
            ),
          );
        }
        if (closed || !running) {
          return Effect.fail(
            new AgentEnvironmentCheckpointError(
              "The agent environment is not running.",
              undefined,
              false,
            ),
          );
        }
        const activeVm = running.vm;
        closed = true;
        running = undefined;
        return Effect.tryPromise({
          try: async () => {
            await activeVm.checkpoint(checkpointPath);
            const loaded = VmCheckpoint.load(checkpointPath);
            if (loaded.path !== resolve(checkpointPath)) {
              throw new AgentEnvironmentError(
                "Gondolin returned a checkpoint at an unexpected path.",
                undefined,
              );
            }
            if (loaded.guestAssetBuildId !== guestImage.gondolinBuildId) {
              throw new AgentEnvironmentError(
                "The checkpoint guest build ID does not match the pinned image.",
                undefined,
              );
            }
            return checkpointDetails(loaded);
          },
          catch: (cause) =>
            new AgentEnvironmentCheckpointError(
              "The Gondolin VM could not be checkpointed.",
              cause,
              true,
            ),
        });
      }));

    const close = gate.withPermit(
      Effect.suspend(() => {
        if (closed) return Effect.void;
        closed = true;
        const activeVm = running;
        running = undefined;
        return activeVm
          ? closeVm(activeVm.vm, "The Gondolin VM could not be closed.")
          : Effect.void;
      }),
    );

    return {
      start: getVm.pipe(Effect.asVoid),
      close,
      getVm,
      run,
      runShell,
      readFile,
      access,
      writeFile,
      makeDirectory,
      detectImageMimeType,
      checkpoint,
    };
  });
}

export function createOpenOrbGondolinSandboxOptions(
  imagePath: NonNullable<NonNullable<VMOptions["sandbox"]>["imagePath"]>,
  softwareEmulation = false,
): NonNullable<VMOptions["sandbox"]> {
  return {
    imagePath,
    // Pin Linux guests to host CPU features so VMX/SVM reaches the guest when host KVM nesting is
    // enabled. The temporary macOS harness continues to use HVF without nested virtualization.
    ...(Deno.build.os === "linux"
      ? softwareEmulation
        ? { vmm: "qemu" as const, accel: "tcg" }
        : { vmm: "qemu" as const, accel: "kvm", cpu: "host" }
      : Deno.build.os === "darwin"
      ? { accel: "hvf" }
      : {}),
  };
}

function loadCheckpoint(
  expected: AgentEnvironmentCheckpoint,
  guestImage: GuestImage,
): VmCheckpoint {
  const checkpoint = VmCheckpoint.load(expected.path);
  const actual = checkpointDetails(checkpoint);
  if (
    actual.guestAssetBuildId !== guestImage.gondolinBuildId ||
    actual.guestAssetBuildId !== expected.guestAssetBuildId ||
    actual.createdWithVmm !== expected.createdWithVmm ||
    actual.compatibleVmm.length !== expected.compatibleVmm.length ||
    actual.compatibleVmm.some((backend, index) => backend !== expected.compatibleVmm[index])
  ) {
    throw new AgentEnvironmentError(
      "The checkpoint metadata does not match runner metadata.",
      undefined,
    );
  }
  return checkpoint;
}

function checkpointDetails(checkpoint: VmCheckpoint): AgentEnvironmentCheckpoint {
  const data = checkpoint.toJSON();
  const createdWithVmm = checkpointBackend(data.createdWithVmm);
  const compatibleVmm = data.compatibleVmm?.map(checkpointBackend).filter(
    (backend): backend is AgentEnvironmentBackend => backend !== undefined,
  ) ?? [];
  if (data.snapshotKind !== "disk" || compatibleVmm.length === 0) {
    throw new AgentEnvironmentError("The Gondolin checkpoint metadata is invalid.", undefined);
  }
  return {
    path: checkpoint.path,
    guestAssetBuildId: checkpoint.guestAssetBuildId,
    ...(createdWithVmm === undefined ? {} : { createdWithVmm }),
    compatibleVmm,
  };
}

function checkpointBackend(value: unknown): AgentEnvironmentBackend | undefined {
  return value === "qemu" || value === "krun" ? value : undefined;
}

function closeVm(vm: VM, message: string): Effect.Effect<void, AgentEnvironmentError> {
  return Effect.tryPromise({
    try: () => vm.close(),
    catch: (cause) => new AgentEnvironmentError(message, cause),
  });
}

function fromLegacyResult<A, E>(
  result: Promise<Result<A, E>>,
  onError: (error: E) => AgentEnvironmentError,
): Effect.Effect<A, AgentEnvironmentError> {
  return Effect.promise(() => result).pipe(
    Effect.flatMap(([value, error]) =>
      // SAFETY: Result guarantees a value when its error slot is undefined.
      error === undefined ? Effect.succeed(value as A) : Effect.fail(onError(error))
    ),
  );
}

async function runObserver(
  effect: Effect.Effect<void, unknown>,
): Promise<AgentEnvironmentError | undefined> {
  return await Effect.runPromise(effect).then(
    () => undefined,
    (cause) => new AgentEnvironmentError("Guest output handling failed.", cause),
  );
}

function aborted(cause: unknown): AgentEnvironmentError {
  return new AgentEnvironmentError("Command aborted.", cause);
}
