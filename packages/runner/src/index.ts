import { checkRunnerPrerequisites } from "./prerequisites.ts";

let report = await checkRunnerPrerequisites();

console.log("[openorb-runner] checking development harness prerequisites");
for (let warning of report.warnings) {
  console.warn(`[openorb-runner] warning: ${warning}`);
}

if (!report.ok) {
  for (let error of report.errors) {
    console.error(`[openorb-runner] error: ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify({
      component: "openorb-runner",
      status: "ready",
      mode: "development-harness",
      platform: report.platform,
      architecture: report.architecture,
      nodeVersion: report.nodeVersion,
      qemu: report.qemu,
    }),
  );
  console.log("[openorb-runner] enrollment and sessions are not implemented in OO-001");
  await waitForShutdown();
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    let keepAlive = setInterval(() => {}, 60_000);
    let shutdown = (signal: NodeJS.Signals) => {
      console.log(`[openorb-runner] received ${signal}; stopping development harness`);
      clearInterval(keepAlive);
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      resolve();
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
