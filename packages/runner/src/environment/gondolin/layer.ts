import { basename } from "node:path";

import { VM, type VMOptions } from "@earendil-works/gondolin";
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
  assertPersistentRootDiskDetached,
  initializePersistentRootDisk,
  validatePersistentRootDisk,
} from "./persistent-root-disk.ts";
import {
  AGENT_WORKSPACE,
  type AgentEnvironment,
  AgentEnvironmentError,
  type AgentEnvironmentOptions,
  AgentEnvironmentProvider,
  resolveAgentPath,
} from "../agent-environment.ts";

export const OPENORB_GUEST_MARKER = "OPENORB_GUEST";
export const MAX_GUEST_FILE_BYTES = 16 * 1024 * 1024;
const GUEST_FILE_READ_TIMEOUT_MS = 30_000;

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
    initializeRootDisk: (path) =>
      Effect.gen(function* () {
        const imagePath = yield* fromLegacyResult(
          prepareGuestImageForVm(guestImage),
          (cause) => new AgentEnvironmentError("The guest image could not be prepared.", cause),
        );
        yield* fromLegacyResult(
          initializePersistentRootDisk({
            path,
            backingPath: imagePath.rootfsPath,
            backingFormat: "raw",
          }),
          (cause) =>
            new AgentEnvironmentError("The persistent root disk could not be created.", cause),
        );
      }),
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
      const environment = yield* makeGondolinEnvironment(
        options.rootDiskPath,
        options.guestImage,
        options.cpuCount,
        options.memoryMiB,
        options.sessionLabel,
        options.github,
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
  rootDiskPath: string,
  guestImage: GuestImage,
  cpuCount: number,
  memoryMiB: number,
  sessionLabel = `openorb ${basename(rootDiskPath)}`,
  github?: OpenOrbGitHubMediationOptions,
  sessionId?: string,
  softwareEmulation = false,
): Effect.Effect<GondolinEnvironmentInternals> {
  return Effect.gen(function* () {
    const gate = yield* Semaphore.make(1);
    // Command failures never clear this reference. Only explicit lifecycle cleanup owns the VM.
    let running: RunningVm | undefined;
    let closing = false;
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
        try: async () => {
          installGondolinTlsCompatibility();
          const [, rootDiskError] = await validatePersistentRootDisk(rootDiskPath);
          if (rootDiskError !== undefined) throw rootDiskError;
          const vmOptions: VMOptions = {
            sessionLabel,
            cpus: cpuCount,
            memory: `${memoryMiB}M`,
            ...githubOptions,
            sandbox: {
              ...createOpenOrbGondolinSandboxOptions(imagePath, softwareEmulation),
              rootDiskPath,
              rootDiskFormat: "qcow2",
              rootDiskDeleteOnClose: false,
            },
            vfs: {},
          };
          return await VM.create(vmOptions);
        },
        catch: (cause) => new AgentEnvironmentError("The Gondolin VM could not be created.", cause),
      });
      const probe = yield* Effect.exit(Effect.tryPromise({
        try: async () => {
          const workspace = await vm.exec([
            "/usr/bin/mkdir",
            "-p",
            "-m",
            "0700",
            "--",
            AGENT_WORKSPACE,
          ]);
          if (!workspace.ok) {
            throw new AgentEnvironmentError(
              "The persistent guest workspace could not be prepared.",
              undefined,
            );
          }
          const workspacePermissions = await vm.exec([
            "/usr/bin/chmod",
            "0700",
            "--",
            AGENT_WORKSPACE,
          ]);
          if (!workspacePermissions.ok) {
            throw new AgentEnvironmentError(
              "The persistent guest workspace permissions could not be set.",
              undefined,
            );
          }
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
        yield* closeVm(
          vm,
          rootDiskPath,
          "The failed Gondolin VM could not be closed.",
        );
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
        if (closing || closed) {
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
      function* (path, options = {}) {
        if (options.signal?.aborted) return yield* aborted(options.signal.reason);
        const activeVm = yield* getVm;
        const resolvedPath = resolveAgentPath(path);
        const read = yield* Effect.exit(Effect.tryPromise({
          try: async () => {
            const regularFile = await activeVm.vm.exec(["/usr/bin/test", "-f", resolvedPath]);
            if (!regularFile.ok) {
              throw new AgentEnvironmentError("Guest file could not be read.", undefined);
            }
            const controller = new AbortController();
            const abort = () => controller.abort(options.signal?.reason);
            options.signal?.addEventListener("abort", abort, { once: true });
            using cleanup = new DisposableStack();
            cleanup.defer(() => options.signal?.removeEventListener("abort", abort));
            const timer = setTimeout(() => controller.abort(), GUEST_FILE_READ_TIMEOUT_MS);
            cleanup.defer(() => clearTimeout(timer));

            const chunks: Uint8Array[] = [];
            let byteLength = 0;
            let oversized = false;
            const process = activeVm.vm.exec([
              "/usr/bin/head",
              "-c",
              String(MAX_GUEST_FILE_BYTES + 1),
              "--",
              resolvedPath,
            ], {
              signal: controller.signal,
              stdout: "pipe",
              stderr: "ignore",
            });
            for await (const chunk of process.output()) {
              if (chunk.stream !== "stdout") continue;
              byteLength += chunk.data.byteLength;
              if (byteLength > MAX_GUEST_FILE_BYTES) {
                oversized = true;
                continue;
              }
              chunks.push(chunk.data);
            }
            const result = await process;
            if (oversized) {
              throw new AgentEnvironmentError(
                `Guest file exceeds the ${MAX_GUEST_FILE_BYTES}-byte read limit.`,
                undefined,
              );
            }
            if (!result.ok) {
              throw new AgentEnvironmentError("Guest file could not be read.", undefined);
            }
            const content = new Uint8Array(byteLength);
            let offset = 0;
            for (const chunk of chunks) {
              content.set(chunk, offset);
              offset += chunk.byteLength;
            }
            return content;
          },
          catch: (cause) =>
            cause instanceof AgentEnvironmentError
              ? cause
              : new AgentEnvironmentError("Guest file could not be read.", cause),
        }));
        if (read._tag === "Failure") {
          if (options.signal?.aborted) return yield* aborted(options.signal.reason);
          return yield* Effect.failCause(read.cause);
        }
        return read.value;
      },
    );
    const access: AgentEnvironment["access"] = Effect.fn("AgentEnvironment.access")(
      function* (path) {
        const activeVm = yield* getVm;
        yield* Effect.tryPromise({
          try: async () => {
            const result = await activeVm.vm.exec([
              "/usr/bin/test",
              "-e",
              resolveAgentPath(path),
            ]);
            if (!result.ok) {
              throw new AgentEnvironmentError("Guest file could not be accessed.", undefined);
            }
          },
          catch: (cause) => new AgentEnvironmentError("Guest file could not be accessed.", cause),
        });
      },
    );
    const writeFile: AgentEnvironment["writeFile"] = Effect.fn("AgentEnvironment.writeFile")(
      function* (path, content) {
        const activeVm = yield* getVm;
        yield* Effect.tryPromise({
          try: async () => {
            const result = await activeVm.vm.exec(
              ["/usr/bin/tee", "--", resolveAgentPath(path)],
              { stdin: content, stdout: "ignore" },
            );
            if (!result.ok) {
              throw new AgentEnvironmentError("Guest file could not be written.", undefined);
            }
          },
          catch: (cause) => new AgentEnvironmentError("Guest file could not be written.", cause),
        });
      },
    );
    const makeDirectory: AgentEnvironment["makeDirectory"] = Effect.fn(
      "AgentEnvironment.makeDirectory",
    )(function* (path) {
      const activeVm = yield* getVm;
      yield* Effect.tryPromise({
        try: async () => {
          const result = await activeVm.vm.exec([
            "/usr/bin/mkdir",
            "-p",
            "--",
            resolveAgentPath(path),
          ]);
          if (!result.ok) {
            throw new AgentEnvironmentError("Guest directory could not be created.", undefined);
          }
        },
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

    const close = gate.withPermit(
      Effect.suspend(() => {
        if (closed) return Effect.void;
        closing = true;
        const activeVm = running;
        if (activeVm === undefined) {
          closed = true;
          return Effect.void;
        }
        return closeVm(activeVm.vm, rootDiskPath, "The Gondolin VM could not be closed.").pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              closed = true;
              running = undefined;
            })
          ),
        );
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
      stop: close,
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

function closeVm(
  vm: VM,
  rootDiskPath: string,
  message: string,
): Effect.Effect<void, AgentEnvironmentError> {
  return Effect.tryPromise({
    try: () => vm.close(),
    catch: (cause) => new AgentEnvironmentError(message, cause),
  }).pipe(
    Effect.andThen(
      fromLegacyResult(
        assertPersistentRootDiskDetached(rootDiskPath),
        (cause) =>
          new AgentEnvironmentError(
            "The persistent root disk could not be confirmed detached.",
            cause,
          ),
      ),
    ),
  );
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
