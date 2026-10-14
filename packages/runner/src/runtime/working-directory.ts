import { realpath } from "node:fs/promises";

export interface RunnerWorkingDirectoryOptions {
  cwd?: string;
  logicalCwd?: string;
  realPath?: (path: string) => Promise<string>;
}

export class RunnerWorkingDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerWorkingDirectoryError";
  }
}

export async function validateRunnerWorkingDirectory(
  options: RunnerWorkingDirectoryOptions = {},
): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const realPath = options.realPath ?? realpath;
  const canonical = await realPath(cwd);
  const logicalCwd = options.logicalCwd ?? process.env.PWD;

  if (logicalCwd !== undefined) {
    const canonicalLogicalCwd = await realPath(logicalCwd);
    if (canonicalLogicalCwd !== logicalCwd) {
      throw new RunnerWorkingDirectoryError(
        `Runner working directory must not be a symlink; received ${logicalCwd}. Start the runner from its canonical working directory.`,
      );
    }
    if (canonicalLogicalCwd !== canonical) {
      throw new RunnerWorkingDirectoryError(
        `PWD does not match the runner working directory; received ${logicalCwd}, expected ${canonical}.`,
      );
    }
  }
  if (canonical !== cwd) {
    throw new RunnerWorkingDirectoryError(
      `Runner working directory must be canonical; received ${cwd}, resolved to ${canonical}.`,
    );
  }

  return canonical;
}
