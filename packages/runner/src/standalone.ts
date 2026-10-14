interface StandaloneRunner {
  runMain(args?: string[]): void;
}

type ImportRunner = () => Promise<StandaloneRunner>;

function approvedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const approved: NodeJS.ProcessEnv = Object.create(null);
  for (const name of ["PATH", "PWD"] as const) {
    const value = environment[name];
    if (value !== undefined) approved[name] = value;
  }
  return approved;
}

export async function importStandaloneRunner(
  importRunner: ImportRunner = () => import("./index.ts"),
): Promise<StandaloneRunner> {
  const process = (await import("node:process")).default;
  const originalEnvironment = process.env;
  const importEnvironment = approvedEnvironment(originalEnvironment);

  using restoreEnvironment = new DisposableStack();
  restoreEnvironment.defer(() => {
    process.env = originalEnvironment;
  });
  process.env = importEnvironment;
  return await importRunner();
}

if (import.meta.main) {
  // Node has no Deno environment permission allowlist. Keep the deployment
  // environment scrubbed for the complete lifetime, including QEMU children.
  const process = (await import("node:process")).default;
  process.env = approvedEnvironment(process.env);
  const runner = await importStandaloneRunner();
  runner.runMain();
}
