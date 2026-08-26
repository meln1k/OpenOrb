interface StandaloneRunner {
  runMain(args?: string[]): void;
}

type ImportRunner = () => Promise<StandaloneRunner>;

export async function importStandaloneRunner(
  importRunner: ImportRunner = () => import("./index.ts"),
): Promise<StandaloneRunner> {
  const process = (await import("node:process")).default;
  const originalEnvironment = process.env;
  const importEnvironment: typeof originalEnvironment = Object.create(null);
  for (const name of ["PATH", "PWD"] as const) {
    const value = originalEnvironment[name];
    if (value !== undefined) importEnvironment[name] = value;
  }

  using restoreEnvironment = new DisposableStack();
  restoreEnvironment.defer(() => {
    process.env = originalEnvironment;
  });
  process.env = importEnvironment;
  return await importRunner();
}

if (import.meta.main) {
  const runner = await importStandaloneRunner();
  runner.runMain();
}
