import { validateRunnerWorkingDirectory } from "./working-directory.ts";
import { checkRunnerPrerequisites } from "./prerequisites.ts";

export const RUNNER_VERSION = "0.0.0";

export async function main(args: string[] = Deno.args): Promise<number> {
  if (args.some((argument) => argument === "--data-dir" || argument.startsWith("--data-dir="))) {
    console.error(
      "[openorb-runner] error: --data-dir is not supported. Start the runner from its canonical working directory.",
    );
    return 2;
  }

  if (args.length === 1 && (args[0] === "--version" || args[0] === "version")) {
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

  if (args.length > 1 || (args.length === 1 && args[0] !== "doctor")) {
    console.error("Usage: openorb-runner [doctor|--version]");
    return 2;
  }

  let workingDirectory: string;
  try {
    workingDirectory = await validateRunnerWorkingDirectory();
  } catch (error) {
    console.error(`[openorb-runner] error: ${error instanceof Error ? error.message : error}`);
    return 1;
  }

  const report = await checkRunnerPrerequisites();

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
    }),
  );

  if (args[0] === "doctor") return 0;

  console.log("[openorb-runner] enrollment and sessions are not implemented in OO-001A");
  await waitForShutdown();
  return 0;
}

function normalizeArchitecture(value: string): string {
  if (value === "aarch64") return "arm64";
  if (value === "x86_64") return "x64";
  return value;
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const shutdown = (signal: Deno.Signal) => {
      console.log(`[openorb-runner] received ${signal}; stopping development harness`);
      Deno.removeSignalListener("SIGINT", onSigint);
      Deno.removeSignalListener("SIGTERM", onSigterm);
      resolve();
    };
    const onSigint = () => shutdown("SIGINT");
    const onSigterm = () => shutdown("SIGTERM");

    Deno.addSignalListener("SIGINT", onSigint);
    Deno.addSignalListener("SIGTERM", onSigterm);
  });
}

if (import.meta.main) {
  Deno.exitCode = await main();
}
