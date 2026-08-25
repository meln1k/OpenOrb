import { runRunnerRpc } from "./connection/rpc.ts";
import { ensureDeveloperImage } from "./environment/gondolin/developer-image/installer.ts";
import { gondolinAgentEnvironmentProviderLayer } from "./environment/gondolin/layer.ts";
import { piAgentHarnessLayer } from "./harness/pi/layer.ts";
import { createRunnerCapacityReporter } from "./runtime/capacity.ts";
import { enrollRunner } from "./runtime/enrollment.ts";
import { readRunnerIdentity, writeRunnerIdentity } from "./runtime/identity.ts";
import { parseRunnerCommand } from "./runtime/options.ts";
import { checkRunnerPrerequisites } from "./runtime/prerequisites.ts";
import { validateRunnerWorkingDirectory } from "./runtime/working-directory.ts";
import { SessionEvents, sessionEventsLayer } from "./session/events.ts";
import { RunnerSessionStore, runnerSessionStoreLayer } from "./session/store.ts";
import { SessionSupervisor, sessionSupervisorLayer } from "./session/supervisor.ts";
import { sessionWorkerFactoryLayer } from "./session/worker.ts";
import * as DenoFileSystem from "@effect/platform-deno/DenoFileSystem";
import * as DenoRuntime from "@effect/platform-deno/DenoRuntime";
import { Effect, Exit, Layer, Predicate, Runtime, Schema } from "effect";
import { RUNNER_PROTOCOL_VERSION, RunnerId } from "@openorb/protocol/runner-api";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { err, ok, type Result, tryAsync, trySync } from "@openorb/result";

export const RUNNER_VERSION = "0.0.0";
const tracer = trace.getTracer("openorb-runner", RUNNER_VERSION);

