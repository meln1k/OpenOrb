import { mkdir, realpath } from "node:fs/promises";

const workingDirectory = new URL("../.openorb-runner-dev/", import.meta.url);
await mkdir(workingDirectory, { recursive: true });
const canonicalWorkingDirectory = await realpath(workingDirectory);
const temporaryDirectory = `${canonicalWorkingDirectory}/tmp`;
const cacheDirectory = `${canonicalWorkingDirectory}/cache`;
await Promise.all([
  mkdir(temporaryDirectory, { recursive: true }),
  mkdir(cacheDirectory, { recursive: true }),
]);
process.chdir(canonicalWorkingDirectory);
process.env.PWD = canonicalWorkingDirectory;
process.env.TMPDIR = temporaryDirectory;
process.env.XDG_CACHE_HOME = cacheDirectory;
const { runMain } = await import("@openorb/runner");
runMain(process.argv.slice(2));
