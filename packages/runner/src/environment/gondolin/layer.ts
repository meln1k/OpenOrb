import { basename } from "node:path";

import { RealFSProvider, VM } from "@earendil-works/gondolin";
import { Effect, Layer, type Scope, Semaphore } from "effect";
import type { Result } from "@openorb/result";

import { type DeveloperImage, prepareDeveloperImageForVm } from "./developer-image/installer.ts";
import {
  createOpenOrbGitHubVmOptions,
  type OpenOrbGitHubMediationOptions,
} from "./github-mediation.ts";
import { installGondolinTlsCompatibility } from "./tls-compatibility.ts";
import {
  AGENT_WORKSPACE,
  type AgentEnvironment,
  AgentEnvironmentError,
  type AgentEnvironmentOptions,
  AgentEnvironmentProvider,
  resolveAgentWorkspacePath,
} from "../agent-environment.ts";

export const OPENORB_GUEST_MARKER = "OPENORB_GUEST";

export interface GondolinAgentEnvironmentConfig extends AgentEnvironmentOptions {
  readonly developerImage: DeveloperImage;
}

interface RunningVm {
  readonly vm: VM;
  readonly shellPath: string;
}

interface GondolinEnvironmentInternals extends AgentEnvironment {
  readonly start: Effect.Effect<void, AgentEnvironmentError>;
  readonly close: Effect.Effect<void, AgentEnvironmentError>;
  readonly getVm: Effect.Effect<RunningVm, AgentEnvironmentError>;
  readonly discard: (running: RunningVm) => Effect.Effect<void, AgentEnvironmentError>;
}

export function makeGondolinAgentEnvironmentProvider(
  developerImage: DeveloperImage,
): AgentEnvironmentProvider {
  return AgentEnvironmentProvider.of({
    make: (options) => createGondolinAgentEnvironment({ ...options, developerImage }),
  });
}

export function gondolinAgentEnvironmentProviderLayer(
  developerImage: DeveloperImage,
): Layer.Layer<AgentEnvironmentProvider> {
  return Layer.succeed(
    AgentEnvironmentProvider,
    makeGondolinAgentEnvironmentProvider(developerImage),
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
        options.developerImage,
        options.cpuCount,
        options.memoryMiB,
        options.sessionLabel,
        options.github,
      );
      yield* environment.start;
      return environment;
    }),
    (environment) => environment.close.pipe(Effect.orDie),
  );
}