export async function main(
  args: string[] = Deno.args,
  processSignal?: AbortSignal,
): Promise<number> {
  const [command, commandError] = trySync(parseRunnerCommand.bind(undefined, args), toError);
  if (commandError !== undefined) {
    console.error(`[openorb-runner] error: ${commandError.message}`);
    console.error(
      "Usage: openorb-runner [doctor|--version] [--gateway URL --enrollment-token PSK] [--name NAME] [--max-concurrent-sessions COUNT] [--vm-cpu-count COUNT] [--vm-memory-mib MIB]",
    );
    return 2;
  }

  if (command.type === "version") {
    console.log(
      JSON.stringify({
        component: "openorb-runner",
        version: RUNNER_VERSION,
        denoVersion: Deno.version.deno,
        target: Deno.build.target,
        architecture: normalizeArchitecture(Deno.build.arch),
        standalone: Deno.build.standalone,
      }),
    );
    return 0;
  }

  const [workingDirectory, workingDirectoryError] = await tryAsync(
    validateRunnerWorkingDirectory(),
    toError,
  );
  if (workingDirectoryError !== undefined) {
    console.error(`[openorb-runner] error: ${workingDirectoryError.message}`);
    return 1;
  }

  const [report, prerequisiteError] = await tracer.startActiveSpan(
    "runner.check_prerequisites",
    async (span) => {
      const [report, prerequisiteError] = await tryAsync(
        checkRunnerPrerequisites(),
        (cause) => new RunnerRuntimeError("Runner prerequisites could not be checked.", cause),
      );
      if (prerequisiteError !== undefined) {
        span.recordException(prerequisiteError);
        span.setStatus({ code: SpanStatusCode.ERROR, message: prerequisiteError.message });
        span.end();
        return err(prerequisiteError);
      }
      span.setAttributes({
        "runner.prerequisites.ok": report.ok,
        "runner.prerequisites.error_count": report.errors.length,
        "runner.prerequisites.warning_count": report.warnings.length,
      });
      if (!report.ok) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: "One or more runner prerequisites failed",
        });
      }
      span.end();
      return ok(report);
    },
  );
  if (prerequisiteError !== undefined) {
    console.error(`[openorb-runner] error: ${prerequisiteError.message}`);
    return 1;
  }

  console.log("[openorb-runner] checking development harness prerequisites");
  for (const warning of report.warnings) {
    console.warn(`[openorb-runner] warning: ${warning}`);
  }

  if (!report.ok) {
    for (const error of report.errors) {
      console.error(`[openorb-runner] error: ${error}`);
    }
    return 1;
  }

  console.log("[openorb-runner] checking pinned developer image");
  const [developerImage, imageError] = await ensureDeveloperImage({ workingDirectory });
  if (imageError !== undefined) {
    console.error(`[openorb-runner] error: ${imageError.message}`);
    return 1;
  }

  console.log(
    JSON.stringify({
      component: "openorb-runner",
      status: "ready",
      mode: "development-harness",
      workingDirectory,
      platform: report.platform,
      architecture: report.architecture,
      denoVersion: report.denoVersion,
      runtime: Deno.build.standalone ? "denort" : "deno",
      qemu: report.qemu,
      developerImage: {
        releaseId: developerImage.releaseId,
        gondolinBuildId: developerImage.gondolinBuildId,
        path: developerImage.path,
      },
    }),
  );

  if (command.type === "doctor") return 0;

  const [runtimeResult, unexpectedRuntimeError] = await tryAsync(
    (async (): Promise<Result<number, RunnerRuntimeError>> => {
      const [storedIdentity, identityReadError] = await readRunnerIdentity(workingDirectory);
      if (identityReadError !== undefined) {
        return err(
          new RunnerRuntimeError("Runner identity could not be loaded.", identityReadError),
        );
      }
      let identity = storedIdentity;
      if (!identity) {
        if (!command.options.gateway || !command.options.enrollmentToken) {
          console.error(
            "[openorb-runner] error: first start requires --gateway and --enrollment-token.",
          );
          return ok(2);
        }
        const [enrolled, enrollmentError] = await enrollRunner({
          gatewayUrl: command.options.gateway,
          enrollmentPsk: command.options.enrollmentToken,
          name: command.options.name,
          architecture: normalizeArchitecture(Deno.build.arch),
          capabilities: ["session-rpc", "session-events"],
        });
        if (enrollmentError !== undefined) {
          return err(new RunnerRuntimeError("Runner enrollment failed.", enrollmentError));
        }
        identity = {
          runnerId: enrolled.runnerId,
          runnerToken: enrolled.runnerToken,
          gatewayUrl: command.options.gateway,
        };
        const [, identityWriteError] = await writeRunnerIdentity(workingDirectory, identity);
        if (identityWriteError !== undefined) {
          return err(
            new RunnerRuntimeError(
              "The enrolled runner identity could not be saved.",
              identityWriteError,
            ),
          );
        }
        console.log(`[openorb-runner] enrolled runner ${identity.runnerId}`);
      } else if (
        command.options.gateway && command.options.gateway !== identity.gatewayUrl
      ) {
        console.error(
          "[openorb-runner] error: --gateway does not match the enrolled runner.",
        );
        return ok(2);
      }

      const shutdownController = new AbortController();
      const removeSignalListeners = processSignal
        ? linkShutdownSignal(processSignal, shutdownController)
        : installShutdownListeners(shutdownController);
      using signalCleanup = new DisposableStack();
      signalCleanup.defer(removeSignalListeners);
      let getActiveSessionCount = () => 0;
      const getCapacity = createRunnerCapacityReporter({
        path: workingDirectory,
        maxConcurrentSessions: command.options.maxConcurrentSessions ?? 1,
        vmCpuCount: command.options.vmCpuCount,
        vmMemoryMiB: command.options.vmMemoryMiB,
        getActiveSessions: () => getActiveSessionCount(),
      });
      const initialCapacity = await getCapacity();
      const runnerId = Schema.decodeUnknownSync(RunnerId)(identity.runnerId);
      const sessionStoreLive = runnerSessionStoreLayer({
        workingDirectory,
        runnerId: identity.runnerId,
      }).pipe(Layer.provide(DenoFileSystem.layer));
      const sessionEventsLive = sessionEventsLayer.pipe(Layer.provide(sessionStoreLive));
      const environmentLive = gondolinAgentEnvironmentProviderLayer(developerImage);
      const harnessLive = piAgentHarnessLayer();
      const sessionWorkerLive = sessionWorkerFactoryLayer.pipe(
        Layer.provide(
          Layer.mergeAll(sessionStoreLive, sessionEventsLive, environmentLive, harnessLive),
        ),
      );
      const sessionSupervisorLive = sessionSupervisorLayer({
        cpuCount: initialCapacity.vmCpuCount,
        memoryMiB: initialCapacity.vmMemoryMiB,
        maxConcurrentSessions: initialCapacity.maxConcurrentSessions ?? 1,
      }).pipe(
        Layer.provide(Layer.merge(sessionStoreLive, sessionWorkerLive)),
      );
      const runnerServicesLive = Layer.mergeAll(
        sessionStoreLive,
        sessionEventsLive,
        sessionSupervisorLive,
      );
      const rpcExit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const sessionStore = yield* RunnerSessionStore;
            const sessionEvents = yield* SessionEvents;
            const sessionSupervisor = yield* SessionSupervisor;
            getActiveSessionCount = sessionSupervisor.activeSessionCount;
            return yield* runRunnerRpc({
              gatewayUrl: identity.gatewayUrl,
              runnerId,
              runnerToken: identity.runnerToken,
              runnerVersion: RUNNER_VERSION,
              protocolVersion: RUNNER_PROTOCOL_VERSION,
              getCapacity,
              store: sessionStore,
              supervisor: sessionSupervisor,
              events: sessionEvents,
            });
          }),
        ).pipe(Effect.provide(runnerServicesLive)),
        { signal: shutdownController.signal },
      );
      if (Exit.isFailure(rpcExit) && !shutdownController.signal.aborted) {
        return err(new RunnerRuntimeError("The runner RPC service failed.", rpcExit.cause));
      }
      return ok(0);
    })(),
    (cause) => new RunnerRuntimeError("The runner failed unexpectedly.", cause),
  );
  if (unexpectedRuntimeError !== undefined) {
    console.error(`[openorb-runner] error: ${unexpectedRuntimeError.message}`);
    return 1;
  }
  const [runtimeExitCode, runtimeError] = runtimeResult;
  if (runtimeError !== undefined) {
    console.error(`[openorb-runner] error: ${runtimeError.message}`);
    return 1;
  }
  return runtimeExitCode;
}

