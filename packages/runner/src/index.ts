import { validateRunnerWorkingDirectory } from "@/src/working-directory.ts";
import { checkRunnerPrerequisites } from "@/src/prerequisites.ts";
import { maintainRunnerConnection, type RunnerConnectionError } from "@/src/connection.ts";
import { enrollRunner } from "@/src/enrollment.ts";
import { readRunnerIdentity, writeRunnerIdentity } from "@/src/identity.ts";
import { parseRunnerCommand } from "@/src/options.ts";
import { createRunnerCapacityReporter } from "@/src/capacity.ts";
import { ensureDeveloperImage } from "@/src/developer-image.ts";
import { SessionEventRelay } from "@/src/session-event-relay.ts";
import { SessionProvisioner, type SessionProvisioningError } from "@/src/session-provisioner.ts";
import { RunnerSessionStore } from "@/src/session-store.ts";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { err, ok, type Result, tryAsync, trySync } from "@openorb/result";

export const RUNNER_VERSION = "0.0.0";
const tracer = trace.getTracer("openorb-runner", RUNNER_VERSION);

export async function main(args: string[] = Deno.args): Promise<number> {
  const [command, commandError] = trySync(parseRunnerCommand.bind(undefined, args), toError);
  if (commandError !== undefined) {
    console.error(`[openorb-runner] error: ${commandError.message}`);
    console.error(
      "Usage: openorb-runner [doctor|--version] [--control-panel URL --enrollment-token PSK] [--name NAME] [--max-concurrent-sessions COUNT] [--vm-cpu-count COUNT] [--vm-memory-mib MIB]",
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
        if (!command.options.controlPanel || !command.options.enrollmentToken) {
          console.error(
            "[openorb-runner] error: first start requires --control-panel and --enrollment-token.",
          );
          return ok(2);
        }
        const [enrolled, enrollmentError] = await enrollRunner({
          controlPanelUrl: command.options.controlPanel,
          enrollmentPsk: command.options.enrollmentToken,
          name: command.options.name,
          architecture: normalizeArchitecture(Deno.build.arch),
          capabilities: ["heartbeat", "session-provisioning"],
        });
        if (enrollmentError !== undefined) {
          return err(new RunnerRuntimeError("Runner enrollment failed.", enrollmentError));
        }
        identity = {
          runnerId: enrolled.runnerId,
          runnerToken: enrolled.runnerToken,
          controlPanelUrl: command.options.controlPanel,
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
        command.options.controlPanel && command.options.controlPanel !== identity.controlPanelUrl
      ) {
        console.error(
          "[openorb-runner] error: --control-panel does not match the enrolled runner.",
        );
        return ok(2);
      }

      const shutdownController = new AbortController();
      const removeSignalListeners = installShutdownListeners(shutdownController);
      using signalCleanup = new DisposableStack();
      signalCleanup.defer(removeSignalListeners);
      const sessionStore = new RunnerSessionStore({
        workingDirectory,
        runnerId: identity.runnerId,
      });
      const [, initializationError] = await sessionStore.initialize();
      if (initializationError !== undefined) {
        return err(
          new RunnerRuntimeError(
            "The runner session store could not be initialized.",
            initializationError,
          ),
        );
      }
      const sessionEventRelay = new SessionEventRelay(sessionStore);
      let getActiveSessionCount = () => 0;
      const getCapacity = createRunnerCapacityReporter({
        path: workingDirectory,
        maxConcurrentSessions: command.options.maxConcurrentSessions,
        vmCpuCount: command.options.vmCpuCount,
        vmMemoryMiB: command.options.vmMemoryMiB,
        getActiveSessions: () => getActiveSessionCount(),
      });
      const initialCapacity = await getCapacity();
      const sessionProvisioner = new SessionProvisioner({
        sessionStore,
        eventRelay: sessionEventRelay,
        developerImage,
        cpuCount: initialCapacity.vmCpuCount,
        memoryMiB: initialCapacity.vmMemoryMiB,
      });
      getActiveSessionCount = () => sessionProvisioner.activeSessionCount;
      let connectionError: RunnerConnectionError | undefined;
      let provisionerCloseError: SessionProvisioningError | undefined;
      {
        await using provisionerCleanup = new AsyncDisposableStack();
        provisionerCleanup.defer(async () => {
          [, provisionerCloseError] = await sessionProvisioner.close();
        });
        [, connectionError] = await maintainRunnerConnection({
          controlPanelUrl: identity.controlPanelUrl,
          runnerId: identity.runnerId,
          runnerToken: identity.runnerToken,
          signal: shutdownController.signal,
          getCapacity,
          async getSessionSnapshot() {
            const [inventory, inventoryError] = await sessionStore.loadInventory();
            if (inventoryError !== undefined) {
              return err(
                new RunnerRuntimeError(
                  "The durable runner session inventory could not be loaded.",
                  inventoryError,
                ),
              );
            }
            for (const error of inventory.errors) {
              console.error(
                `[openorb-runner] session ${error.sessionDirectory}: ${error.message}`,
              );
            }
            return ok(inventory.sessions);
          },
          sessionEventRelay,
          onProvisionCommand(command, send) {
            return sessionProvisioner.handleCommand(command, send);
          },
          onConnected() {
            console.log(`[openorb-runner] connected runner ${identity.runnerId}`);
          },
          onReconnectScheduled(delay) {
            console.warn(`[openorb-runner] disconnected; reconnecting in ${delay}ms`);
          },
        });
      }
      if (connectionError !== undefined) {
        return err(new RunnerRuntimeError("The runner connection failed.", connectionError));
      }
      if (provisionerCloseError !== undefined) {
        return err(
          new RunnerRuntimeError(
            "The session provisioner could not be closed.",
            provisionerCloseError,
          ),
        );
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

if (import.meta.main) {
  Deno.exitCode = await main();
}
