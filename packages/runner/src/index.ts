import { validateRunnerWorkingDirectory } from "@/src/working-directory.ts";
import { checkRunnerPrerequisites } from "@/src/prerequisites.ts";
import { maintainRunnerConnection } from "@/src/connection.ts";
import { enrollRunner } from "@/src/enrollment.ts";
import { readRunnerIdentity, writeRunnerIdentity } from "@/src/identity.ts";
import { parseRunnerCommand } from "@/src/options.ts";
import { createRunnerCapacityReporter } from "@/src/capacity.ts";
import { ensureDeveloperImage } from "@/src/developer-image.ts";
import { SessionEventRelay } from "@/src/session-event-relay.ts";
import { SessionProvisioner } from "@/src/session-provisioner.ts";
import { RunnerSessionStore } from "@/src/session-store.ts";
import { SpanStatusCode, trace } from "@opentelemetry/api";

export const RUNNER_VERSION = "0.0.0";
const tracer = trace.getTracer("openorb-runner", RUNNER_VERSION);

export async function main(args: string[] = Deno.args): Promise<number> {
  let command;
  try {
    command = parseRunnerCommand(args);
  } catch (error) {
    console.error(`[openorb-runner] error: ${error instanceof Error ? error.message : error}`);
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

  let workingDirectory: string;
  try {
    workingDirectory = await validateRunnerWorkingDirectory();
  } catch (error) {
    console.error(`[openorb-runner] error: ${error instanceof Error ? error.message : error}`);
    return 1;
  }

  const report = await tracer.startActiveSpan("runner.check_prerequisites", async (span) => {
    try {
      const report = await checkRunnerPrerequisites();
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
      return report;
    } catch (error) {
      const exception = error instanceof Error ? error : new Error(String(error));
      span.recordException(exception);
      span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
      throw error;
    } finally {
      span.end();
    }
  });

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
  let developerImage;
  try {
    developerImage = await ensureDeveloperImage({ workingDirectory });
  } catch (error) {
    console.error(`[openorb-runner] error: ${error instanceof Error ? error.message : error}`);
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

  try {
    let identity = await readRunnerIdentity(workingDirectory);
    if (!identity) {
      if (!command.options.controlPanel || !command.options.enrollmentToken) {
        console.error(
          "[openorb-runner] error: first start requires --control-panel and --enrollment-token.",
        );
        return 2;
      }
      const enrolled = await enrollRunner({
        controlPanelUrl: command.options.controlPanel,
        enrollmentPsk: command.options.enrollmentToken,
        name: command.options.name,
        architecture: normalizeArchitecture(Deno.build.arch),
        capabilities: ["heartbeat", "session-provisioning"],
      });
      identity = {
        runnerId: enrolled.runnerId,
        runnerToken: enrolled.runnerToken,
        controlPanelUrl: command.options.controlPanel,
      };
      await writeRunnerIdentity(workingDirectory, identity);
      console.log(`[openorb-runner] enrolled runner ${identity.runnerId}`);
    } else if (
      command.options.controlPanel && command.options.controlPanel !== identity.controlPanelUrl
    ) {
      console.error("[openorb-runner] error: --control-panel does not match the enrolled runner.");
      return 2;
    }

    const shutdownController = new AbortController();
    const removeSignalListeners = installShutdownListeners(shutdownController);
    try {
      const sessionStore = new RunnerSessionStore({
        workingDirectory,
        runnerId: identity.runnerId,
      });
      await sessionStore.initialize();
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
      try {
        await maintainRunnerConnection({
          controlPanelUrl: identity.controlPanelUrl,
          runnerId: identity.runnerId,
          runnerToken: identity.runnerToken,
          signal: shutdownController.signal,
          getCapacity,
          async getSessionSnapshot() {
            const inventory = await sessionStore.loadInventory();
            for (const error of inventory.errors) {
              console.error(
                `[openorb-runner] session ${error.sessionDirectory}: ${error.message}`,
              );
            }
            return inventory.sessions;
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
      } finally {
        await sessionProvisioner.close();
      }
    } finally {
      removeSignalListeners();
    }
    return 0;
  } catch (error) {
    console.error(`[openorb-runner] error: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}

function normalizeArchitecture(value: string): "x64" | "arm64" {
  if (value === "aarch64") return "arm64";
  if (value === "x86_64") return "x64";
  if (value === "arm64" || value === "x64") return value;
  throw new Error(`Unsupported runner architecture: ${value}`);
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
