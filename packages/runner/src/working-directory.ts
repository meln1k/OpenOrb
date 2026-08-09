export interface RunnerWorkingDirectoryOptions {
  cwd?: string;
  logicalCwd?: string;
  realPath?: (path: string) => Promise<string>;
}

export async function validateRunnerWorkingDirectory(
  options: RunnerWorkingDirectoryOptions = {},
): Promise<string> {
  const cwd = options.cwd ?? Deno.cwd();
  const realPath = options.realPath ?? Deno.realPath;
  const canonical = await realPath(cwd);
  const logicalCwd = options.logicalCwd ?? Deno.env.get("PWD");

  if (logicalCwd !== undefined) {
    const canonicalLogicalCwd = await realPath(logicalCwd);
    if (canonicalLogicalCwd !== logicalCwd) {
      throw new Error(
        `Runner working directory must not be a symlink; received ${logicalCwd}. Start the runner from its canonical working directory.`,
      );
    }
    if (canonicalLogicalCwd !== canonical) {
      throw new Error(
        `PWD does not match the runner working directory; received ${logicalCwd}, expected ${canonical}.`,
      );
    }
  }
  if (canonical !== cwd) {
    throw new Error(
      `Runner working directory must be canonical; received ${cwd}, resolved to ${canonical}.`,
    );
  }

  return canonical;
}
