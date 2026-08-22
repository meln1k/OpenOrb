const workingDirectory = new URL("../.openorb-runner-dev/", import.meta.url);
await Deno.mkdir(workingDirectory, { recursive: true });
const canonicalWorkingDirectory = await Deno.realPath(workingDirectory);
const temporaryDirectory = `${canonicalWorkingDirectory}/tmp`;
const cacheDirectory = `${canonicalWorkingDirectory}/cache`;
await Promise.all([
  Deno.mkdir(temporaryDirectory, { recursive: true }),
  Deno.mkdir(cacheDirectory, { recursive: true }),
]);
Deno.chdir(canonicalWorkingDirectory);
Deno.env.set("PWD", canonicalWorkingDirectory);
Deno.env.set("TMPDIR", temporaryDirectory);
Deno.env.set("XDG_CACHE_HOME", cacheDirectory);
const { main } = await import("@openorb/runner");
Deno.exitCode = await main(Deno.args);