class RunnerRuntimeError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message, { cause });
    this.name = "RunnerRuntimeError";
  }
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function normalizeArchitecture(value: string): "x64" | "arm64" {
  if (value === "aarch64") return "arm64";
  if (value === "x86_64") return "x64";
  if (value === "arm64" || value === "x64") return value;
  throw new RunnerRuntimeError(`Unsupported runner architecture: ${value}`, undefined);
}

function installShutdownListeners(controller: AbortController): () => void {
  const shutdown = (signal: Deno.Signal) => {
    console.log(`[openorb-runner] received ${signal}; stopping development harness`);
    controller.abort();
  };
  const onSigint = () => shutdown("SIGINT");
  const onSigterm = () => shutdown("SIGTERM");
  Deno.addSignalListener("SIGINT", onSigint);
  Deno.addSignalListener("SIGTERM", onSigterm);
  return () => {
    Deno.removeSignalListener("SIGINT", onSigint);
    Deno.removeSignalListener("SIGTERM", onSigterm);
  };
}

function linkShutdownSignal(signal: AbortSignal, controller: AbortController): () => void {
  const shutdown = () => controller.abort(signal.reason);
  if (signal.aborted) {
    shutdown();
    return () => {};
  }
  signal.addEventListener("abort", shutdown, { once: true });
  return () => signal.removeEventListener("abort", shutdown);
}

export function runMain(args: string[] = Deno.args): void {
  const program = Effect.callback<number>((resume, signal) => {
    const result = main(args, signal);
    result.then(
      (exitCode) => resume(Effect.succeed(exitCode)),
      (cause) => resume(Effect.die(cause)),
    );
    return Effect.promise(() => result).pipe(Effect.asVoid);
  });
  DenoRuntime.runMain(program, {
    teardown(exit, onExit) {
      if (Exit.isSuccess(exit)) {
        return onExit(Predicate.isNumber(exit.value) ? exit.value : 0);
      }
      Runtime.defaultTeardown(exit, onExit);
    },
  });
}

if (import.meta.main) {
  runMain();
}
