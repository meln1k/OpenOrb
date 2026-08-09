const workingDirectory = new URL("../.openorb-runner-dev/", import.meta.url);
await Deno.mkdir(workingDirectory, { recursive: true });
const canonicalWorkingDirectory = await Deno.realPath(workingDirectory);
Deno.chdir(canonicalWorkingDirectory);
Deno.env.set("PWD", canonicalWorkingDirectory);
const { main } = await import("../packages/runner/src/index.ts");
Deno.exitCode = await main(Deno.args);
