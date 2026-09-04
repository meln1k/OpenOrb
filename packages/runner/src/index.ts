import { runRunnerRpc } from "./connection/rpc.ts";
import { ensureGuestImage } from "./environment/gondolin/guest-image/installer.ts";
import { gondolinAgentEnvironmentProviderLayer } from "./environment/gondolin/layer.ts";
import { piAgentHarnessLayer } from "./harness/pi/layer.ts";
import { createRunnerCapacityReporter } from "./runtime/capacity.ts";
import { enrollRunner } from "./runtime/enrollment.ts";
import { readRunnerIdentity, writeRunnerIdentity } from "./runtime/identity.ts";
import { parseRunnerCommand } from "./runtime/options.ts";
import {
  checkCheckpointCandidateCapacity,
  checkRunnerPrerequisites,
} from "./runtime/prerequisites.ts";
import { validateRunnerWorkingDirectory } from "./runtime/working-directory.ts";
import { sessionActorFactoryLayer } from "./session/actor/index.ts";
import { sessionEventsLayer } from "./session/events.ts";
import { sessionJournalLayer } from "./session/persistent-actor/session-journal.ts";
import { runnerSessionStoreLayer } from "./session/store.ts";
import { SessionSupervisor, sessionSupervisorLayer } from "./session/supervisor.ts";
import * as DenoFileSystem from "@effect/platform-deno/DenoFileSystem";
import * as DenoPath from "@effect/platform-deno/DenoPath";
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
      "Usage: openorb-runner [doctor [--gateway URL]|--version] [--gateway URL --enrollment-token PSK] [--name NAME] [--vm-cpu-count COUNT] [--vm-memory-mib MIB]",
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

  const [storedIdentity, identityReadError] = await readRunnerIdentity(workingDirectory);
  if (identityReadError !== undefined) {
    console.error(`[openorb-runner] error: Runner identity could not be loaded.`);
    return 1;
  }
  const gatewayUrl = command.options.gateway ?? storedIdentity?.gatewayUrl;
  if (command.type === "doctor" && !gatewayUrl) {
    console.error(
      "[openorb-runner] error: doctor requires --gateway URL before this runner is enrolled.",
    );
    return 2;
  }
  if (command.type === "start") {
    if (!storedIdentity && (!gatewayUrl || !command.options.enrollmentToken)) {
      console.error(
        "[openorb-runner] error: first start requires --gateway and --enrollment-token.",
      );
      return 2;
    }
    if (storedIdentity && gatewayUrl !== storedIdentity.gatewayUrl) {
      console.error(
        "[openorb-runner] error: --gateway does not match the enrolled runner.",
      );
      return 2;
    }
  }

  const [report, prerequisiteError] = await tracer.startActiveSpan(
    "runner.check_prerequisites",
    async (span) => {
      const [report, prerequisiteError] = await tryAsync(
        checkRunnerPrerequisites({
          workingDirectory,
          ...(gatewayUrl === undefined ? {} : { gatewayUrl }),
        }),
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

  console.log("[openorb-runner] checking runner host prerequisites");
  for (const warning of report.warnings) {
    console.warn(`[openorb-runner] warning: ${warning}`);
  }

  if (!report.ok) {
    for (const error of report.errors) {
      console.error(`[openorb-runner] error: ${error}`);
    }
    return 1;
  }

  console.log("[openorb-runner] checking pinned guest image");
  const [guestImage, imageError] = await ensureGuestImage({ workingDirectory });
  if (imageError !== undefined) {
    console.error(`[openorb-runner] error: ${imageError.message}`);
    return 1;
  }

  const [checkpointCapacity, checkpointCapacityError] = await tryAsync(
    checkCheckpointCandidateCapacity({
      workingDirectory,
      rootfsPath: `${guestImage.path}/rootfs.ext4`,
    }),
    (cause) => new RunnerRuntimeError("Checkpoint capacity could not be checked.", cause),
  );
  if (checkpointCapacityError !== undefined) {
    console.error(`[openorb-runner] error: ${checkpointCapacityError.message}`);
    return 1;
  }
  if (!checkpointCapacity.ok) {
    for (const error of checkpointCapacity.errors) {
      console.error(`[openorb-runner] error: ${error}`);
    }
    return 1;
  }

  console.log(
    JSON.stringify({
      component: "openorb-runner",
      status: "ready",
      mode: report.platform === "linux" ? "linux-service" : "development-harness",
      workingDirectory,
      platform: report.platform,
      architecture: report.architecture,
      kernelRelease: report.kernelRelease,
      libc: report.libc,
      glibcVersion: report.glibcVersion,
      denoVersion: report.denoVersion,
      runtime: Deno.build.standalone ? "denort" : "deno",
      qemu: report.qemu,
      qemuImg: report.qemuImg,
      kvm: report.kvm,
      resources: report.resources,
      dataDirectory: report.dataDirectory,
      gateway: report.gateway,
      guestImage: {
        releaseId: guestImage.releaseId,
        gondolinBuildId: guestImage.gondolinBuildId,
        path: guestImage.path,
      },
      checkpointCapacity,
    }),
  );

  if (command.type === "doctor") return 0;

  const [runtimeResult, unexpectedRuntimeError] = await tryAsync(
    (async (): Promise<Result<number, RunnerRuntimeError>> => {
      let identity = storedIdentity;
      if (!identity) {
        const [enrolled, enrollmentError] = await enrollRunner({
          gatewayUrl: gatewayUrl!,
          enrollmentPsk: command.options.enrollmentToken!,
          name: command.options.name,
          architecture: normalizeArchitecture(Deno.build.arch),
        });
        if (enrollmentError !== undefined) {
          return err(new RunnerRuntimeError("Runner enrollment failed.", enrollmentError));
        }
        identity = {
          runnerId: enrolled.runnerId,
          runnerToken: enrolled.runnerToken,
          gatewayUrl: gatewayUrl!,
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
        vmCpuCount: command.options.vmCpuCount,
        vmMemoryMiB: command.options.vmMemoryMiB,
        getActiveSessions: () => getActiveSessionCount(),
      });
      const initialCapacity = await getCapacity();
      const runnerId = Schema.decodeUnknownSync(RunnerId)(identity.runnerId);
      const platformLive = Layer.merge(DenoFileSystem.layer, DenoPath.layer);
      const sessionJournalLive = sessionJournalLayer(workingDirectory).pipe(
        Layer.provideMerge(platformLive),
      );
      const sessionStoreLive = runnerSessionStoreLayer({
        workingDirectory,
        runnerId: identity.runnerId,
      }).pipe(Layer.provideMerge(sessionJournalLive));
      const sessionEventsLive = sessionEventsLayer.pipe(Layer.provideMerge(sessionStoreLive));
      const environmentLive = gondolinAgentEnvironmentProviderLayer(guestImage);
      const harnessLive = piAgentHarnessLayer().pipe(Layer.provideMerge(sessionEventsLive));
      const sessionActorLive = sessionActorFactoryLayer().pipe(
        Layer.provideMerge(Layer.merge(harnessLive, environmentLive)),
      );
      const runnerServicesLive = sessionSupervisorLayer({
        runnerId,
        cpuCount: initialCapacity.vmCpuCount,
        memoryMiB: initialCapacity.vmMemoryMiB,
      }).pipe(Layer.provideMerge(sessionActorLive));
      const rpcExit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const sessionSupervisor = yield* SessionSupervisor;
            getActiveSessionCount = sessionSupervisor.activeSessionCount;
            return yield* runRunnerRpc({
              gatewayUrl: identity.gatewayUrl,
              runnerId,
              runnerToken: identity.runnerToken,
              runnerVersion: RUNNER_VERSION,
              protocolVersion: RUNNER_PROTOCOL_VERSION,
              getCapacity,
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
    console.log(`[openorb-runner] received ${signal}; stopping runner`);
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