function makeGondolinEnvironment(
  workspacePath: string,
  developerImage: DeveloperImage,
  cpuCount: number,
  memoryMiB: number,
  sessionLabel = `openorb ${basename(workspacePath)}`,
  github?: OpenOrbGitHubMediationOptions,
): Effect.Effect<GondolinEnvironmentInternals> {
  return Effect.gen(function* () {
    const gate = yield* Semaphore.make(1);
    let running: RunningVm | undefined;
    let closed = false;

    const startVm: Effect.Effect<RunningVm, AgentEnvironmentError> = Effect.gen(function* () {
      const imagePath = yield* fromLegacyResult(
        prepareDeveloperImageForVm(developerImage),
        (cause) => new AgentEnvironmentError("The developer image could not be prepared.", cause),
      );
      const githubOptions = github
        ? yield* fromLegacyResult(
          Promise.resolve(createOpenOrbGitHubVmOptions(github)),
          (cause) => new AgentEnvironmentError("GitHub mediation could not be configured.", cause),
        )
        : undefined;
      const vm = yield* Effect.tryPromise({
        try: () => {
          if (githubOptions) installGondolinTlsCompatibility();
          return VM.create({
            sessionLabel,
            cpus: cpuCount,
            memory: `${memoryMiB}M`,
            rootfs: { mode: "cow" },
            ...githubOptions,
            sandbox: { imagePath },
            vfs: {
              mounts: {
                [AGENT_WORKSPACE]: new RealFSProvider(workspacePath),
              },
            },
          });
        },
        catch: (cause) => new AgentEnvironmentError("The Gondolin VM could not be created.", cause),
      });
      const probe = yield* Effect.exit(Effect.tryPromise({
        try: async () => {
          const shellProbe = await vm.exec(["/bin/sh", "-lc", "command -v bash || true"]);
          if (closed) {
            throw new AgentEnvironmentError(
              "The agent environment was closed during startup.",
              undefined,
            );
          }
          return { vm, shellPath: shellProbe.stdout.trim() || "/bin/sh" };
        },
        catch: (cause) => new AgentEnvironmentError("The Gondolin VM shell probe failed.", cause),
      }));
      if (probe._tag === "Failure") {
        yield* closeVm(vm, "The failed Gondolin VM could not be closed.");
        return yield* Effect.failCause(probe.cause);
      }
      return probe.value;
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

    const discard = (discarded: RunningVm): Effect.Effect<void, AgentEnvironmentError> =>
      gate.withPermit(Effect.suspend(() => {
        if (running !== discarded) return Effect.void;
        running = undefined;
        return closeVm(discarded.vm, "The Gondolin VM could not be discarded.");
      }));

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
            cwd: options.cwd === undefined
              ? AGENT_WORKSPACE
              : resolveAgentWorkspacePath(options.cwd),
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
        yield* discard(activeVm);
        if (options.signal?.aborted) return yield* aborted(options.signal.reason);
        return yield* Effect.failCause(execution.cause);
      }
      if (execution.value.observerError) return yield* execution.value.observerError;
      return { exitCode: execution.value.exitCode };
    });

    const runShell: AgentEnvironment["runShell"] = Effect.fn("AgentEnvironment.runShell")(
      function* (command, options) {
        if (options.signal?.aborted) return yield* aborted(options.signal.reason);
        const activeVm = yield* getVm;
        if (options.signal?.aborted) return yield* aborted(options.signal.reason);
        let timedOut = false;
        const execution = yield* Effect.exit(Effect.tryPromise({
          try: async () => {
            const controller = new AbortController();
            const abort = () => controller.abort(options.signal?.reason);
            options.signal?.addEventListener("abort", abort, { once: true });
            const timeoutHandle = options.timeoutSeconds && options.timeoutSeconds > 0
              ? setTimeout(() => {
                timedOut = true;
                controller.abort();
              }, options.timeoutSeconds * 1000)
              : undefined;
            using cleanup = new DisposableStack();
            cleanup.defer(() => {
              if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
              options.signal?.removeEventListener("abort", abort);
            });
            const process = activeVm.vm.exec([activeVm.shellPath, "-lc", command], {
              cwd: resolveAgentWorkspacePath(options.cwd),
              env: { [OPENORB_GUEST_MARKER]: "1" },
              signal: controller.signal,
              stdout: "pipe",
              stderr: "pipe",
            });
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
          yield* discard(activeVm);
          if (options.signal?.aborted) return yield* aborted(options.signal.reason);
          if (timedOut && options.timeoutSeconds) {
            return yield* new AgentEnvironmentError(
              `Command timed out after ${options.timeoutSeconds} seconds.`,
              execution.cause,
            );
          }
          return yield* Effect.failCause(execution.cause);
        }
        return { exitCode: execution.value.exitCode };
      },
    );

    const readFile: AgentEnvironment["readFile"] = Effect.fn("AgentEnvironment.readFile")(
      function* (path) {
        const activeVm = yield* getVm;
        return yield* Effect.tryPromise({
          try: () => activeVm.vm.fs.readFile(resolveAgentWorkspacePath(path)),
          catch: (cause) => new AgentEnvironmentError("Guest file could not be read.", cause),
        });
      },
    );
    const access: AgentEnvironment["access"] = Effect.fn("AgentEnvironment.access")(
      function* (path) {
        const activeVm = yield* getVm;
        yield* Effect.tryPromise({
          try: () => activeVm.vm.fs.access(resolveAgentWorkspacePath(path)),
          catch: (cause) => new AgentEnvironmentError("Guest file could not be accessed.", cause),
        });
      },
    );
    const writeFile: AgentEnvironment["writeFile"] = Effect.fn("AgentEnvironment.writeFile")(
      function* (path, content) {
        const activeVm = yield* getVm;
        yield* Effect.tryPromise({
          try: () =>
            activeVm.vm.fs.writeFile(resolveAgentWorkspacePath(path), content, {
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
        try: () => activeVm.vm.fs.mkdir(resolveAgentWorkspacePath(path), { recursive: true }),
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
      discard,
      run,
      runShell,
      readFile,
      access,
      writeFile,
      makeDirectory,
      detectImageMimeType,
    };
  });
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
