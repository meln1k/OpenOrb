import { basename } from "node:path";

import { VM, type VMOptions } from "@earendil-works/gondolin";
import { Effect, Layer, type Scope, Semaphore } from "effect";
import { type Result, trySync } from "@openorb/result";

import { type GuestImage, prepareGuestImageForVm } from "./guest-image/installer.ts";
import {
  initializeSessionRuntime,
  readSessionGuestImage,
  type SessionRuntimeOptions,
} from "./guest-image/session-runtime.ts";
import {
  createOpenOrbNetworkVmOptions,
  type OpenOrbGitHubMediationOptions,
} from "./network-mediation.ts";
import {
  assertPersistentRootDiskDetached,
  initializePersistentRootDisk,
  OPENORB_ROOT_DISK_SIZE,
  validatePersistentRootDisk,
} from "./persistent-root-disk.ts";
import {
  AGENT_WORKSPACE,
  type AgentEnvironment,
  AgentEnvironmentError,
  type AgentEnvironmentOptions,
  AgentEnvironmentProvider,
  type EnvironmentDaemon,
} from "../agent-environment.ts";

export const OPENORB_GUEST_MARKER = "OPENORB_GUEST";
/** The pinned pi-env daemon baked into the guest image. */
export const ENVIRONMENT_DAEMON_PATH = "/usr/local/libexec/openorb/pi-env";
const ENVIRONMENT_DAEMON_EXIT_GRACE_MS = 5_000;

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
  sessionRuntimeOptions: SessionRuntimeOptions = {},
): AgentEnvironmentProvider {
  return AgentEnvironmentProvider.of({
    initializeRootDisk: (path) =>
      Effect.gen(function* () {
        yield* fromLegacyResult(
          initializeSessionRuntime(path, guestImage),
          (cause) => new AgentEnvironmentError("The session runtime could not be recorded.", cause),
        );
        const pinnedImage = yield* fromLegacyResult(
          readSessionGuestImage(path, guestImage, sessionRuntimeOptions),
          (cause) => new AgentEnvironmentError("The session runtime could not be restored.", cause),
        );
        const imagePath = yield* fromLegacyResult(
          prepareGuestImageForVm(pinnedImage),
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
      Effect.gen(function* () {
        const pinnedImage = yield* fromLegacyResult(
          readSessionGuestImage(options.rootDiskPath, guestImage, sessionRuntimeOptions),
          (cause) => new AgentEnvironmentError("The session runtime could not be restored.", cause),
        );
        return yield* createGondolinAgentEnvironment({
          ...options,
          guestImage: pinnedImage,
          softwareEmulation,
        });
      }),
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
        options.environmentSecrets,
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
  environmentSecrets?: AgentEnvironmentOptions["environmentSecrets"],
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
      const networkOptions =
        github !== undefined || environmentSecrets !== undefined
          ? yield* fromLegacyResult(
              Promise.resolve(
                createOpenOrbNetworkVmOptions({
                  ...(github === undefined ? {} : { github }),
                  ...(environmentSecrets === undefined ? {} : { environmentSecrets }),
                }),
              ),
              (cause) =>
                new AgentEnvironmentError("Network mediation could not be configured.", cause),
            )
          : undefined;
      if (softwareEmulation && process.platform === "linux") {
        yield* Effect.logWarning("gondolin.software-emulation").pipe(
          Effect.annotateLogs({
            ...logAnnotations,
            reason: "KVM is unavailable; QEMU is starting with TCG software emulation.",
          }),
        );
      }
      const vm = yield* Effect.tryPromise({
        try: async () => {
          const [, rootDiskError] = await validatePersistentRootDisk(rootDiskPath, {
            backingPath: imagePath.rootfsPath,
            backingFormat: "raw",
          });
          if (rootDiskError !== undefined) throw rootDiskError;
          const vmOptions: VMOptions = {
            sessionLabel,
            cpus: cpuCount,
            memory: `${memoryMiB}M`,
            ...networkOptions,
            rootfs: {
              size: OPENORB_ROOT_DISK_SIZE,
            },
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
      const probe = yield* Effect.exit(
        Effect.tryPromise({
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
            if (process.platform === "linux" && !softwareEmulation) {
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
                const detail =
                  nestedKvmProbe.stderr.trim() ||
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
        }),
      );
      if (probe._tag === "Failure") {
        yield* closeVm(vm, rootDiskPath, "The failed Gondolin VM could not be closed.");
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
        return startVm.pipe(Effect.tap((started) => Effect.sync(() => (running = started))));
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
      const execution = yield* Effect.exit(
        Effect.tryPromise({
          try: async () => {
            let observerError: AgentEnvironmentError | undefined;
            const process = activeVm.vm.exec([...command], {
              cwd: options.cwd ?? AGENT_WORKSPACE,
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
        }),
      );
      if (execution._tag === "Failure") {
        if (options.signal?.aborted) return yield* aborted(options.signal.reason);
        return yield* Effect.failCause(execution.cause);
      }
      if (execution.value.observerError) return yield* execution.value.observerError;
      return { exitCode: execution.value.exitCode };
    });

    const startDaemon: AgentEnvironment["startDaemon"] = Effect.gen(function* () {
      const activeVm = yield* getVm;
      const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const controller = new AbortController();
      const process = yield* Effect.try({
        // A login shell gives the daemon's commands the guest profile environment; anything the
        // profile prints arrives before the daemon's sync line and is discarded as noise.
        try: () =>
          activeVm.vm.exec(
            [
              activeVm.shellPath,
              "-lc",
              `exec ${ENVIRONMENT_DAEMON_PATH} serve --token "$1"`,
              "pi-env",
              token,
            ],
            {
              cwd: "/",
              env: { [OPENORB_GUEST_MARKER]: "1" },
              signal: controller.signal,
              stdin: true,
              stdout: "pipe",
              stderr: "pipe",
            },
          ),
        catch: (cause) =>
          new AgentEnvironmentError("The Environment Daemon could not be started.", cause),
      });
      const exited = process.result.then(
        () => undefined,
        () => undefined,
      );
      async function* stdout(): AsyncGenerator<Uint8Array> {
        for await (const chunk of process.output()) {
          if (chunk.stream === "stdout") yield new Uint8Array(chunk.data);
          else console.warn(`Environment Daemon: ${chunk.text.trimEnd()}`);
        }
      }
      let closing: Promise<void> | undefined;
      const daemon: EnvironmentDaemon = {
        token,
        write: (bytes) => process.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)),
        stdout: stdout(),
        close: Effect.promise(
          () =>
            (closing ??= (async () => {
              // Ending stdin fails only when the daemon already exited.
              trySync(
                () => process.end(),
                () => undefined,
              );
              const timer = setTimeout(() => controller.abort(), ENVIRONMENT_DAEMON_EXIT_GRACE_MS);
              await exited;
              clearTimeout(timer);
            })()),
        ),
      };
      return daemon;
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
            }),
          ),
        );
      }),
    );

    return {
      start: getVm.pipe(Effect.asVoid),
      close,
      getVm,
      run,
      startDaemon,
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
    ...(process.platform === "linux"
      ? softwareEmulation
        ? { vmm: "qemu" as const, accel: "tcg" }
        : { vmm: "qemu" as const, accel: "kvm", cpu: "host" }
      : process.platform === "darwin"
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
      error === undefined ? Effect.succeed(value as A) : Effect.fail(onError(error)),
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
